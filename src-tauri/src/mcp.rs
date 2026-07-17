use std::sync::{Arc, RwLock};

use axum::{
    extract::{Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::post,
    Json, Router,
};
use rand::{distr::Alphanumeric, Rng};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::net::TcpListener;

use crate::archery::{ArcheryService, DescribeTableRequest, SessionContext};

const PROTOCOL_VERSION: &str = "2025-06-18";
const SERVER_NAME: &str = "sql-studio";
const TOOL_NAME: &str = "get_table_schema";
const MCP_PORT: u16 = 37625;

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
    pub json_config: Value,
    pub token: String,
    pub tools: Vec<String>,
    pub error: Option<String>,
}

#[derive(Clone)]
struct HttpState {
    service: Arc<ArcheryService>,
    token: Arc<str>,
}

#[derive(Deserialize)]
struct TokenQuery {
    token: Option<String>,
}

pub fn start_host() -> McpHost {
    let token: String = rand::rng()
        .sample_iter(&Alphanumeric)
        .take(40)
        .map(char::from)
        .collect();
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
                service: Arc::new(ArcheryService::default()),
                token: token.into(),
            };
            let router = Router::new()
                .route("/mcp", post(mcp_request))
                .with_state(state);
            if let Err(error) = axum::serve(listener, router).await {
                status.write().expect("MCP status lock").error = Some(error.to_string());
            }
        });
    });
    host
}

fn build_status(token: String) -> McpStatus {
    let endpoint = format!("http://127.0.0.1:{MCP_PORT}/mcp");
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
        json_config,
        token,
        tools: vec![TOOL_NAME.into()],
        error: None,
    }
}

impl McpHost {
    pub fn status(&self) -> McpStatus {
        self.status.read().expect("MCP status lock").clone()
    }
}

async fn mcp_request(
    Query(query): Query<TokenQuery>,
    State(state): State<HttpState>,
    body: String,
) -> Response {
    if query.token.as_deref() != Some(state.token.as_ref()) {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({"error":"MCP token 无效"})),
        )
            .into_response();
    }
    match handle_line(&state.service, &body).await {
        Some(response) => (StatusCode::OK, Json(response)).into_response(),
        None => StatusCode::ACCEPTED.into_response(),
    }
}

#[derive(Debug, Deserialize)]
struct RpcRequest {
    #[serde(default)]
    id: Option<Value>,
    method: String,
    #[serde(default)]
    params: Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ToolArguments {
    env_id: String,
    origin: String,
    username: String,
    password: String,
    instance_name: String,
    database_name: String,
    #[serde(default)]
    schema_name: Option<String>,
    table_name: String,
}

async fn handle_line(service: &ArcheryService, line: &str) -> Option<Value> {
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
        "tools/call" => handle_tool_call(service, id, request.params).await,
        _ => rpc_error(id, -32601, "不支持的 MCP 方法"),
    })
}

async fn handle_tool_call(service: &ArcheryService, id: Value, params: Value) -> Value {
    if params.get("name").and_then(Value::as_str) != Some(TOOL_NAME) {
        return rpc_error(id, -32602, "未知 MCP 工具");
    }
    let arguments: ToolArguments = match serde_json::from_value(params["arguments"].clone()) {
        Ok(arguments) => arguments,
        Err(error) => return tool_error(id, format!("工具参数无效：{error}")),
    };
    let context = SessionContext::new(arguments.env_id, arguments.username, arguments.origin);
    if let Err(error) = service.login(&context, &arguments.password).await {
        return tool_error(id, error);
    }
    let request = DescribeTableRequest {
        instance_name: arguments.instance_name,
        database_name: arguments.database_name,
        schema_name: arguments.schema_name,
        table_name: arguments.table_name,
    };
    match service.describe_table(&context, &request).await {
        Ok(schema) => rpc_result(
            id,
            json!({ "content": [{ "type": "text", "text": schema.to_string() }] }),
        ),
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
    json!({ "tools": [{
        "name": TOOL_NAME,
        "description": "通过 Archery 查询指定数据库表的字段、索引和 DDL 结构",
        "inputSchema": {
            "type": "object",
            "properties": {
                "envId": { "type": "string", "description": "SQL Studio 环境标识" },
                "origin": { "type": "string", "description": "Archery 地址，如 https://archery.example.com" },
                "username": { "type": "string" },
                "password": { "type": "string" },
                "instanceName": { "type": "string", "description": "Archery 实例名" },
                "databaseName": { "type": "string" },
                "schemaName": { "type": "string", "description": "PostgreSQL schema；MySQL 可省略" },
                "tableName": { "type": "string" }
            },
            "required": ["envId", "origin", "username", "password", "instanceName", "databaseName", "tableName"],
            "additionalProperties": false
        }
    }] })
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
    async fn lists_table_schema_tool() {
        let response = handle_line(
            &ArcheryService::default(),
            r#"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#,
        )
        .await
        .unwrap();
        assert_eq!(response["result"]["tools"][0]["name"], TOOL_NAME);
    }

    #[tokio::test]
    async fn ignores_notifications() {
        assert!(handle_line(
            &ArcheryService::default(),
            r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#
        )
        .await
        .is_none());
    }

    #[tokio::test]
    async fn returns_accepted_for_streamable_http_notifications() {
        let state = HttpState {
            service: Arc::new(ArcheryService::default()),
            token: "test-token".into(),
        };
        let response = mcp_request(
            Query(TokenQuery {
                token: Some("test-token".into()),
            }),
            State(state),
            r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#.into(),
        )
        .await;

        assert_eq!(response.status(), StatusCode::ACCEPTED);
    }

    #[test]
    fn status_exposes_streamable_http_connection_config() {
        let status = serde_json::to_value(build_status("test-token".into())).unwrap();
        let expected_url = "http://127.0.0.1:37625/mcp?token=test-token";

        assert_eq!(status["streamableHttpUrl"], expected_url);
        assert_eq!(
            status["jsonConfig"]["mcpServers"][SERVER_NAME]["type"],
            "streamable-http"
        );
        assert_eq!(
            status["jsonConfig"]["mcpServers"][SERVER_NAME]["url"],
            expected_url
        );
    }
}
