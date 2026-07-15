// SQL Studio 桌面版宿主 — 对应扩展 background.js 的职责：
// 代发 Archery 请求（每环境独立 Cookie Jar）、登录/CSRF、本地 KV 存储、
// Windows 凭据管理器（DPAPI）存取密码、CSV 原生另存为。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod background;
mod startup_diagnostics;
mod startup_log;

use std::{collections::HashMap, fs, path::PathBuf, sync::Arc};

use reqwest::cookie::{CookieStore, Jar};
use reqwest::Client;
use serde_json::{json, Value};
use tauri::{Manager, RunEvent, State, WindowEvent};
use tauri_plugin_dialog::DialogExt;
use tokio::sync::Mutex;

const UA: &str = "Mozilla/5.0 (SQL Studio Desktop)";
const KEYRING_SERVICE: &str = "sql-studio";

/* ============ 每环境 HTTP 客户端（独立 Cookie Jar，复现浏览器按域隔离会话） ============ */

struct EnvClient {
    client: Client,
    jar: Arc<Jar>,
}

#[derive(Default)]
struct Http(Mutex<HashMap<String, Arc<EnvClient>>>);

async fn env_client(http: &Http, origin: &str) -> Result<Arc<EnvClient>, String> {
    let mut map = http.0.lock().await;
    if let Some(ec) = map.get(origin) {
        return Ok(ec.clone());
    }
    let jar = Arc::new(Jar::default());
    let client = Client::builder()
        .cookie_provider(jar.clone())
        .user_agent(UA)
        // 目标均为内网 Archery：忽略系统/环境变量代理，直连
        .no_proxy()
        // 内网自签 https 兼容；目标环境均为受控内网 Archery
        .danger_accept_invalid_certs(true)
        .build()
        .map_err(|e| e.to_string())?;
    let ec = Arc::new(EnvClient { client, jar });
    map.insert(origin.to_string(), ec.clone());
    Ok(ec)
}

/// 从该环境 Jar 中读取指定 Cookie（如 csrftoken）
fn cookie_value(jar: &Jar, origin: &str, name: &str) -> String {
    let url = match origin.parse() {
        Ok(u) => u,
        Err(_) => return String::new(),
    };
    let header = match jar.cookies(&url) {
        Some(h) => h,
        None => return String::new(),
    };
    let s = header.to_str().unwrap_or("");
    for pair in s.split(';') {
        let pair = pair.trim();
        if let Some(v) = pair.strip_prefix(&format!("{name}=")) {
            return v.to_string();
        }
    }
    String::new()
}

/// 按 Archery JSON 协议解析：{status, msg, data}；status!=0 或非 JSON 均报错
fn parse_archery_response(text: &str, http_status: u16) -> Result<Value, String> {
    let v: Value = match serde_json::from_str(text) {
        Ok(v) => v,
        Err(_) => {
            // 未登录时 Archery 重定向到登录页返回 HTML
            let low = text.to_lowercase();
            if low.contains("<html") || low.contains("<!doctype") {
                return Err("未登录或会话已过期，请重新登录".into());
            }
            return Err(format!("响应解析失败（HTTP {http_status}）"));
        }
    };
    if v["status"] != json!(0) {
        let msg = v["msg"].as_str().unwrap_or("").to_string();
        return Err(if msg.is_empty() {
            format!("请求失败（status={}）", v["status"])
        } else {
            msg
        });
    }
    Ok(v["data"].clone())
}

const NET_ERR: &str = "网络请求失败，请检查是否连入内网 / 域名是否可达";

/* ============ 业务 command ============ */

/// 登录：先 GET /login/ 取 csrftoken，再 POST /authenticate/
#[tauri::command]
async fn login(
    http: State<'_, Http>,
    origin: String,
    username: String,
    password: String,
) -> Result<(), String> {
    let ec = env_client(&http, &origin).await?;
    // 触发服务端下发 csrftoken（若已有则复用），允许失败
    let _ = ec.client.get(format!("{origin}/login/")).send().await;
    let token = cookie_value(&ec.jar, &origin, "csrftoken");
    let resp = ec
        .client
        .post(format!("{origin}/authenticate/"))
        .header("X-CSRFToken", &token)
        .header("X-Requested-With", "XMLHttpRequest")
        .header("Origin", &origin)
        .header("Referer", format!("{origin}/login/"))
        .form(&[
            ("username", username.as_str()),
            ("password", password.as_str()),
        ])
        .send()
        .await
        .map_err(|_| NET_ERR.to_string())?;
    let status = resp.status().as_u16();
    let text = resp.text().await.map_err(|e| e.to_string())?;
    let v: Value =
        serde_json::from_str(&text).map_err(|_| format!("登录响应异常（HTTP {status}）"))?;
    if v["status"] != json!(0) {
        return Err(v["msg"].as_str().unwrap_or("用户名或密码错误").to_string());
    }
    Ok(())
}

/// GET 业务接口，返回 Archery 协议中的 data 字段
#[tauri::command]
async fn api_get(http: State<'_, Http>, origin: String, path: String) -> Result<Value, String> {
    let ec = env_client(&http, &origin).await?;
    let resp = ec
        .client
        .get(format!("{origin}{path}"))
        .header("X-Requested-With", "XMLHttpRequest")
        .header("Accept", "application/json, text/javascript, */*; q=0.01")
        .send()
        .await
        .map_err(|_| NET_ERR.to_string())?;
    let status = resp.status().as_u16();
    let text = resp.text().await.map_err(|e| e.to_string())?;
    parse_archery_response(&text, status)
}

/// POST 业务接口（表单编码 + CSRF），返回 data 字段
#[tauri::command]
async fn api_post(
    http: State<'_, Http>,
    origin: String,
    path: String,
    form: HashMap<String, String>,
) -> Result<Value, String> {
    let ec = env_client(&http, &origin).await?;
    let token = cookie_value(&ec.jar, &origin, "csrftoken");
    let resp = ec
        .client
        .post(format!("{origin}{path}"))
        .header("X-CSRFToken", &token)
        .header("X-Requested-With", "XMLHttpRequest")
        .header("Origin", &origin)
        .header("Referer", format!("{origin}/sqlquery/"))
        .form(&form)
        .send()
        .await
        .map_err(|_| NET_ERR.to_string())?;
    let status = resp.status().as_u16();
    let text = resp.text().await.map_err(|e| e.to_string())?;
    parse_archery_response(&text, status)
}

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

fn log_diagnostic_lines(path: &std::path::Path, lines: Vec<String>) {
    for line in lines {
        let _ = startup_log::write_log(path, "INFO", &line);
    }
}

/// 按需覆盖 wry 默认浏览器参数（覆盖时必须带上 wry 默认的 --disable-features 项）：
/// - Win10：追加禁用 RendererCodeIntegrity——渲染进程代码完整性校验在 Win10 上
///   与部分安全软件注入的 DLL 冲突，导致渲染进程反复崩溃、窗口白屏；
/// - 连续 2 次启动未完成：追加禁用 GPU 与 GPU 合成——老显卡驱动/老系统上
///   DirectComposition 初始化挂死是控制器创建回调不返回的高频原因。
fn additional_browser_args(failed_startups: u32) -> Option<String> {
    let mut features = "msWebOOUI,msPdfOOUI,msSmartScreenProtection".to_string();
    #[cfg(windows)]
    if windows_version::OsVersion::current().build < 22000 {
        features.push_str(",RendererCodeIntegrity");
    }
    let mut args = format!("--disable-features={features}");
    if failed_startups >= 2 {
        args.push_str(" --disable-gpu --disable-gpu-compositing");
    }
    if args == "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection" {
        // 与 wry 默认一致，无需覆盖
        None
    } else {
        Some(args)
    }
}

#[cfg(windows)]
fn show_startup_error(message: &str) {
    use windows::core::HSTRING;
    use windows::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONERROR, MB_OK};
    let text = HSTRING::from(format!(
        "SQL Studio 启动失败：{message}\n\n详细日志：%TEMP%\\sql-studio-startup.log"
    ));
    let caption = HSTRING::from("SQL Studio");
    unsafe {
        MessageBoxW(None, &text, &caption, MB_OK | MB_ICONERROR);
    }
}

#[cfg(not(windows))]
fn show_startup_error(_message: &str) {}

fn create_main_window(
    app: &tauri::App,
    log_path: &std::path::Path,
    tracker: &startup_log::StartupTracker,
    failed_startups: u32,
) -> Result<(), Box<dyn std::error::Error>> {
    tracker.mark(
        startup_log::StartupPhase::CreatingMainWindow,
        "creating main window",
    );
    let window_config = app
        .config()
        .app
        .windows
        .iter()
        .find(|window| window.label == "main")
        .cloned()
        .ok_or("main window config missing")?;
    let mut builder = tauri::WebviewWindowBuilder::from_config(app.handle(), &window_config)?;
    if let Some(args) = additional_browser_args(failed_startups) {
        let _ = startup_log::write_log(
            log_path,
            "INFO",
            &format!("main window additional browser args: {args}"),
        );
        builder = builder.additional_browser_args(&args);
    }
    builder.build().map_err(|error| {
        let _ = startup_log::write_log(
            log_path,
            "ERROR",
            &format!("main window creation failed: {error}"),
        );
        error
    })?;
    tracker.mark(
        startup_log::StartupPhase::MainWindowCreated,
        "main window created",
    );
    Ok(())
}

fn configure_app_state(
    app: &mut tauri::App,
    log_path: &std::path::Path,
    tracker: &startup_log::StartupTracker,
) -> Result<(), Box<dyn std::error::Error>> {
    tracker.mark(
        startup_log::StartupPhase::SetupEntered,
        "tauri app setup entered",
    );
    // 启动自愈：上次启动未完成时重置 WebView2 用户数据，再写入本次未完成标记
    let local_dir = app.path().app_local_data_dir()?;
    fs::create_dir_all(&local_dir)?;
    let (recover_lines, failed_startups) = startup_diagnostics::recover_webview_data(&local_dir);
    log_diagnostic_lines(log_path, recover_lines);
    log_diagnostic_lines(
        log_path,
        startup_diagnostics::write_pending_marker(&local_dir, failed_startups),
    );
    app.manage(startup_log::StartupLog::new(
        log_path.to_path_buf(),
        tracker.clone(),
        Some(startup_diagnostics::pending_marker_path(&local_dir)),
    ));
    let dir = app.path().app_config_dir()?;
    let _ = startup_log::write_log(
        log_path,
        "INFO",
        &format!("config directory resolved: {}", dir.display()),
    );
    log_diagnostic_lines(log_path, startup_diagnostics::window_state_lines(&dir));
    fs::create_dir_all(&dir)?;
    let path = dir.join("store.json");
    let data = fs::read_to_string(&path)
        .ok()
        .and_then(|value| serde_json::from_str(&value).ok())
        .unwrap_or_else(|| json!({}));
    app.manage(Kv {
        path,
        data: Mutex::new(data),
    });
    app.manage(Http::default());
    // 主窗口在此手动创建（tauri.conf.json 中 create=false），
    // 以便精确记录 WebView2 创建卡点并按系统版本注入浏览器参数
    create_main_window(app, log_path, tracker, failed_startups)?;
    background::setup_tray(app, log_path)?;
    let windows = app.webview_windows().keys().cloned().collect::<Vec<_>>();
    let _ = startup_log::write_log(log_path, "INFO", &format!("configured windows={windows:?}"));
    tracker.mark(
        startup_log::StartupPhase::SetupCompleted,
        "tauri app setup completed",
    );
    Ok(())
}

fn build_application(
    log_path: &std::path::Path,
    tracker: &startup_log::StartupTracker,
) -> tauri::App {
    let _ = startup_log::write_log(log_path, "INFO", "creating tauri builder");
    let diagnostics = startup_diagnostics::diagnostic_plugin(log_path.to_path_buf());
    let _ = startup_log::write_log(log_path, "INFO", "diagnostic plugin constructed");
    let dialog = tauri_plugin_dialog::init();
    let _ = startup_log::write_log(log_path, "INFO", "dialog plugin constructed");
    let window_state = tauri_plugin_window_state::Builder::default().build();
    let _ = startup_log::write_log(log_path, "INFO", "window-state plugin constructed");
    let setup_path = log_path.to_path_buf();
    let setup_tracker = tracker.clone();
    let window_path = log_path.to_path_buf();
    let builder = tauri::Builder::default()
        .plugin(diagnostics)
        .plugin(dialog)
        .plugin(window_state)
        .on_window_event(move |window, event| match event {
            WindowEvent::CloseRequested { api, .. } => {
                let message = format!("window event: label={} event={event:?}", window.label());
                let _ = startup_log::write_log(&window_path, "INFO", &message);
                if window.label() == "main" {
                    api.prevent_close();
                    background::hide_main_window(window, &window_path);
                }
            }
            WindowEvent::Destroyed | WindowEvent::Focused(_) => {
                let message = format!("window event: label={} event={event:?}", window.label());
                let _ = startup_log::write_log(&window_path, "INFO", &message);
            }
            _ => {}
        })
        .setup(
            move |app| match configure_app_state(app, &setup_path, &setup_tracker) {
                Ok(()) => Ok(()),
                Err(error) => {
                    let _ = startup_log::write_log(
                        &setup_path,
                        "ERROR",
                        &format!("app setup failed: {error}"),
                    );
                    show_startup_error(&error.to_string());
                    Err(error)
                }
            },
        )
        .invoke_handler(tauri::generate_handler![
            login,
            api_get,
            api_post,
            kv_get,
            kv_set,
            cred_set,
            cred_get,
            cred_delete,
            app_version,
            export_csv,
            startup_log::frontend_log
        ]);
    tracker.mark(
        startup_log::StartupPhase::PluginsRegistered,
        "all plugins registered",
    );
    let context = tauri::generate_context!();
    tracker.mark(
        startup_log::StartupPhase::ContextCreated,
        "tauri context created",
    );
    tracker.mark(
        startup_log::StartupPhase::BuildingApplication,
        "tauri application build started",
    );
    builder.build(context).unwrap_or_else(|error| {
        let _ = startup_log::write_log(log_path, "ERROR", &format!("tauri build failed: {error}"));
        panic!("SQL Studio 构建应用失败: {error}");
    })
}

fn main() {
    let log_path = startup_log::default_log_path();
    let _ = startup_log::reset_log(&log_path);
    startup_log::install_panic_hook(log_path.clone());
    let tracker = startup_log::StartupTracker::new(log_path.clone());
    tracker.mark(
        startup_log::StartupPhase::NativeEntered,
        "native main entered",
    );
    tracker.start_watchdog();
    // 必须在记录环境信息和创建 WebView2 之前应用固定版本运行时
    log_diagnostic_lines(&log_path, startup_diagnostics::apply_fixed_runtime());
    log_diagnostic_lines(&log_path, startup_diagnostics::environment_lines(&log_path));
    tracker.mark(
        startup_log::StartupPhase::EnvironmentLogged,
        "startup environment diagnostics completed",
    );
    let app = build_application(&log_path, &tracker);
    tracker.mark(
        startup_log::StartupPhase::ApplicationBuilt,
        "tauri application built",
    );
    let event_path = log_path.clone();
    let event_tracker = tracker.clone();
    tracker.mark(
        startup_log::StartupPhase::EventLoopStarting,
        "starting tauri event loop",
    );
    app.run(move |_handle, event| match event {
        RunEvent::Ready => event_tracker.mark(
            startup_log::StartupPhase::EventLoopReady,
            "tauri event loop ready",
        ),
        RunEvent::ExitRequested { code, .. } => {
            let _ = startup_log::write_log(
                &event_path,
                "INFO",
                &format!("tauri exit requested: code={code:?}"),
            );
        }
        RunEvent::Exit => event_tracker.mark(
            startup_log::StartupPhase::Exiting,
            "tauri event loop exited",
        ),
        _ => {}
    });
}
