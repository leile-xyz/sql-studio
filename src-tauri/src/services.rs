use std::{collections::HashMap, fs, path::PathBuf, sync::Arc};

use reqwest::{
    cookie::{CookieStore, Jar},
    Client,
};
use serde_json::{json, Value};
use tokio::sync::Mutex;
use url::Url;

const KEYRING_SERVICE: &str = "sql-studio";
const NET_ERR: &str = "网络请求失败，请检查是否连入内网 / 域名是否可达";
const UA: &str = "Mozilla/5.0 (SQL Studio Browser Mode)";

struct EnvClient {
    client: Client,
    jar: Arc<Jar>,
}

pub struct AppServices {
    clients: Mutex<HashMap<String, Arc<EnvClient>>>,
    store: Mutex<Value>,
    store_path: PathBuf,
}

impl AppServices {
    pub fn load(store_path: PathBuf) -> Result<Self, String> {
        let store = if store_path.exists() {
            let source = fs::read_to_string(&store_path)
                .map_err(|error| format!("读取配置文件失败：{error}"))?;
            serde_json::from_str(&source).map_err(|error| format!("配置文件格式无效：{error}"))?
        } else {
            json!({})
        };
        Ok(Self {
            clients: Mutex::new(HashMap::new()),
            store: Mutex::new(store),
            store_path,
        })
    }

    async fn client(&self, origin: &str) -> Result<Arc<EnvClient>, String> {
        validate_origin(origin)?;
        let mut clients = self.clients.lock().await;
        if let Some(client) = clients.get(origin) {
            return Ok(client.clone());
        }
        let jar = Arc::new(Jar::default());
        let client = Client::builder()
            .cookie_provider(jar.clone())
            .user_agent(UA)
            .no_proxy()
            .danger_accept_invalid_certs(true)
            .build()
            .map_err(|error| error.to_string())?;
        let env_client = Arc::new(EnvClient { client, jar });
        clients.insert(origin.to_string(), env_client.clone());
        Ok(env_client)
    }

    pub async fn login(&self, origin: &str, username: &str, password: &str) -> Result<(), String> {
        let env = self.client(origin).await?;
        let _ = env.client.get(format!("{origin}/login/")).send().await;
        let token = cookie_value(&env.jar, origin, "csrftoken");
        let response = env
            .client
            .post(format!("{origin}/authenticate/"))
            .header("X-CSRFToken", token)
            .header("X-Requested-With", "XMLHttpRequest")
            .header("Origin", origin)
            .header("Referer", format!("{origin}/login/"))
            .form(&[("username", username), ("password", password)])
            .send()
            .await
            .map_err(|_| NET_ERR.to_string())?;
        let status = response.status().as_u16();
        let text = response.text().await.map_err(|error| error.to_string())?;
        let value: Value =
            serde_json::from_str(&text).map_err(|_| format!("登录响应异常（HTTP {status}）"))?;
        if value["status"] == json!(0) {
            return Ok(());
        }
        Err(value["msg"]
            .as_str()
            .unwrap_or("用户名或密码错误")
            .to_string())
    }

    pub async fn api_get(&self, origin: &str, path: &str) -> Result<Value, String> {
        validate_path(path)?;
        let env = self.client(origin).await?;
        let response = env
            .client
            .get(format!("{origin}{path}"))
            .header("X-Requested-With", "XMLHttpRequest")
            .header("Accept", "application/json, text/javascript, */*; q=0.01")
            .send()
            .await
            .map_err(|_| NET_ERR.to_string())?;
        parse_response(response).await
    }

    pub async fn api_post(
        &self,
        origin: &str,
        path: &str,
        form: &HashMap<String, String>,
    ) -> Result<Value, String> {
        validate_path(path)?;
        let env = self.client(origin).await?;
        let token = cookie_value(&env.jar, origin, "csrftoken");
        let response = env
            .client
            .post(format!("{origin}{path}"))
            .header("X-CSRFToken", token)
            .header("X-Requested-With", "XMLHttpRequest")
            .header("Origin", origin)
            .header("Referer", format!("{origin}/sqlquery/"))
            .form(form)
            .send()
            .await
            .map_err(|_| NET_ERR.to_string())?;
        parse_response(response).await
    }

    pub async fn kv_get(&self, key: &str) -> Value {
        self.store
            .lock()
            .await
            .get(key)
            .cloned()
            .unwrap_or(Value::Null)
    }

    pub async fn kv_set(&self, key: &str, value: Value) -> Result<(), String> {
        let mut store = self.store.lock().await;
        store[key] = value;
        let source = serde_json::to_string_pretty(&*store).map_err(|error| error.to_string())?;
        fs::write(&self.store_path, source).map_err(|error| format!("写入配置文件失败：{error}"))
    }

    pub fn cred_set(&self, env_id: &str, password: &str) -> Result<(), String> {
        credential(env_id)?
            .set_password(password)
            .map_err(|error| format!("保存到 Windows 凭据管理器失败：{error}"))
    }

    pub fn cred_get(&self, env_id: &str) -> Result<Option<String>, String> {
        match credential(env_id)?.get_password() {
            Ok(password) => Ok(Some(password)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(error.to_string()),
        }
    }

    pub fn cred_delete(&self, env_id: &str) -> Result<(), String> {
        match credential(env_id)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(error.to_string()),
        }
    }
}

fn validate_origin(origin: &str) -> Result<(), String> {
    let url = Url::parse(origin).map_err(|_| "环境地址格式无效".to_string())?;
    if matches!(url.scheme(), "http" | "https") && url.host_str().is_some() && url.path() == "/" {
        return Ok(());
    }
    Err("环境地址必须是 http/https origin，不能包含路径".to_string())
}

fn validate_path(path: &str) -> Result<(), String> {
    if path.starts_with('/') && !path.starts_with("//") {
        return Ok(());
    }
    Err("接口路径格式无效".to_string())
}

fn credential(env_id: &str) -> Result<keyring::Entry, String> {
    if env_id.trim().is_empty() {
        return Err("环境 ID 不能为空".to_string());
    }
    keyring::Entry::new(KEYRING_SERVICE, env_id).map_err(|error| error.to_string())
}

fn cookie_value(jar: &Jar, origin: &str, name: &str) -> String {
    let Ok(url) = origin.parse() else {
        return String::new();
    };
    let Some(header) = jar.cookies(&url) else {
        return String::new();
    };
    let Ok(source) = header.to_str() else {
        return String::new();
    };
    source
        .split(';')
        .map(str::trim)
        .find_map(|pair| pair.strip_prefix(&format!("{name}=")))
        .unwrap_or_default()
        .to_string()
}

async fn parse_response(response: reqwest::Response) -> Result<Value, String> {
    let status = response.status().as_u16();
    let text = response.text().await.map_err(|error| error.to_string())?;
    let value: Value = serde_json::from_str(&text).map_err(|_| {
        if text.to_lowercase().contains("<html") {
            "未登录或会话已过期，请重新登录".to_string()
        } else {
            format!("响应解析失败（HTTP {status}）")
        }
    })?;
    if value["status"] == json!(0) {
        return Ok(value["data"].clone());
    }
    let message = value["msg"].as_str().unwrap_or_default();
    if message.is_empty() {
        Err(format!("请求失败（status={}）", value["status"]))
    } else {
        Err(message.to_string())
    }
}
