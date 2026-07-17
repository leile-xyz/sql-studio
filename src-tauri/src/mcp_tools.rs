use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::{
    archery::{ArcheryService, DescribeTableRequest, SessionContext},
    Kv,
};

pub(crate) const LIST_ENVIRONMENTS: &str = "list_environments";
pub(crate) const LIST_INSTANCES: &str = "list_instances";
pub(crate) const LIST_DATABASES: &str = "list_databases";
pub(crate) const LIST_TABLES: &str = "list_tables";
pub(crate) const GET_TABLE_SCHEMA: &str = "get_table_schema";

const TOOL_NAMES: [&str; 5] = [
    LIST_ENVIRONMENTS,
    LIST_INSTANCES,
    LIST_DATABASES,
    LIST_TABLES,
    GET_TABLE_SCHEMA,
];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EnvironmentSummary {
    id: String,
    name: String,
    origin: String,
    color: Option<String>,
}

struct EnvironmentIdentity {
    session: SessionContext,
    password: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EnvironmentArguments {
    env_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DatabaseArguments {
    env_id: String,
    instance_name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TableArguments {
    env_id: String,
    instance_name: String,
    database_name: String,
    #[serde(default)]
    schema_name: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SchemaArguments {
    env_id: String,
    instance_name: String,
    database_name: String,
    #[serde(default)]
    schema_name: Option<String>,
    table_name: String,
}

pub(crate) fn names() -> Vec<String> {
    TOOL_NAMES.iter().map(|name| (*name).into()).collect()
}

pub(crate) fn contains(name: &str) -> bool {
    TOOL_NAMES.contains(&name)
}

pub(crate) fn definitions() -> Value {
    json!({ "tools": [
        tool(LIST_ENVIRONMENTS, "返回 SQL Studio 已配置的环境", json!({})),
        tool(LIST_INSTANCES, "返回指定环境可访问的 Archery 实例", environment_schema()),
        tool(LIST_DATABASES, "返回指定实例的数据库", database_schema()),
        tool(LIST_TABLES, "返回指定数据库或 schema 的数据表", table_schema()),
        tool(GET_TABLE_SCHEMA, "返回指定数据表的字段、索引和 DDL 结构", schema_schema())
    ] })
}

pub(crate) async fn call(app: &AppHandle, name: &str, arguments: Value) -> Result<Value, String> {
    match name {
        LIST_ENVIRONMENTS => Ok(json!(list_environments(app).await?)),
        LIST_INSTANCES => {
            let input: EnvironmentArguments = parse(arguments)?;
            let session = ensure_session(app, &input.env_id).await?;
            app.state::<ArcheryService>().list_instances(&session).await
        }
        LIST_DATABASES => {
            let input: DatabaseArguments = parse(arguments)?;
            let session = ensure_session(app, &input.env_id).await?;
            app.state::<ArcheryService>()
                .list_databases(&session, &input.instance_name)
                .await
        }
        LIST_TABLES => list_tables(app, parse(arguments)?).await,
        GET_TABLE_SCHEMA => get_table_schema(app, parse(arguments)?).await,
        _ => Err("未知 MCP 工具".into()),
    }
}

async fn list_tables(app: &AppHandle, input: TableArguments) -> Result<Value, String> {
    let session = ensure_session(app, &input.env_id).await?;
    app.state::<ArcheryService>()
        .list_tables(
            &session,
            &input.instance_name,
            &input.database_name,
            input.schema_name.as_deref(),
        )
        .await
}

async fn get_table_schema(app: &AppHandle, input: SchemaArguments) -> Result<Value, String> {
    let session = ensure_session(app, &input.env_id).await?;
    let request = DescribeTableRequest {
        instance_name: input.instance_name,
        database_name: input.database_name,
        schema_name: input.schema_name,
        table_name: input.table_name,
    };
    app.state::<ArcheryService>()
        .describe_table(&session, &request)
        .await
}

async fn ensure_session(app: &AppHandle, env_id: &str) -> Result<SessionContext, String> {
    let identity = resolve_identity(app, env_id).await?;
    let service = app.state::<ArcheryService>();
    if service.has_session(&identity.session).await {
        return Ok(identity.session);
    }
    let password = identity.password.ok_or_else(|| {
        "该环境当前未登录且未保存密码，请先在 SQL Studio 登录并勾选记住密码".to_string()
    })?;
    service.login(&identity.session, &password).await?;
    Ok(identity.session)
}

async fn resolve_identity(app: &AppHandle, env_id: &str) -> Result<EnvironmentIdentity, String> {
    let kv = app.state::<Kv>();
    let data = kv.data.lock().await;
    let environment = find_environment(&data, env_id)?;
    let origin = environment_origin(environment)?;
    let credential = data
        .get("sqls_creds")
        .and_then(Value::as_object)
        .and_then(|items| items.get(env_id))
        .ok_or("该环境尚未保存登录用户名")?;
    let username = required_string(credential, "user", "该环境尚未保存登录用户名")?;
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

async fn list_environments(app: &AppHandle) -> Result<Vec<EnvironmentSummary>, String> {
    let kv = app.state::<Kv>();
    let data = kv.data.lock().await;
    data.get("sqls_envs")
        .and_then(Value::as_array)
        .ok_or_else(|| "尚未配置 SQL Studio 环境".to_string())?
        .iter()
        .map(environment_summary)
        .collect()
}

fn environment_summary(value: &Value) -> Result<EnvironmentSummary, String> {
    Ok(EnvironmentSummary {
        id: required_string(value, "id", "环境缺少 id")?,
        name: required_string(value, "name", "环境缺少名称")?,
        origin: environment_origin(value)?,
        color: value
            .get("color")
            .and_then(Value::as_str)
            .map(str::to_string),
    })
}

fn find_environment<'a>(data: &'a Value, env_id: &str) -> Result<&'a Value, String> {
    data.get("sqls_envs")
        .and_then(Value::as_array)
        .and_then(|items| {
            items
                .iter()
                .find(|item| item.get("id").and_then(Value::as_str) == Some(env_id))
        })
        .ok_or_else(|| format!("环境不存在：{env_id}"))
}

fn environment_origin(environment: &Value) -> Result<String, String> {
    let base = required_string(environment, "base", "环境地址无效")?;
    let scheme = environment
        .get("scheme")
        .and_then(Value::as_str)
        .unwrap_or("http");
    Ok(format!("{scheme}://{base}"))
}

fn required_string(value: &Value, key: &str, error: &str) -> Result<String, String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|text| !text.trim().is_empty())
        .map(str::to_string)
        .ok_or_else(|| error.to_string())
}

fn parse<T: DeserializeOwned>(arguments: Value) -> Result<T, String> {
    serde_json::from_value(arguments).map_err(|error| format!("工具参数无效：{error}"))
}

fn tool(name: &str, description: &str, properties: Value) -> Value {
    let required = properties
        .as_object()
        .map(|items| {
            items
                .keys()
                .filter(|key| key.as_str() != "schemaName")
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    json!({
        "name": name,
        "description": description,
        "inputSchema": {
            "type": "object",
            "properties": properties,
            "required": required,
            "additionalProperties": false
        }
    })
}

fn environment_schema() -> Value {
    json!({ "envId": { "type": "string", "description": "SQL Studio 环境标识" } })
}

fn database_schema() -> Value {
    json!({
        "envId": { "type": "string" },
        "instanceName": { "type": "string", "description": "Archery 实例名" }
    })
}

fn table_schema() -> Value {
    json!({
        "envId": { "type": "string" },
        "instanceName": { "type": "string" },
        "databaseName": { "type": "string" },
        "schemaName": { "type": "string", "description": "PostgreSQL schema；MySQL 可省略" }
    })
}

fn schema_schema() -> Value {
    let mut properties = table_schema().as_object().cloned().unwrap_or_default();
    properties.insert("tableName".into(), json!({ "type": "string" }));
    Value::Object(properties)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exposes_five_resource_tools_without_credentials() {
        let definitions = definitions();
        let tools = definitions["tools"].as_array().unwrap();
        assert_eq!(tools.len(), TOOL_NAMES.len());
        for item in tools {
            let properties = &item["inputSchema"]["properties"];
            assert!(properties.get("username").is_none());
            assert!(properties.get("password").is_none());
        }
    }

    #[test]
    fn builds_environment_summary_without_credentials() {
        let summary = environment_summary(&json!({
            "id": "test", "name": "测试", "scheme": "https",
            "base": "archery.example.com", "color": "#fff"
        }))
        .unwrap();
        assert_eq!(summary.origin, "https://archery.example.com");
    }
}
