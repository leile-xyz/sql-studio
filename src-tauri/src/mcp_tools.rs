use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::{
    archery::{
        ArcheryQueryRequest, ArcheryQueryResult, ArcheryService, DescribeTableRequest,
        DEFAULT_QUERY_LIMIT,
    },
    session::{ensure_session, environment_origin, relogin, required_string},
    Kv,
};

pub(crate) const LIST_ENVIRONMENTS: &str = "list_environments";
pub(crate) const LIST_INSTANCES: &str = "list_instances";
pub(crate) const LIST_DATABASES: &str = "list_databases";
pub(crate) const LIST_TABLES: &str = "list_tables";
pub(crate) const GET_TABLE_SCHEMA: &str = "get_table_schema";
pub(crate) const EXECUTE_SQL: &str = "execute_sql";

/// 单次查询返回行数上限，防止调用方一次拉走过多数据。
const MAX_QUERY_LIMIT: u32 = 1000;

const TOOL_NAMES: [&str; 6] = [
    LIST_ENVIRONMENTS,
    LIST_INSTANCES,
    LIST_DATABASES,
    LIST_TABLES,
    GET_TABLE_SCHEMA,
    EXECUTE_SQL,
];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EnvironmentSummary {
    id: String,
    name: String,
    origin: String,
    color: Option<String>,
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct QueryArguments {
    env_id: String,
    instance_name: String,
    database_name: String,
    #[serde(default)]
    schema_name: Option<String>,
    sql: String,
    #[serde(default)]
    limit: Option<u32>,
}

pub(crate) fn names() -> Vec<String> {
    TOOL_NAMES.iter().map(|name| (*name).into()).collect()
}

pub(crate) fn contains(name: &str) -> bool {
    TOOL_NAMES.contains(&name)
}

pub(crate) fn definitions() -> Value {
    json!({ "tools": [
        tool(LIST_ENVIRONMENTS, "返回 SQL Studio 已配置的环境", json!({}), &[]),
        tool(LIST_INSTANCES, "返回指定环境可访问的 Archery 实例", environment_schema(), &[]),
        tool(LIST_DATABASES, "返回指定实例的数据库", database_schema(), &[]),
        tool(LIST_TABLES, "返回指定数据库或 schema 的数据表", table_schema(), &["schemaName"]),
        tool(GET_TABLE_SCHEMA, "返回指定数据表的字段、索引和 DDL 结构", schema_schema(), &["schemaName"]),
        tool(
            EXECUTE_SQL,
            "在指定环境执行一条 SQL 并返回结果行；语句经 Archery 服务端权限与审核链路执行，\
             可指定与界面当前环境不同的环境，只使用该环境已保存的凭据建立会话",
            query_schema(),
            &["schemaName", "limit"]
        )
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
        EXECUTE_SQL => execute_sql(app, parse(arguments)?).await,
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

/// 执行 SQL：MCP 的 execute_sql 工具与本地 HTTP `POST /sql` 接口共用同一实现。
/// 调用方只给 envId，会话优先复用进程内已有会话，否则用该环境已保存的凭据登录，
/// 因此界面停在别的环境也能查询目标环境。
pub(crate) async fn execute_sql(app: &AppHandle, arguments: Value) -> Result<Value, String> {
    let input: QueryArguments = parse(arguments)?;
    let (env_id, request) = build_query_request(input)?;
    let limit = request.limit;
    let session = ensure_session(app, &env_id).await?;
    let service = app.state::<ArcheryService>();
    let result = match service.execute_sql(&session, &request).await {
        // 跨环境查询时没有界面帮忙刷新会话，这里用已保存凭据重登一次再重试。
        Err(error) if crate::archery::is_session_expired(&error) => {
            relogin(app, &env_id).await?;
            service.execute_sql(&session, &request).await?
        }
        settled => settled?,
    };
    query_payload(result, limit)
}

fn build_query_request(input: QueryArguments) -> Result<(String, ArcheryQueryRequest), String> {
    let sql = input.sql.trim().to_string();
    if sql.is_empty() {
        return Err("SQL 不能为空".into());
    }
    for (label, value) in [
        ("实例名", input.instance_name.as_str()),
        ("数据库名", input.database_name.as_str()),
    ] {
        if value.trim().is_empty() {
            return Err(format!("{label}不能为空"));
        }
    }
    Ok((
        input.env_id,
        ArcheryQueryRequest {
            instance_name: input.instance_name,
            database_name: input.database_name,
            schema_name: input.schema_name,
            sql,
            limit: resolve_limit(input.limit),
        },
    ))
}

fn resolve_limit(limit: Option<u32>) -> u32 {
    limit
        .unwrap_or(DEFAULT_QUERY_LIMIT)
        .clamp(1, MAX_QUERY_LIMIT)
}

fn query_payload(result: ArcheryQueryResult, limit: u32) -> Result<Value, String> {
    let row_count = result.rows.len();
    let mut payload =
        serde_json::to_value(&result).map_err(|error| format!("序列化查询结果失败：{error}"))?;
    if let Some(fields) = payload.as_object_mut() {
        fields.insert("rowCount".into(), json!(row_count));
        fields.insert("rowLimit".into(), json!(limit));
        // 行数触到上限说明可能还有更多数据，调用方可以据此缩小范围或分页。
        fields.insert("truncated".into(), json!(row_count as u32 >= limit));
    }
    Ok(payload)
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

fn parse<T: DeserializeOwned>(arguments: Value) -> Result<T, String> {
    serde_json::from_value(arguments).map_err(|error| format!("工具参数无效：{error}"))
}

fn tool(name: &str, description: &str, properties: Value, optional: &[&str]) -> Value {
    let required = properties
        .as_object()
        .map(|items| {
            items
                .keys()
                .filter(|key| !optional.contains(&key.as_str()))
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

fn query_schema() -> Value {
    let mut properties = schema_schema().as_object().cloned().unwrap_or_default();
    properties.remove("tableName");
    properties.insert(
        "sql".into(),
        json!({ "type": "string", "description": "要执行的 SQL，一次一条" }),
    );
    properties.insert(
        "limit".into(),
        json!({ "type": "integer", "description": "返回行数上限，默认 100，最大 1000" }),
    );
    Value::Object(properties)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exposes_all_tools_without_credentials() {
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
    fn execute_sql_schema_marks_optional_arguments() {
        let definitions = definitions();
        let tools = definitions["tools"].as_array().unwrap();
        let execute = tools
            .iter()
            .find(|item| item["name"] == EXECUTE_SQL)
            .expect("缺少 execute_sql 工具");
        let mut required = execute["inputSchema"]["required"]
            .as_array()
            .unwrap()
            .iter()
            .map(|value| value.as_str().unwrap())
            .collect::<Vec<_>>();
        required.sort_unstable();
        assert_eq!(
            required,
            ["databaseName", "envId", "instanceName", "sql"],
            "schemaName 与 limit 必须是可选参数"
        );
    }

    #[test]
    fn clamps_query_limit_to_documented_range() {
        assert_eq!(resolve_limit(None), DEFAULT_QUERY_LIMIT);
        assert_eq!(resolve_limit(Some(500)), 500);
        assert_eq!(resolve_limit(Some(0)), 1);
        assert_eq!(resolve_limit(Some(10_000)), MAX_QUERY_LIMIT);
    }

    #[test]
    fn rejects_empty_query_arguments() {
        let arguments = |sql: &str, limit: Option<u32>| QueryArguments {
            env_id: "dev".into(),
            instance_name: "mysql".into(),
            database_name: "app".into(),
            schema_name: Some("public".into()),
            sql: sql.into(),
            limit,
        };

        assert!(build_query_request(arguments("   ", None)).is_err());
        let (env_id, request) = build_query_request(arguments(" select 1 ", Some(20))).unwrap();
        assert_eq!(env_id, "dev");
        assert_eq!(request.sql, "select 1");
        assert_eq!(request.schema_name.as_deref(), Some("public"));
        assert_eq!(request.limit, 20);
    }

    #[test]
    fn reports_row_count_and_truncation() {
        let result = ArcheryQueryResult {
            columns: vec!["id".into()],
            column_types: vec![json!("LONGLONG")],
            rows: vec![vec![json!(1)]],
            elapsed_seconds: 0.01,
            affected_rows: None,
            full_sql: "select 1".into(),
            is_masked: false,
        };
        let payload = query_payload(result, 1).unwrap();
        assert_eq!(payload["rowCount"], 1);
        assert_eq!(payload["rowLimit"], 1);
        assert_eq!(payload["truncated"], true);
        assert_eq!(payload["columns"][0], "id");
        assert_eq!(payload["fullSql"], "select 1");
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
