// SQL Studio 桌面版宿主 — 对应扩展 background.js 的职责：
// 代发 dbadmin 请求（每环境独立 Cookie Jar）、登录/CSRF、本地 KV 存储、
// Windows 凭据管理器（DPAPI）存取密码、CSV 原生另存为。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{collections::HashMap, fs, path::PathBuf, sync::Arc};

use reqwest::cookie::{CookieStore, Jar};
use reqwest::Client;
use serde_json::{json, Value};
use tauri::{Manager, State};
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
        // 目标均为内网 dbadmin：忽略系统/环境变量代理，直连
        .no_proxy()
        // 内网自签 https 兼容；目标环境均为受控内网 dbadmin
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

/// 按 dbadmin JSON 协议解析：{status, msg, data}；status!=0 或非 JSON 均报错
fn parse_dbadmin(text: &str, http_status: u16) -> Result<Value, String> {
    let v: Value = match serde_json::from_str(text) {
        Ok(v) => v,
        Err(_) => {
            // 未登录时 dbadmin 重定向到登录页返回 HTML
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

/// GET 业务接口，返回 dbadmin 协议中的 data 字段
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
    parse_dbadmin(&text, status)
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
    parse_dbadmin(&text, status)
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

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .setup(|app| {
            let dir = app.path().app_config_dir()?;
            fs::create_dir_all(&dir)?;
            let path = dir.join("store.json");
            let data = fs::read_to_string(&path)
                .ok()
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or_else(|| json!({}));
            app.manage(Kv {
                path,
                data: Mutex::new(data),
            });
            app.manage(Http::default());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            login,
            api_get,
            api_post,
            kv_get,
            kv_set,
            cred_set,
            cred_get,
            cred_delete,
            export_csv
        ])
        .run(tauri::generate_context!())
        .expect("SQL Studio 启动失败");
}
