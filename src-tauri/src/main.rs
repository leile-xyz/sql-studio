// SQL Studio 桌面版宿主 — 对应扩展 background.js 的职责：
// 代发 Archery 请求（每环境独立 Cookie Jar）、登录/CSRF、本地 KV 存储、
// Windows 凭据管理器（DPAPI）存取密码、CSV 原生另存为。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod archery;
mod background;
mod lifecycle;
mod mcp;
mod mcp_tools;
mod notifications;
mod plugins;
mod scheduler;
mod storage;
mod workflows;

use std::{
    fs::{self, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
};

use serde_json::{json, Value};
use tauri::{Manager, State, WindowEvent};
use tauri_plugin_dialog::DialogExt;
use tokio::sync::Mutex;

const KEYRING_SERVICE: &str = "sql-studio";

#[cfg(windows)]
const MOVE_FILE_REPLACE_EXISTING: u32 = 0x1;
#[cfg(windows)]
const MOVE_FILE_WRITE_THROUGH: u32 = 0x8;

/* ============ 本地 KV 存储（环境列表 / 查询历史等非敏感数据） ============ */

pub(crate) struct Kv {
    pub(crate) path: PathBuf,
    pub(crate) data: Mutex<Value>,
}

pub(crate) fn load_store(path: &Path) -> Result<Value, String> {
    let content = match fs::read_to_string(path) {
        Ok(content) => content,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(json!({})),
        Err(error) => return Err(format!("读取配置文件 {} 失败：{error}", path.display())),
    };
    let data: Value = serde_json::from_str(&content)
        .map_err(|error| format!("解析配置文件 {} 失败：{error}", path.display()))?;
    if !data.is_object() {
        return Err(format!(
            "配置文件 {} 的根节点必须是 JSON 对象",
            path.display()
        ));
    }
    Ok(data)
}

pub(crate) fn updated_store(current: &Value, key: String, value: Value) -> Result<Value, String> {
    let mut next = current.clone();
    let object = next
        .as_object_mut()
        .ok_or_else(|| "配置数据的根节点必须是 JSON 对象".to_string())?;
    object.insert(key, value);
    Ok(next)
}

pub(crate) fn persist_store(path: &Path, data: &Value) -> Result<(), String> {
    let content = serde_json::to_vec_pretty(data).map_err(|error| error.to_string())?;
    let parent = path
        .parent()
        .ok_or_else(|| format!("配置文件路径 {} 缺少父目录", path.display()))?;
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| format!("配置文件路径 {} 缺少有效文件名", path.display()))?;
    let temp_path = parent.join(format!(".{file_name}.{}.tmp", uuid::Uuid::new_v4()));

    let write_result = write_and_replace(&temp_path, path, &content);
    if let Err(error) = write_result {
        return match fs::remove_file(&temp_path) {
            Ok(()) => Err(format!("写入配置文件 {} 失败：{error}", path.display())),
            Err(cleanup_error) if cleanup_error.kind() == io::ErrorKind::NotFound => {
                Err(format!("写入配置文件 {} 失败：{error}", path.display()))
            }
            Err(cleanup_error) => Err(format!(
                "写入配置文件 {} 失败：{error}；清理临时文件 {} 失败：{cleanup_error}",
                path.display(),
                temp_path.display()
            )),
        };
    }
    Ok(())
}

fn write_and_replace(temp_path: &Path, path: &Path, content: &[u8]) -> io::Result<()> {
    let mut temp_file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(temp_path)?;
    temp_file.write_all(content)?;
    temp_file.flush()?;
    temp_file.sync_all()?;
    drop(temp_file);
    replace_file(temp_path, path)
}

#[cfg(not(windows))]
fn replace_file(source: &Path, destination: &Path) -> io::Result<()> {
    fs::rename(source, destination)
}

#[cfg(windows)]
fn replace_file(source: &Path, destination: &Path) -> io::Result<()> {
    use std::{ffi::OsStr, os::windows::ffi::OsStrExt};

    #[link(name = "kernel32")]
    extern "system" {
        fn MoveFileExW(
            existing_file_name: *const u16,
            new_file_name: *const u16,
            flags: u32,
        ) -> i32;
    }

    fn wide_null(value: &OsStr) -> Vec<u16> {
        value.encode_wide().chain(std::iter::once(0)).collect()
    }

    let source_wide = wide_null(source.as_os_str());
    let destination_wide = wide_null(destination.as_os_str());
    let result = unsafe {
        MoveFileExW(
            source_wide.as_ptr(),
            destination_wide.as_ptr(),
            MOVE_FILE_REPLACE_EXISTING | MOVE_FILE_WRITE_THROUGH,
        )
    };
    if result == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

#[tauri::command]
async fn kv_get(kv: State<'_, Kv>, key: String) -> Result<Value, String> {
    let data = kv.data.lock().await;
    Ok(data.get(&key).cloned().unwrap_or(Value::Null))
}

#[tauri::command]
async fn kv_set(kv: State<'_, Kv>, key: String, value: Value) -> Result<(), String> {
    let mut data = kv.data.lock().await;
    let next = updated_store(&data, key, value)?;
    persist_store(&kv.path, &next)?;
    *data = next;
    Ok(())
}

/* ============ 凭据（Windows 凭据管理器 / DPAPI） ============ */

fn entry(env_id: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, env_id).map_err(|e| e.to_string())
}

#[tauri::command]
fn cred_set(env_id: String, password: String) -> Result<(), String> {
    entry(&env_id)?
        .set_password(&password)
        .map_err(|e| format!("保存到 Windows 凭据管理器失败：{e}"))
}

#[tauri::command]
fn cred_get(env_id: String) -> Result<Option<String>, String> {
    match entry(&env_id)?.get_password() {
        Ok(p) => Ok(Some(p)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
fn cred_delete(env_id: String) -> Result<(), String> {
    match entry(&env_id)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

/* ============ 应用信息 ============ */

#[tauri::command]
fn app_version(app: tauri::AppHandle) -> String {
    app.package_info().version.to_string()
}

/* ============ CSV 原生另存为 ============ */

#[tauri::command]
async fn export_csv(
    app: tauri::AppHandle,
    default_name: String,
    content: String,
) -> Result<bool, String> {
    let picked = app
        .dialog()
        .file()
        .set_file_name(format!("{default_name}.csv"))
        .add_filter("CSV 文件", &["csv"])
        .blocking_save_file();
    match picked {
        Some(p) => {
            let path = p.into_path().map_err(|e| e.to_string())?;
            fs::write(&path, content.as_bytes()).map_err(|e| format!("写入文件失败：{e}"))?;
            Ok(true)
        }
        None => Ok(false), // 用户取消
    }
}

/* ============ 入口 ============ */

#[tauri::command]
fn mcp_status(host: State<'_, mcp::McpHost>) -> mcp::McpStatus {
    host.status()
}

fn build_app() -> tauri::App {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            background::restore_main_window(app);
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .on_window_event(handle_window_event)
        .setup(setup_app)
        .invoke_handler(command_handler())
        .build(tauri::generate_context!())
        .expect("SQL Studio 启动失败")
}

fn command_handler() -> impl Fn(tauri::ipc::Invoke<tauri::Wry>) -> bool + Send + Sync + 'static {
    tauri::generate_handler![
        archery::login,
        archery::api_get,
        archery::api_post,
        kv_get,
        kv_set,
        cred_set,
        cred_get,
        cred_delete,
        app_version,
        mcp_status,
        mcp::reset_token,
        export_csv,
        plugins::dingtalk::dingtalk_config_status,
        plugins::dingtalk::dingtalk_save_config,
        plugins::dingtalk::dingtalk_delete_config,
        plugins::dingtalk::dingtalk_send_text,
        workflows::commands::workflow_create,
        workflows::commands::workflow_list,
        workflows::commands::workflow_get,
        workflows::commands::workflow_update,
        workflows::commands::workflow_copy,
        workflows::commands::workflow_archive,
        workflows::commands::workflow_set_enabled,
        workflows::commands::workflow_plugin_resource_register,
        workflows::commands::workflow_plugin_resources,
        workflows::commands::workflow_publish,
        workflows::commands::workflow_version_get,
        workflows::commands::run_workflow_manual,
        workflows::commands::list_workflow_executions,
        workflows::commands::get_workflow_execution,
        workflows::schedule_commands::workflow_schedule_get,
        workflows::schedule_commands::workflow_schedule_preview,
        workflows::schedule_commands::workflow_schedule_upsert,
        workflows::schedule_commands::workflow_schedule_set_enabled,
        workflows::schedule_commands::workflow_schedule_delete,
        notifications::commands::message_list,
        notifications::commands::message_unread_count,
        notifications::commands::message_mark_read,
        notifications::commands::message_mark_all_read,
        notifications::commands::message_preferences_get,
        notifications::commands::message_preferences_update,
        notifications::commands::message_deliver_native,
        lifecycle::bootstrap_state,
        lifecycle::save_ui_snapshot,
        lifecycle::register_workspace_webview,
        lifecycle::unregister_workspace_webview,
        lifecycle::open_main_window,
        lifecycle::set_lightweight_mode,
        lifecycle::window_close_ready,
        lifecycle::window_close_failed
    ]
}

fn setup_app(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let dir = app.path().app_config_dir()?;
    fs::create_dir_all(&dir)?;
    let path = dir.join("store.json");
    let workflow_db = storage::WorkflowDb::initialize(dir.join("workflow.db"))?;
    workflows::execution_repository::interrupt_running(&mut workflow_db.open_connection()?)?;
    let data = load_store(&path).map_err(io::Error::other)?;
    let lifecycle_state = lifecycle::LifecycleState::from_store(&data).map_err(io::Error::other)?;
    let create_window = !lifecycle_state.is_lightweight();
    app.manage(Kv {
        path,
        data: Mutex::new(data),
    });
    app.manage(lifecycle_state);
    app.manage(archery::ArcheryService::default());
    let mcp_token = mcp::load_or_create_token()?;
    app.manage(mcp::start_host(app.handle().clone(), mcp_token));
    app.manage(workflow_db);
    app.manage(scheduler::SchedulerHost::start(app.handle().clone()));
    background::setup_tray(app)?;
    if create_window {
        lifecycle::create_main_window(app.handle())?;
    }
    Ok(())
}

fn handle_window_event(window: &tauri::Window, event: &WindowEvent) {
    if let Err(error) = lifecycle::handle_window_event(window, event) {
        eprintln!("处理窗口生命周期事件失败：{error}");
    }
    let WindowEvent::CloseRequested { api, .. } = event else {
        return;
    };
    if window.label() != lifecycle::MAIN_WINDOW_LABEL {
        return;
    }
    api.prevent_close();
    if let Err(error) = lifecycle::request_close_main_window(window.app_handle()) {
        lifecycle::cancel_close_main_window(window.app_handle());
        eprintln!("请求关闭主界面失败：{error}");
    }
}

fn main() {
    let app = build_app();
    app.run(|_, event| {
        if let tauri::RunEvent::ExitRequested {
            code: None, api, ..
        } = event
        {
            api.prevent_exit();
        }
    });
}

#[cfg(test)]
mod tests {
    use super::{load_store, persist_store};
    use serde_json::json;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn load_store_returns_empty_object_when_file_is_missing() {
        let directory = tempdir().expect("create temp directory");
        let store_path = directory.path().join("store.json");

        let data = load_store(&store_path).expect("load missing store");

        assert_eq!(data, json!({}));
    }

    #[test]
    fn load_store_reports_corrupted_json() {
        let directory = tempdir().expect("create temp directory");
        let store_path = directory.path().join("store.json");
        fs::write(&store_path, b"{broken json").expect("write corrupted store");

        let error = load_store(&store_path).expect_err("corrupted JSON must fail");

        assert!(error.contains("解析配置文件"));
        assert!(error.contains("store.json"));
    }

    #[test]
    fn persist_store_atomically_replaces_existing_content() {
        let directory = tempdir().expect("create temp directory");
        let store_path = directory.path().join("store.json");
        fs::write(&store_path, br#"{"old":true}"#).expect("write existing store");
        let expected = json!({"new": [1, 2, 3]});

        persist_store(&store_path, &expected).expect("persist store");

        assert_eq!(load_store(&store_path).expect("reload store"), expected);
        let remaining_files = fs::read_dir(directory.path())
            .expect("read temp directory")
            .collect::<Result<Vec<_>, _>>()
            .expect("collect directory entries");
        assert_eq!(remaining_files.len(), 1);
    }
}
