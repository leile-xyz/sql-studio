use std::{
    collections::HashMap,
    net::{IpAddr, Ipv4Addr, SocketAddr},
    sync::Arc,
};

use axum::{
    body::Body,
    extract::{Path, State},
    http::{header, HeaderMap, Response, StatusCode},
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use rand::{distr::Alphanumeric, Rng};
use rust_embed::RustEmbed;
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::{net::TcpListener, sync::watch};

use crate::services::AppServices;

const TOKEN_HEADER: &str = "x-sql-studio-token";

#[derive(RustEmbed)]
#[folder = "../src/"]
struct Assets;

#[derive(Clone)]
struct ServerState {
    services: Arc<AppServices>,
    token: Arc<str>,
    shutdown: ShutdownHandle,
}

#[derive(Clone)]
pub struct ShutdownHandle(watch::Sender<bool>);

impl ShutdownHandle {
    pub fn request(&self) -> Result<(), String> {
        self.0.send(true).map_err(|error| error.to_string())
    }
}

#[derive(Deserialize)]
#[serde(tag = "command", content = "args", rename_all = "snake_case")]
enum CommandRequest {
    Login {
        origin: String,
        username: String,
        password: String,
    },
    ApiGet {
        origin: String,
        path: String,
    },
    ApiPost {
        origin: String,
        path: String,
        form: HashMap<String, String>,
    },
    KvGet {
        key: String,
    },
    KvSet {
        key: String,
        value: Value,
    },
    CredGet {
        env_id: String,
    },
    CredSet {
        env_id: String,
        password: String,
    },
    CredDelete {
        env_id: String,
    },
    AppVersion,
    Exit {},
}

pub struct RunningServer {
    pub url: String,
    listener: TcpListener,
    router: Router,
    shutdown: watch::Receiver<bool>,
    shutdown_handle: ShutdownHandle,
}

impl RunningServer {
    pub async fn bind(services: AppServices) -> Result<Self, String> {
        let listener = TcpListener::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0))
            .await
            .map_err(|error| format!("本地服务监听失败：{error}"))?;
        let address = listener.local_addr().map_err(|error| error.to_string())?;
        let token: String = rand::rng()
            .sample_iter(&Alphanumeric)
            .take(48)
            .map(char::from)
            .collect();
        let (shutdown_tx, shutdown_rx) = watch::channel(false);
        let shutdown_handle = ShutdownHandle(shutdown_tx);
        let state = ServerState {
            services: Arc::new(services),
            token: token.clone().into(),
            shutdown: shutdown_handle.clone(),
        };
        let router = Router::new()
            .route("/api/command", post(command))
            .route("/", get(index))
            .route("/{*path}", get(asset))
            .with_state(state);
        Ok(Self {
            url: format!("http://{address}/?token={token}"),
            listener,
            router,
            shutdown: shutdown_rx,
            shutdown_handle,
        })
    }

    pub fn shutdown_handle(&self) -> ShutdownHandle {
        self.shutdown_handle.clone()
    }

    pub async fn serve(self) -> Result<(), String> {
        let mut shutdown = self.shutdown.clone();
        axum::serve(self.listener, self.router)
            .with_graceful_shutdown(async move {
                while !*shutdown.borrow() {
                    if shutdown.changed().await.is_err() {
                        break;
                    }
                }
            })
            .await
            .map_err(|error| format!("本地服务异常退出：{error}"))
    }
}

async fn command(
    State(state): State<ServerState>,
    headers: HeaderMap,
    Json(request): Json<CommandRequest>,
) -> impl IntoResponse {
    if !authorized(&headers, &state.token) {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({"ok": false, "error": "未授权的本地请求"})),
        );
    }
    let result = execute(&state, request).await;
    match result {
        Ok(value) => (StatusCode::OK, Json(json!({"ok": true, "value": value}))),
        Err(error) => (
            StatusCode::BAD_REQUEST,
            Json(json!({"ok": false, "error": error})),
        ),
    }
}

async fn execute(state: &ServerState, request: CommandRequest) -> Result<Value, String> {
    let services = &state.services;
    match request {
        CommandRequest::Login {
            origin,
            username,
            password,
        } => {
            services.login(&origin, &username, &password).await?;
            Ok(Value::Null)
        }
        CommandRequest::ApiGet { origin, path } => services.api_get(&origin, &path).await,
        CommandRequest::ApiPost { origin, path, form } => {
            services.api_post(&origin, &path, &form).await
        }
        CommandRequest::KvGet { key } => Ok(services.kv_get(&key).await),
        CommandRequest::KvSet { key, value } => {
            services.kv_set(&key, value).await?;
            Ok(Value::Null)
        }
        CommandRequest::CredGet { env_id } => Ok(json!(services.cred_get(&env_id)?)),
        CommandRequest::CredSet { env_id, password } => {
            services.cred_set(&env_id, &password)?;
            Ok(Value::Null)
        }
        CommandRequest::CredDelete { env_id } => {
            services.cred_delete(&env_id)?;
            Ok(Value::Null)
        }
        CommandRequest::AppVersion => Ok(json!(env!("CARGO_PKG_VERSION"))),
        CommandRequest::Exit {} => {
            state.shutdown.request()?;
            Ok(Value::Null)
        }
    }
}

fn authorized(headers: &HeaderMap, expected: &str) -> bool {
    headers
        .get(TOKEN_HEADER)
        .and_then(|value| value.to_str().ok())
        == Some(expected)
}

async fn index() -> Response<Body> {
    asset_response("index.html")
}

async fn asset(Path(path): Path<String>) -> Response<Body> {
    asset_response(path.trim_start_matches('/'))
}

fn asset_response(path: &str) -> Response<Body> {
    let Some(asset) = Assets::get(path) else {
        return response(
            StatusCode::NOT_FOUND,
            "text/plain; charset=utf-8",
            Body::from("Not Found"),
        );
    };
    let mime = mime_guess::from_path(path)
        .first_or_octet_stream()
        .to_string();
    response(StatusCode::OK, &mime, Body::from(asset.data.into_owned()))
}

fn response(status: StatusCode, content_type: &str, body: Body) -> Response<Body> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, content_type)
        .header(header::CACHE_CONTROL, "no-store")
        .header("X-Content-Type-Options", "nosniff")
        .body(body)
        .expect("valid HTTP response")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_missing_token() {
        assert!(!authorized(&HeaderMap::new(), "secret"));
    }

    #[test]
    fn embedded_index_exists() {
        assert!(Assets::get("index.html").is_some());
    }
}
