use std::{collections::HashMap, sync::Arc};

use reqwest::{
    cookie::{CookieStore, Jar},
    Client, Url,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::State;
use tokio::sync::Mutex;

const USER_AGENT: &str = "Mozilla/5.0 (SQL Studio Desktop)";
const NETWORK_ERROR: &str = "网络请求失败，请检查是否连入内网 / 域名是否可达";
pub(crate) const DEFAULT_QUERY_LIMIT: u32 = 100;

#[derive(Clone, Debug, Deserialize, Eq, Hash, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionContext {
    env_id: String,
    username: String,
    origin: String,
}

impl SessionContext {
    pub(crate) fn new(env_id: String, username: String, origin: String) -> Self {
        Self {
            env_id,
            username,
            origin,
        }
    }

    pub(crate) fn environment_id(&self) -> &str {
        &self.env_id
    }
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct ArcheryQueryRequest {
    pub instance_name: String,
    pub database_name: String,
    pub schema_name: Option<String>,
    pub sql: String,
    pub limit: u32,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ArcheryQueryResult {
    pub columns: Vec<String>,
    pub column_types: Vec<Value>,
    pub rows: Vec<Vec<Value>>,
    pub elapsed_seconds: f64,
    pub affected_rows: Option<i64>,
    pub full_sql: String,
    pub is_masked: bool,
}

#[derive(Deserialize)]
struct RawQueryResult {
    #[serde(default)]
    column_list: Vec<String>,
    #[serde(default)]
    column_type: Vec<Value>,
    #[serde(default)]
    rows: Vec<Vec<Value>>,
    #[serde(default)]
    query_time: f64,
    affected_rows: Option<i64>,
    full_sql: Option<String>,
    #[serde(default)]
    is_masked: bool,
    error: Option<String>,
}

struct SessionClient {
    client: Client,
    jar: Arc<Jar>,
}

#[derive(Default)]
pub struct ArcheryService(Mutex<HashMap<SessionContext, Arc<SessionClient>>>);

impl ArcheryService {
    async fn client(&self, context: &SessionContext) -> Result<Arc<SessionClient>, String> {
        let context = validate_context(context)?;
        let mut sessions = self.0.lock().await;
        if let Some(client) = sessions.get(&context) {
            return Ok(client.clone());
        }
        let client = Arc::new(build_client()?);
        sessions.insert(context, client.clone());
        Ok(client)
    }

    pub(crate) async fn login(
        &self,
        context: &SessionContext,
        password: &str,
    ) -> Result<(), String> {
        let context = validate_context(context)?;
        let candidate = build_client()?;
        fetch_login_page(&candidate, &context.origin).await?;
        authenticate(&candidate, &context, password).await?;
        self.0.lock().await.insert(context, Arc::new(candidate));
        Ok(())
    }

    async fn get(&self, context: &SessionContext, path: &str) -> Result<Value, String> {
        validate_path(path)?;
        let context = validate_context(context)?;
        let session = self.client(&context).await?;
        let response = session
            .client
            .get(format!("{}{path}", context.origin))
            .header("X-Requested-With", "XMLHttpRequest")
            .header("Accept", "application/json, text/javascript, */*; q=0.01")
            .send()
            .await
            .map_err(|_| NETWORK_ERROR.to_string())?;
        parse_response(response).await
    }

    async fn post(
        &self,
        context: &SessionContext,
        path: &str,
        form: &HashMap<String, String>,
    ) -> Result<Value, String> {
        validate_path(path)?;
        let context = validate_context(context)?;
        let session = self.client(&context).await?;
        let token = cookie_value(&session.jar, &context.origin, "csrftoken");
        let response = session
            .client
            .post(format!("{}{path}", context.origin))
            .header("X-CSRFToken", token)
            .header("X-Requested-With", "XMLHttpRequest")
            .header("Origin", &context.origin)
            .header("Referer", format!("{}/sqlquery/", context.origin))
            .form(form)
            .send()
            .await
            .map_err(|_| NETWORK_ERROR.to_string())?;
        parse_response(response).await
    }

    pub(crate) async fn execute_sql(
        &self,
        context: &SessionContext,
        request: &ArcheryQueryRequest,
    ) -> Result<ArcheryQueryResult, String> {
        let data = self.post(context, "/query/", &query_form(request)).await?;
        normalize_query_result(data, &request.sql)
    }
}

fn query_form(request: &ArcheryQueryRequest) -> HashMap<String, String> {
    HashMap::from([
        ("instance_name".into(), request.instance_name.clone()),
        ("db_name".into(), request.database_name.clone()),
        (
            "schema_name".into(),
            request.schema_name.clone().unwrap_or_default(),
        ),
        ("tb_name".into(), String::new()),
        ("sql_content".into(), request.sql.clone()),
        ("limit_num".into(), request.limit.to_string()),
    ])
}

fn normalize_query_result(data: Value, requested_sql: &str) -> Result<ArcheryQueryResult, String> {
    let raw: RawQueryResult =
        serde_json::from_value(data).map_err(|error| format!("SQL 响应结构无效：{error}"))?;
    if let Some(error) = raw
        .error
        .as_deref()
        .filter(|message| !message.trim().is_empty())
    {
        return Err(error.to_string());
    }
    validate_query_shape(&raw)?;
    Ok(ArcheryQueryResult {
        columns: raw.column_list,
        column_types: raw.column_type,
        rows: raw.rows,
        elapsed_seconds: raw.query_time,
        affected_rows: raw.affected_rows,
        full_sql: raw.full_sql.unwrap_or_else(|| requested_sql.to_string()),
        is_masked: raw.is_masked,
    })
}

fn validate_query_shape(result: &RawQueryResult) -> Result<(), String> {
    if result.column_list.is_empty() && !result.rows.is_empty() {
        return Err("SQL 响应包含数据行但缺少列定义".into());
    }
    if result
        .rows
        .iter()
        .any(|row| row.len() != result.column_list.len())
    {
        return Err("SQL 响应的数据行与列定义数量不一致".into());
    }
    if !result.column_type.is_empty() && result.column_type.len() != result.column_list.len() {
        return Err("SQL 响应的列类型与列定义数量不一致".into());
    }
    Ok(())
}

fn build_client() -> Result<SessionClient, String> {
    let jar = Arc::new(Jar::default());
    let client = Client::builder()
        .cookie_provider(jar.clone())
        .user_agent(USER_AGENT)
        .no_proxy()
        .danger_accept_invalid_certs(true)
        .build()
        .map_err(|error| error.to_string())?;
    Ok(SessionClient { client, jar })
}

async fn fetch_login_page(session: &SessionClient, origin: &str) -> Result<(), String> {
    session
        .client
        .get(format!("{origin}/login/"))
        .send()
        .await
        .map_err(|_| NETWORK_ERROR.to_string())?
        .error_for_status()
        .map_err(|error| format!("获取登录页面失败：{error}"))?;
    Ok(())
}

async fn authenticate(
    session: &SessionClient,
    context: &SessionContext,
    password: &str,
) -> Result<(), String> {
    let token = cookie_value(&session.jar, &context.origin, "csrftoken");
    if token.is_empty() {
        return Err("登录页面未返回 CSRF Token".into());
    }
    let response = session
        .client
        .post(format!("{}/authenticate/", context.origin))
        .header("X-CSRFToken", token)
        .header("X-Requested-With", "XMLHttpRequest")
        .header("Origin", &context.origin)
        .header("Referer", format!("{}/login/", context.origin))
        .form(&[
            ("username", context.username.as_str()),
            ("password", password),
        ])
        .send()
        .await
        .map_err(|_| NETWORK_ERROR.to_string())?;
    let status = response.status().as_u16();
    let body = response.text().await.map_err(|error| error.to_string())?;
    let value: Value =
        serde_json::from_str(&body).map_err(|_| format!("登录响应异常（HTTP {status}）"))?;
    if value["status"] == json!(0) {
        return Ok(());
    }
    Err(value["msg"]
        .as_str()
        .unwrap_or("用户名或密码错误")
        .to_string())
}

async fn parse_response(response: reqwest::Response) -> Result<Value, String> {
    let status = response.status().as_u16();
    let body = response.text().await.map_err(|error| error.to_string())?;
    let value: Value = serde_json::from_str(&body).map_err(|_| {
        if body.to_ascii_lowercase().contains("<html") {
            "未登录或会话已过期，请重新登录".to_string()
        } else {
            format!("响应解析失败（HTTP {status}）")
        }
    })?;
    if value["status"] == json!(0) {
        return Ok(value["data"].clone());
    }
    let message = value["msg"].as_str().unwrap_or("");
    Err(if message.is_empty() {
        format!("请求失败（status={}）", value["status"])
    } else {
        message.to_string()
    })
}

fn validate_context(context: &SessionContext) -> Result<SessionContext, String> {
    if context.env_id.trim().is_empty() || context.username.trim().is_empty() {
        return Err("Archery 会话缺少环境或用户名".into());
    }
    let origin = context.origin.trim_end_matches('/');
    let url = Url::parse(origin).map_err(|_| "Archery 地址格式无效".to_string())?;
    if !matches!(url.scheme(), "http" | "https")
        || url.username() != ""
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/"
    {
        return Err("Archery 地址必须是无路径、查询和认证信息的 HTTP(S) Origin".into());
    }
    Ok(SessionContext {
        env_id: context.env_id.clone(),
        username: context.username.clone(),
        origin: origin.to_string(),
    })
}

fn validate_path(path: &str) -> Result<(), String> {
    if !path.starts_with('/') || path.starts_with("//") || Url::parse(path).is_ok() {
        return Err("Archery API 路径必须是站内绝对路径".into());
    }
    Ok(())
}

fn cookie_value(jar: &Jar, origin: &str, name: &str) -> String {
    let Ok(url) = origin.parse() else {
        return String::new();
    };
    let Some(header) = jar.cookies(&url) else {
        return String::new();
    };
    let Ok(cookies) = header.to_str() else {
        return String::new();
    };
    cookies
        .split(';')
        .map(str::trim)
        .find_map(|pair| pair.strip_prefix(&format!("{name}=")).map(str::to_string))
        .unwrap_or_default()
}

#[tauri::command]
pub async fn login(
    service: State<'_, ArcheryService>,
    session: SessionContext,
    password: String,
) -> Result<(), String> {
    service.login(&session, &password).await
}

#[tauri::command]
pub async fn api_get(
    service: State<'_, ArcheryService>,
    session: SessionContext,
    path: String,
) -> Result<Value, String> {
    service.get(&session, &path).await
}

#[tauri::command]
pub async fn api_post(
    service: State<'_, ArcheryService>,
    session: SessionContext,
    path: String,
    form: HashMap<String, String>,
) -> Result<Value, String> {
    service.post(&session, &path, &form).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn context(origin: &str) -> SessionContext {
        SessionContext {
            env_id: "env-a".into(),
            username: "admin".into(),
            origin: origin.into(),
        }
    }

    #[test]
    fn normalizes_and_separates_session_identity() {
        let first = validate_context(&context("https://archery.example.com/")).unwrap();
        let mut second = first.clone();
        second.username = "other".into();
        assert_eq!(first.origin, "https://archery.example.com");
        assert_ne!(first, second);
    }

    #[test]
    fn rejects_unsafe_origins_and_paths() {
        assert!(validate_context(&context("https://user:pass@example.com/path")).is_err());
        assert!(validate_path("https://evil.example.com/api").is_err());
        assert!(validate_path("//evil.example.com/api").is_err());
    }

    #[test]
    fn normalizes_query_response_and_preserves_server_sql() {
        let result = normalize_query_result(
            json!({
                "column_list": ["id"],
                "column_type": ["BIGINT"],
                "rows": [[1]],
                "query_time": 0.25,
                "affected_rows": 0,
                "full_sql": "SELECT id FROM users LIMIT 100",
                "is_masked": true
            }),
            "SELECT id FROM users",
        )
        .unwrap();
        assert_eq!(result.columns, vec!["id"]);
        assert_eq!(result.rows, vec![vec![json!(1)]]);
        assert_eq!(result.full_sql, "SELECT id FROM users LIMIT 100");
        assert!(result.is_masked);
    }

    #[test]
    fn rejects_invalid_query_shapes_and_explicit_errors() {
        let invalid = json!({ "rows": [[1]] });
        assert!(normalize_query_result(invalid, "SELECT 1").is_err());
        assert_eq!(
            normalize_query_result(json!({ "error": "syntax error" }), "bad sql").unwrap_err(),
            "syntax error"
        );
    }
}
