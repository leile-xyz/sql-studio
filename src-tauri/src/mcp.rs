use std::sync::{Arc, RwLock};

use axum::{
    extract::{Query, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::post,
    Json, Router,
};
use rand::{distr::Alphanumeric, Rng};
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, State as TauriState};
use tokio::net::TcpListener;

const PROTOCOL_VERSION: &str = "2025-06-18";
const SERVER_NAME: &str = "sql-studio";
const MCP_PORT: u16 = 37625;
const MCP_PATH: &str = "/mcp";
const SQL_PATH: &str = "/sql";
const TOKEN_SERVICE: &str = "sql-studio-mcp";
const TOKEN_ACCOUNT: &str = "access-token";
const TOKEN_LENGTH: usize = 40;

#[derive(Clone)]
pub struct McpHost {
    status: Arc<RwLock<McpStatus>>,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpStatus {
    pub enabled: bool,
    pub running: bool,
    pub endpoint: String,
    pub streamable_http_url: String,
    pub sql_endpoint: String,
    pub json_config: Value,
    pub token: String,
    pub tools: Vec<String>,
    pub error: Option<String>,
}

#[derive(Clone)]
struct HttpState {
    app: AppHandle,
    status: Arc<RwLock<McpStatus>>,
}

#[derive(Deserialize)]
struct TokenQuery {
    token: Option<String>,
}

pub fn load_or_create_token() -> Result<String, String> {
    let entry = token_entry()?;
    match entry.get_password() {
        Ok(token) if !token.is_empty() => Ok(token),
        Ok(_) | Err(keyring::Error::NoEntry) => {
            let token = generate_token();
            entry
                .set_password(&token)
                .map_err(|error| format!("保存 MCP Access Token 失败：{error}"))?;
            Ok(token)
        }
        Err(error) => Err(format!("读取 MCP Access Token 失败：{error}")),
    }
}

pub fn start_host(app: AppHandle, token: String) -> McpHost {
    let status = Arc::new(RwLock::new(build_status(token.clone())));
    let host = McpHost {
        status: status.clone(),
    };
    std::thread::spawn(move || {
        let runtime = match tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
        {
            Ok(runtime) => runtime,
            Err(error) => {
                status.write().expect("MCP status lock").error = Some(error.to_string());
                return;
            }
        };
        runtime.block_on(async move {
            let listener = match TcpListener::bind(("127.0.0.1", MCP_PORT)).await {
                Ok(listener) => listener,
                Err(error) => {
                    status.write().expect("MCP status lock").error =
                        Some(format!("MCP 监听失败：{error}"));
                    return;
                }
            };
            status.write().expect("MCP status lock").running = true;
            let state = HttpState {
                app,
                status: status.clone(),
            };
            let router = Router::new()
                .route(MCP_PATH, post(mcp_request))
                .route(SQL_PATH, post(sql_request))
                .with_state(state);
            if let Err(error) = axum::serve(listener, router).await {
                status.write().expect("MCP status lock").error = Some(error.to_string());
            }
        });
    });
    host
}

fn build_status(token: String) -> McpStatus {
    let endpoint = format!("http://127.0.0.1:{MCP_PORT}{MCP_PATH}");
    let sql_endpoint = format!("http://127.0.0.1:{MCP_PORT}{SQL_PATH}");
    let streamable_http_url = format!("{endpoint}?token={token}");
    let json_config = json!({
        "mcpServers": {
            SERVER_NAME: {
                "type": "streamable-http",
                "url": streamable_http_url
            }
        }
    });
    McpStatus {
        enabled: true,
        running: false,
        endpoint,
        streamable_http_url,
        sql_endpoint,
        json_config,
        token,
        tools: crate::mcp_tools::names(),
        error: None,
    }
}

impl McpHost {
    pub fn status(&self) -> McpStatus {
        self.status.read().expect("MCP status lock").clone()
    }

    fn replace_token(&self, token: String) -> McpStatus {
        let previous = self.status();
        let mut status = build_status(token);
        status.running = previous.running;
        status.error = previous.error;
        *self.status.write().expect("MCP status lock") = status.clone();
        status
    }
}

#[tauri::command]
pub fn mcp_reset_token(host: TauriState<'_, McpHost>) -> Result<McpStatus, String> {
    let token = generate_token();
    token_entry()?
        .set_password(&token)
        .map_err(|error| format!("保存 MCP Access Token 失败：{error}"))?;
    Ok(host.replace_token(token))
}

fn token_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(TOKEN_SERVICE, TOKEN_ACCOUNT).map_err(|error| error.to_string())
}

fn generate_token() -> String {
    rand::rng()
        .sample_iter(&Alphanumeric)
        .take(TOKEN_LENGTH)
        .map(char::from)
        .collect()
}

async fn mcp_request(
    Query(query): Query<TokenQuery>,
    headers: HeaderMap,
    State(state): State<HttpState>,
    body: String,
) -> Response {
    if !token_matches(&state, request_token(&query, &headers)) {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({"error":"MCP token 无效"})),
        )
            .into_response();
    }
    match handle_line(Some(&state.app), &body).await {
        Some(response) => (StatusCode::OK, Json(response)).into_response(),
        None => StatusCode::ACCEPTED.into_response(),
    }
}

/// 本地 HTTP SQL 接口：请求体与 MCP 工具 execute_sql 的参数一致（camelCase），
/// 支持 `Authorization: Bearer <token>` 或 `?token=`。
/// 工具执行失败仍返回 200，用 ok=false 与 error 说明原因，与 MCP 侧一致。
async fn sql_request(
    Query(query): Query<TokenQuery>,
    headers: HeaderMap,
    State(state): State<HttpState>,
    body: String,
) -> Response {
    if !token_matches(&state, request_token(&query, &headers)) {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "ok": false, "error": "MCP token 无效" })),
        )
            .into_response();
    }
    let arguments = match parse_sql_body(&body) {
        Ok(value) => value,
        Err(error) => return bad_request(&error),
    };
    match crate::mcp_tools::execute_sql(&state.app, arguments).await {
        Ok(result) => (
            StatusCode::OK,
            Json(json!({ "ok": true, "result": result })),
        )
            .into_response(),
        Err(error) => {
            (StatusCode::OK, Json(json!({ "ok": false, "error": error }))).into_response()
        }
    }
}

fn bad_request(message: &str) -> Response {
    (
        StatusCode::BAD_REQUEST,
        Json(json!({ "ok": false, "error": message })),
    )
        .into_response()
}

/// `/sql` 请求体必须是 JSON 对象，字段与 MCP 工具 execute_sql 的参数一致。
fn parse_sql_body(body: &str) -> Result<Value, String> {
    match serde_json::from_str::<Value>(body) {
        Ok(value) if value.is_object() => Ok(value),
        Ok(_) => Err("请求体必须是 JSON 对象".to_string()),
        Err(error) => Err(format!("请求体 JSON 解析失败：{error}")),
    }
}

fn token_matches(state: &HttpState, token: Option<&str>) -> bool {
    let expected = state.status.read().expect("MCP status lock").token.clone();
    authorized(token, &expected)
}

/// token 优先取 Authorization 头，其次取 `?token=`（MCP 客户端配置沿用查询参数写法）。
fn request_token<'a>(query: &'a TokenQuery, headers: &'a HeaderMap) -> Option<&'a str> {
    bearer_token(headers).or(query.token.as_deref())
}

fn bearer_token(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(header::AUTHORIZATION)?
        .to_str()
        .ok()?
        .strip_prefix("Bearer ")
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

#[derive(Debug, Deserialize)]
struct RpcRequest {
    #[serde(default)]
    id: Option<Value>,
    method: String,
    #[serde(default)]
    params: Value,
}

async fn handle_line(app: Option<&AppHandle>, line: &str) -> Option<Value> {
    let request: RpcRequest = match serde_json::from_str(line) {
        Ok(request) => request,
        Err(error) => {
            return Some(rpc_error(
                Value::Null,
                -32700,
                &format!("JSON 解析失败：{error}"),
            ))
        }
    };
    let id = request.id?;
    Some(match request.method.as_str() {
        "initialize" => rpc_result(id, initialize_result()),
        "ping" => rpc_result(id, json!({})),
        "tools/list" => rpc_result(id, tools_result()),
        "tools/call" => handle_tool_call(app, id, request.params).await,
        _ => rpc_error(id, -32601, "不支持的 MCP 方法"),
    })
}

async fn handle_tool_call(app: Option<&AppHandle>, id: Value, params: Value) -> Value {
    let Some(name) = params.get("name").and_then(Value::as_str) else {
        return rpc_error(id, -32602, "缺少 MCP 工具名");
    };
    if !crate::mcp_tools::contains(name) {
        return rpc_error(id, -32602, "未知 MCP 工具");
    }
    let Some(app) = app else {
        return tool_error(id, "MCP 应用上下文不可用".into());
    };
    let arguments = params
        .get("arguments")
        .cloned()
        .unwrap_or_else(|| json!({}));
    match crate::mcp_tools::call(app, name, arguments).await {
        Ok(value) => match serde_json::to_string_pretty(&value) {
            Ok(text) => rpc_result(id, json!({ "content": [{ "type": "text", "text": text }] })),
            Err(error) => tool_error(id, format!("序列化工具结果失败：{error}")),
        },
        Err(error) => tool_error(id, error),
    }
}

fn initialize_result() -> Value {
    json!({
        "protocolVersion": PROTOCOL_VERSION,
        "capabilities": { "tools": {} },
        "serverInfo": { "name": SERVER_NAME, "version": env!("CARGO_PKG_VERSION") }
    })
}

fn tools_result() -> Value {
    crate::mcp_tools::definitions()
}

fn authorized(actual: Option<&str>, expected: &str) -> bool {
    actual == Some(expected)
}

fn rpc_result(id: Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn rpc_error(id: Value, code: i32, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

fn tool_error(id: Value, message: String) -> Value {
    rpc_result(
        id,
        json!({ "content": [{ "type": "text", "text": message }], "isError": true }),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn lists_all_resource_tools() {
        let response = handle_line(None, r#"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#)
            .await
            .unwrap();
        let tools = response["result"]["tools"].as_array().unwrap();
        assert_eq!(tools.len(), 6);
        assert_eq!(tools[0]["name"], crate::mcp_tools::LIST_ENVIRONMENTS);
        assert_eq!(tools[4]["name"], crate::mcp_tools::GET_TABLE_SCHEMA);
        assert_eq!(tools[5]["name"], crate::mcp_tools::EXECUTE_SQL);
    }

    #[tokio::test]
    async fn ignores_notifications() {
        assert!(handle_line(
            None,
            r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#
        )
        .await
        .is_none());
    }

    #[test]
    fn authorizes_only_current_token() {
        assert!(authorized(Some("current"), "current"));
        assert!(!authorized(Some("old"), "current"));
        assert!(!authorized(None, "current"));
    }

    #[test]
    fn status_exposes_streamable_http_connection_config() {
        let status = serde_json::to_value(build_status("test-token".into())).unwrap();
        let expected_url = "http://127.0.0.1:37625/mcp?token=test-token";

        assert_eq!(status["streamableHttpUrl"], expected_url);
        assert_eq!(status["sqlEndpoint"], "http://127.0.0.1:37625/sql");
        assert_eq!(
            status["jsonConfig"]["mcpServers"][SERVER_NAME]["type"],
            "streamable-http"
        );
        assert_eq!(
            status["jsonConfig"]["mcpServers"][SERVER_NAME]["url"],
            expected_url
        );
    }

    #[test]
    fn rejects_sql_body_that_is_not_json_object() {
        assert!(parse_sql_body("[]").is_err());
        assert!(parse_sql_body("").is_err());
        assert!(parse_sql_body(r#"{"envId":"pre"}"#).is_ok());
        assert_eq!(bad_request("bad").status(), StatusCode::BAD_REQUEST);
    }

    #[test]
    fn accepts_token_from_header_or_query() {
        let mut headers = HeaderMap::new();
        let from_query = TokenQuery {
            token: Some("query-token".into()),
        };
        assert_eq!(request_token(&from_query, &headers), Some("query-token"));

        headers.insert(
            header::AUTHORIZATION,
            "Bearer header-token".parse().unwrap(),
        );
        assert_eq!(request_token(&from_query, &headers), Some("header-token"));
        assert_eq!(
            request_token(&TokenQuery { token: None }, &headers),
            Some("header-token")
        );

        headers.insert(header::AUTHORIZATION, "Basic abc".parse().unwrap());
        assert_eq!(request_token(&from_query, &headers), Some("query-token"));
        assert_eq!(request_token(&TokenQuery { token: None }, &headers), None);

        headers.insert(header::AUTHORIZATION, "Bearer   ".parse().unwrap());
        assert_eq!(request_token(&TokenQuery { token: None }, &headers), None);
    }

    #[test]
    fn replacing_token_updates_auth_and_connection_config() {
        let host = McpHost {
            status: Arc::new(RwLock::new(build_status("old-token".into()))),
        };
        let status = host.replace_token("new-token".into());
        assert_eq!(status.token, "new-token");
        assert!(status.streamable_http_url.ends_with("token=new-token"));
        assert_eq!(host.status().token, "new-token");
    }

    #[test]
    fn generated_tokens_have_fixed_length() {
        assert_eq!(generate_token().len(), TOKEN_LENGTH);
    }
}
