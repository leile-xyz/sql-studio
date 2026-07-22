use std::{
    collections::BTreeSet,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Mutex,
    },
};

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_window_state::{AppHandleExt, StateFlags};

use crate::{archery::ArcheryService, mcp::McpHost, scheduler::SchedulerHost, Kv};

pub const MAIN_WINDOW_LABEL: &str = "main";
pub const LIGHTWEIGHT_MODE_KEY: &str = "lightweight_mode";
pub const UI_SNAPSHOT_KEY: &str = "ui_snapshot";
pub const PREPARE_CLOSE_EVENT: &str = "sql-studio://prepare-window-close";
pub const CLOSE_DESTROY_FAILED_EVENT: &str = "sql-studio://window-close-destroy-failed";

const MAIN_WINDOW_CONFIG_ERROR: &str = "主窗口配置缺失";
const WORKSPACE_WINDOW_PREFIX: &str = "workspace-";

pub struct LifecycleState {
    lightweight: AtomicBool,
    closing: AtomicBool,
    generation: AtomicU64,
    creation_lock: Mutex<()>,
    workspace_labels: Mutex<BTreeSet<String>>,
}

impl LifecycleState {
    pub fn from_store(data: &Value) -> Result<Self, String> {
        let lightweight = mode_from_store(data)?;
        Ok(Self {
            lightweight: AtomicBool::new(lightweight),
            closing: AtomicBool::new(false),
            generation: AtomicU64::new(0),
            creation_lock: Mutex::new(()),
            workspace_labels: Mutex::new(BTreeSet::new()),
        })
    }

    pub fn is_lightweight(&self) -> bool {
        self.lightweight.load(Ordering::Acquire)
    }

    pub fn set_lightweight(&self, enabled: bool) {
        self.lightweight.store(enabled, Ordering::Release);
    }

    fn begin_close(&self) -> bool {
        self.closing
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
    }

    fn reset_close(&self) {
        self.closing.store(false, Ordering::Release);
    }

    fn is_closing(&self) -> bool {
        self.closing.load(Ordering::Acquire)
    }

    fn mark_created(&self) {
        self.generation.fetch_add(1, Ordering::AcqRel);
        self.reset_close();
    }

    fn mark_destroyed(&self) {
        self.generation.fetch_add(1, Ordering::AcqRel);
        self.reset_close();
        self.workspace_labels
            .lock()
            .expect("Workspace WebView 注册表损坏")
            .clear();
    }

    fn generation(&self) -> u64 {
        self.generation.load(Ordering::Acquire)
    }

    fn creation_guard(&self) -> std::sync::MutexGuard<'_, ()> {
        self.creation_lock.lock().expect("主窗口创建锁损坏")
    }

    pub fn register_workspace(&self, label: String) {
        self.workspace_labels
            .lock()
            .expect("Workspace WebView 注册表损坏")
            .insert(label);
    }

    fn unregister_workspace(&self, label: &str) {
        self.workspace_labels
            .lock()
            .expect("Workspace WebView 注册表损坏")
            .remove(label);
    }

    fn workspace_labels(&self) -> Vec<String> {
        self.workspace_labels
            .lock()
            .expect("Workspace WebView 注册表损坏")
            .iter()
            .cloned()
            .collect()
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BootstrapSnapshot {
    pub mode: ModeSnapshot,
    pub persistent: Value,
    pub runtime: RuntimeSnapshot,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModeSnapshot {
    pub lightweight: bool,
    pub startup_lightweight: bool,
    pub ui_present: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeSnapshot {
    pub generation: u64,
    pub main_window_present: bool,
    pub workspace_webviews: Vec<String>,
    pub background: BackgroundSnapshot,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundSnapshot {
    pub scheduler_managed: bool,
    pub mcp_running: bool,
    pub archery_sessions: usize,
}

pub fn mode_from_store(data: &Value) -> Result<bool, String> {
    match data.get(LIGHTWEIGHT_MODE_KEY) {
        None => Ok(false),
        Some(value) => value
            .as_bool()
            .ok_or_else(|| format!("配置项 {LIGHTWEIGHT_MODE_KEY} 必须是布尔值")),
    }
}

pub async fn snapshot(
    app: &AppHandle,
    kv: &Kv,
    lifecycle: &LifecycleState,
) -> Result<BootstrapSnapshot, String> {
    let persistent = kv.data.lock().await.clone();
    let archery_sessions = match app.try_state::<ArcheryService>() {
        Some(service) => service.session_count().await,
        None => 0,
    };
    Ok(snapshot_from_data(
        app,
        lifecycle,
        persistent,
        archery_sessions,
    ))
}

fn snapshot_from_data(
    app: &AppHandle,
    lifecycle: &LifecycleState,
    persistent: Value,
    archery_sessions: usize,
) -> BootstrapSnapshot {
    let ui_present = app.get_webview_window(MAIN_WINDOW_LABEL).is_some();
    let mcp_running = app
        .try_state::<McpHost>()
        .map(|host| host.status().running)
        .unwrap_or(false);
    let background = BackgroundSnapshot {
        scheduler_managed: app.try_state::<SchedulerHost>().is_some(),
        mcp_running,
        archery_sessions,
    };
    BootstrapSnapshot {
        mode: ModeSnapshot {
            lightweight: !ui_present,
            startup_lightweight: lifecycle.is_lightweight(),
            ui_present,
        },
        persistent,
        runtime: RuntimeSnapshot {
            generation: lifecycle.generation(),
            main_window_present: ui_present,
            workspace_webviews: registered_workspace_windows(app, lifecycle),
            background,
        },
    }
}

#[tauri::command]
pub async fn bootstrap_state(
    app: AppHandle,
    kv: State<'_, Kv>,
    lifecycle: State<'_, LifecycleState>,
) -> Result<BootstrapSnapshot, String> {
    snapshot(&app, &kv, &lifecycle).await
}

#[tauri::command]
pub async fn save_ui_snapshot(kv: State<'_, Kv>, snapshot: Value) -> Result<(), String> {
    if !snapshot.is_object() {
        return Err("界面状态快照必须是 JSON 对象".to_string());
    }
    let mut data = kv.data.lock().await;
    let next = crate::updated_store(&data, UI_SNAPSHOT_KEY.to_string(), snapshot)?;
    crate::persist_store(&kv.path, &next)?;
    *data = next;
    Ok(())
}

#[tauri::command]
pub fn register_workspace_webview(
    lifecycle: State<'_, LifecycleState>,
    label: String,
) -> Result<(), String> {
    validate_workspace_label(&label)?;
    lifecycle.register_workspace(label);
    Ok(())
}

#[tauri::command]
pub fn unregister_workspace_webview(
    lifecycle: State<'_, LifecycleState>,
    label: String,
) -> Result<(), String> {
    validate_workspace_label(&label)?;
    lifecycle.unregister_workspace(&label);
    Ok(())
}

fn validate_workspace_label(label: &str) -> Result<(), String> {
    if label.starts_with(WORKSPACE_WINDOW_PREFIX) {
        return Ok(());
    }
    Err(format!(
        "Workspace WebView 标签必须以 {WORKSPACE_WINDOW_PREFIX} 开头"
    ))
}

pub fn create_main_window(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    let lifecycle = app.state::<LifecycleState>();
    let _guard = lifecycle.creation_guard();
    if lifecycle.is_closing() {
        return Err(lifecycle_error(
            "主窗口正在关闭，等待 Destroyed 事件后再创建",
        ));
    }
    if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        return Ok(window);
    }
    let config = app
        .config()
        .app
        .windows
        .iter()
        .find(|window| window.label == MAIN_WINDOW_LABEL)
        .ok_or_else(|| lifecycle_error(MAIN_WINDOW_CONFIG_ERROR))?;
    let window = WebviewWindowBuilder::from_config(app, config)?.build()?;
    lifecycle.mark_created();
    Ok(window)
}

fn lifecycle_error(message: &str) -> tauri::Error {
    tauri::Error::Io(std::io::Error::other(message))
}

pub fn show_or_create_main_window(app: &AppHandle) -> tauri::Result<()> {
    let window = create_main_window(app)?;
    window.unminimize()?;
    window.show()?;
    window.set_focus()
}

pub fn request_close_main_window(app: &AppHandle) -> tauri::Result<()> {
    let lifecycle = app.state::<LifecycleState>();
    let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) else {
        lifecycle.reset_close();
        return Ok(());
    };
    if !lifecycle.begin_close() {
        return Ok(());
    }
    window.emit(PREPARE_CLOSE_EVENT, json!({ "reason": "window-close" }))
}

pub fn cancel_close_main_window(app: &AppHandle) {
    app.state::<LifecycleState>().reset_close();
}

pub fn destroy_main_window(app: &AppHandle) -> tauri::Result<()> {
    let lifecycle = app.state::<LifecycleState>();
    let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) else {
        lifecycle.mark_destroyed();
        return Ok(());
    };
    app.save_window_state(StateFlags::all())
        .map_err(|error| tauri::Error::Io(std::io::Error::other(error.to_string())))?;
    destroy_workspace_windows(app, &lifecycle)?;
    window.destroy()?;
    Ok(())
}

fn destroy_workspace_windows(app: &AppHandle, lifecycle: &LifecycleState) -> tauri::Result<()> {
    for label in registered_workspace_windows(app, lifecycle) {
        if let Some(window) = app.get_webview_window(&label) {
            window.destroy()?;
        }
    }
    Ok(())
}

fn registered_workspace_windows(app: &AppHandle, lifecycle: &LifecycleState) -> Vec<String> {
    let mut labels = lifecycle
        .workspace_labels()
        .into_iter()
        .collect::<BTreeSet<_>>();
    labels.extend(
        app.webview_windows()
            .into_keys()
            .filter(|label| label.starts_with(WORKSPACE_WINDOW_PREFIX)),
    );
    labels.into_iter().collect()
}

pub fn handle_window_event(window: &tauri::Window, event: &WindowEvent) -> tauri::Result<()> {
    if window.label() != MAIN_WINDOW_LABEL {
        return Ok(());
    }
    if let WindowEvent::Destroyed = event {
        window
            .app_handle()
            .state::<LifecycleState>()
            .mark_destroyed();
    }
    Ok(())
}

#[tauri::command]
pub async fn window_close_ready(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn(async move {
        tokio::task::yield_now().await;
        if let Err(error) = destroy_main_window(&app) {
            let message = error.to_string();
            cancel_close_main_window(&app);
            eprintln!("销毁主界面失败：{message}");
            if let Err(event_error) =
                app.emit(CLOSE_DESTROY_FAILED_EVENT, json!({ "message": message }))
            {
                eprintln!("发送主界面销毁失败事件失败：{event_error}");
            }
        }
    });
    Ok(())
}

#[tauri::command]
pub fn window_close_failed(app: AppHandle, message: String) -> Result<(), String> {
    cancel_close_main_window(&app);
    eprintln!("前端关闭清理失败：{message}");
    Ok(())
}

#[tauri::command]
pub async fn open_main_window(app: AppHandle) -> Result<(), String> {
    show_or_create_main_window(&app).map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn set_lightweight_mode(
    app: AppHandle,
    enabled: bool,
) -> Result<BootstrapSnapshot, String> {
    apply_mode(&app, enabled).await?;
    let kv = app.state::<Kv>();
    let lifecycle = app.state::<LifecycleState>();
    snapshot(&app, &kv, &lifecycle).await
}

async fn persist_mode(kv: &Kv, enabled: bool) -> Result<(), String> {
    let mut data = kv.data.lock().await;
    let next = crate::updated_store(&data, LIGHTWEIGHT_MODE_KEY.to_string(), json!(enabled))?;
    crate::persist_store(&kv.path, &next)?;
    *data = next;
    Ok(())
}

pub(crate) async fn set_mode_from_handle(app: &AppHandle, enabled: bool) -> Result<(), String> {
    apply_mode(app, enabled).await
}

async fn apply_mode(app: &AppHandle, enabled: bool) -> Result<(), String> {
    let kv = app.state::<Kv>();
    let lifecycle = app.state::<LifecycleState>();
    let previous = lifecycle.is_lightweight();
    persist_mode(&kv, enabled).await?;
    lifecycle.set_lightweight(enabled);
    let ui_result = if enabled {
        request_close_main_window(app).map_err(|error| error.to_string())
    } else {
        show_or_create_main_window(app).map_err(|error| error.to_string())
    };
    if let Err(error) = ui_result {
        if let Err(rollback) = persist_mode(&kv, previous).await {
            return Err(format!("{error}；回滚轻量模式配置失败：{rollback}"));
        }
        lifecycle.set_lightweight(previous);
        return Err(error);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{mode_from_store, LIGHTWEIGHT_MODE_KEY};
    use serde_json::json;

    #[test]
    fn missing_mode_defaults_to_normal() {
        assert!(!mode_from_store(&json!({})).expect("missing mode is valid"));
    }

    #[test]
    fn mode_requires_boolean_value() {
        let error = mode_from_store(&json!({ LIGHTWEIGHT_MODE_KEY: "yes" }))
            .expect_err("invalid mode must fail");
        assert!(error.contains("必须是布尔值"));
    }

    #[test]
    fn explicit_mode_is_read_without_frontend() {
        assert!(mode_from_store(&json!({ LIGHTWEIGHT_MODE_KEY: true })).unwrap());
    }
}
