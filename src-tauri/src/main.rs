// SQL Studio 桌面版宿主 — 对应扩展 background.js 的职责：
// 代发 Archery 请求（每环境独立 Cookie Jar）、登录/CSRF、本地 KV 存储、
// Windows 凭据管理器（DPAPI）存取密码、CSV 原生另存为。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod archery;
mod background;
mod mcp;
mod notifications;
mod plugins;
mod scheduler;
mod storage;
mod workflows;

use std::{fs, path::PathBuf};

use serde_json::{json, Value};
use tauri::{Manager, State, WindowEvent};
use tauri_plugin_dialog::DialogExt;
use tokio::sync::Mutex;

const KEYRING_SERVICE: &str = "sql-studio";

/* ============ 本地 KV 存储（环境列表 / 查询历史等非敏感数据） ============ */

struct Kv {
    path: PathBuf,
    data: Mutex<Value>,
}

#[tauri::command]
async fn kv_get(kv: State<'_, Kv>, key: String) -> Result<Value, String> {
    let data = kv.data.lock().await;
    Ok(data.get(&key).cloned().unwrap_or(Value::Null))
}

#[tauri::command]
async fn kv_set(kv: State<'_, Kv>, key: String, value: Value) -> Result<(), String> {
    let mut data = kv.data.lock().await;
    data[&key] = value;
    fs::write(
        &kv.path,
        serde_json::to_string_pretty(&*data).map_err(|e| e.to_string())?,
    )
    .map_err(|e| format!("写入配置文件失败：{e}"))?;
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

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            background::restore_main_window(app).expect("恢复已有 SQL Studio 主窗口失败");
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() != "main" {
                    return;
                }
                api.prevent_close();
                background::hide_main_window(window).expect("隐藏主窗口到系统托盘失败");
            }
        })
        .setup(|app| {
            let dir = app.path().app_config_dir()?;
            fs::create_dir_all(&dir)?;
            let path = dir.join("store.json");
            let workflow_db = storage::WorkflowDb::initialize(dir.join("workflow.db"))?;
            workflows::execution_repository::interrupt_running(
                &mut workflow_db.open_connection()?,
            )?;
            let data = fs::read_to_string(&path)
                .ok()
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or_else(|| json!({}));
            app.manage(Kv {
                path,
                data: Mutex::new(data),
            });
            app.manage(archery::ArcheryService::default());
            app.manage(mcp::start_host());
            app.manage(workflow_db);
            app.manage(scheduler::SchedulerHost::start(app.handle().clone()));
            background::setup_tray(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
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
            workflows::schedule_commands::workflow_schedule_upsert,
            workflows::schedule_commands::workflow_schedule_set_enabled,
            workflows::schedule_commands::workflow_schedule_delete,
            notifications::commands::message_list,
            notifications::commands::message_unread_count,
            notifications::commands::message_mark_read,
            notifications::commands::message_mark_all_read,
            notifications::commands::message_preferences_get,
            notifications::commands::message_preferences_update,
            notifications::commands::message_deliver_native
        ])
        .run(tauri::generate_context!())
        .expect("SQL Studio 启动失败");
}
