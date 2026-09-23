// 环境与会话解析：按 envId 复用进程内已有会话，或用已保存凭据登录。
// MCP 工具与本地 HTTP SQL 接口共用这套逻辑，因此可以操作与界面当前环境不同的环境。
// 凭据只从本地 KV 与 Windows 凭据管理器读取，不接受调用方传入账号密码。

use serde_json::Value;
use tauri::{AppHandle, Manager};

use crate::{
    archery::{ArcheryService, SessionContext},
    Kv,
};

const MISSING_USERNAME: &str = "该环境尚未保存登录用户名";
const MISSING_PASSWORD: &str = "该环境当前未登录且未保存密码，请先在 SQL Studio 登录并勾选记住密码";

pub(crate) struct EnvironmentIdentity {
    pub(crate) session: SessionContext,
    pub(crate) password: Option<String>,
}

/// 读取环境与凭据：地址来自 KV 的 sqls_envs，密码只在 remember=true 时从凭据管理器取。
pub(crate) async fn resolve_identity(
    app: &AppHandle,
    env_id: &str,
) -> Result<EnvironmentIdentity, String> {
    let kv = app.state::<Kv>();
    let data = kv.data.lock().await;
    let environment = find_environment(&data, env_id)?;
    let origin = environment_origin(environment)?;
    let credential = data
        .get("sqls_creds")
        .and_then(Value::as_object)
        .and_then(|items| items.get(env_id))
        .ok_or(MISSING_USERNAME)?;
    let username = required_string(credential, "user", MISSING_USERNAME)?;
    let remember = credential.get("remember").and_then(Value::as_bool) == Some(true);
    drop(data);
    let password = if remember {
        crate::cred_get(env_id.to_string())?.filter(|value| !value.is_empty())
    } else {
        None
    };
    Ok(EnvironmentIdentity {
        session: SessionContext::new(env_id.into(), username, origin),
        password,
    })
}

/// 可直接发请求的会话：优先复用进程内已建立的会话（界面停在别的环境同样可用），
/// 没有会话时用已保存凭据登录。
pub(crate) async fn ensure_session(
    app: &AppHandle,
    env_id: &str,
) -> Result<SessionContext, String> {
    let identity = resolve_identity(app, env_id).await?;
    let service = app.state::<ArcheryService>();
    if service.has_session(&identity.session).await {
        return Ok(identity.session);
    }
    let password = identity
        .password
        .ok_or_else(|| MISSING_PASSWORD.to_string())?;
    service.login(&identity.session, &password).await?;
    Ok(identity.session)
}

/// 会话被 Archery 判定失效后重新登录一次，只使用已保存凭据。
pub(crate) async fn relogin(app: &AppHandle, env_id: &str) -> Result<(), String> {
    let identity = resolve_identity(app, env_id).await?;
    let password = identity
        .password
        .ok_or_else(|| MISSING_PASSWORD.to_string())?;
    app.state::<ArcheryService>()
        .login(&identity.session, &password)
        .await
}

pub(crate) fn find_environment<'a>(data: &'a Value, env_id: &str) -> Result<&'a Value, String> {
    data.get("sqls_envs")
        .and_then(Value::as_array)
        .and_then(|items| {
            items
                .iter()
                .find(|item| item.get("id").and_then(Value::as_str) == Some(env_id))
        })
        .ok_or_else(|| format!("环境不存在：{env_id}"))
}

pub(crate) fn environment_origin(environment: &Value) -> Result<String, String> {
    let base = required_string(environment, "base", "环境地址无效")?;
    let scheme = environment
        .get("scheme")
        .and_then(Value::as_str)
        .unwrap_or("http");
    Ok(format!("{scheme}://{base}"))
}

pub(crate) fn required_string(value: &Value, key: &str, error: &str) -> Result<String, String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|text| !text.trim().is_empty())
        .map(str::to_string)
        .ok_or_else(|| error.to_string())
}
