use std::fmt::Write;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use super::domain::{DataSource, WorkflowNodeInput, WorkflowVersionDetail};
use crate::archery::{
    ArcheryQueryRequest, ArcheryQueryResult, ArcheryService, SessionContext, DEFAULT_QUERY_LIMIT,
};

const SQL_NODE_KIND: &str = "sql";
const QUERY_SQL_KIND: &str = "query";
const COMMAND_SQL_KIND: &str = "command";

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManualExecutionInput {
    pub workflow_id: String,
    pub environment_id: String,
    pub username: String,
    pub origin: String,
}

impl ManualExecutionInput {
    pub(crate) fn session(&self) -> SessionContext {
        SessionContext::new(
            self.environment_id.clone(),
            self.username.clone(),
            self.origin.clone(),
        )
    }
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct PreparedArtifact {
    pub artifact_type: String,
    pub encoding: String,
    pub content: Vec<u8>,
    pub row_count: Option<i64>,
    pub byte_size: i64,
    pub sha256: String,
    pub summary: String,
    pub contains_sensitive_data: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct RuntimeError {
    pub code: &'static str,
    pub user_message: String,
    pub stored_message: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct TableArtifact {
    columns: Vec<String>,
    column_types: Vec<Value>,
    rows: Vec<Vec<Value>>,
    elapsed_seconds: f64,
    affected_rows: Option<i64>,
    full_sql: String,
    is_masked: bool,
    returned_row_count: usize,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct CommandArtifact {
    affected_rows: Option<i64>,
    elapsed_seconds: f64,
    full_sql: String,
    is_masked: bool,
}

pub(crate) async fn execute_sql_node(
    service: &ArcheryService,
    session: &SessionContext,
    version: &WorkflowVersionDetail,
) -> Result<PreparedArtifact, RuntimeError> {
    validate_session(session, &version.data_source)?;
    let node = sql_node(version)?;
    let request = build_query_request(&version.data_source, node)?;
    let result = service
        .execute_sql(session, &request)
        .await
        .map_err(archery_error)?;
    prepare_artifact(node, result)
}

fn validate_session(session: &SessionContext, source: &DataSource) -> Result<(), RuntimeError> {
    if session.environment_id() == source.environment_id {
        return Ok(());
    }
    Err(RuntimeError {
        code: "SESSION_ENVIRONMENT_MISMATCH",
        user_message: "当前 Archery 会话与流程环境不一致".into(),
        stored_message: "当前 Archery 会话与流程环境不一致".into(),
    })
}

fn sql_node(version: &WorkflowVersionDetail) -> Result<&WorkflowNodeInput, RuntimeError> {
    let Some(node) = version.nodes.first() else {
        return Err(invalid_version("发布版本缺少 SQL 节点"));
    };
    if node.position != 0 || node.node_kind != SQL_NODE_KIND {
        return Err(invalid_version("发布版本首节点不是 SQL 节点"));
    }
    Ok(node)
}

fn build_query_request(
    source: &DataSource,
    node: &WorkflowNodeInput,
) -> Result<ArcheryQueryRequest, RuntimeError> {
    let sql = node.sql.as_deref().unwrap_or_default().trim();
    if sql.is_empty() {
        return Err(invalid_version("发布版本 SQL 为空"));
    }
    Ok(ArcheryQueryRequest {
        instance_name: source.instance_name.clone(),
        database_name: source.database_name.clone(),
        schema_name: source.schema_name.clone(),
        sql: sql.to_string(),
        limit: DEFAULT_QUERY_LIMIT,
    })
}

fn prepare_artifact(
    node: &WorkflowNodeInput,
    result: ArcheryQueryResult,
) -> Result<PreparedArtifact, RuntimeError> {
    let actual_type = if result.columns.is_empty() {
        "object"
    } else {
        "table"
    };
    let declared_type = declared_artifact_type(node)?;
    if actual_type != declared_type {
        return Err(RuntimeError {
            code: "SQL_RESULT_TYPE_MISMATCH",
            user_message: format!("SQL 声明输出 {declared_type}，Archery 实际返回 {actual_type}"),
            stored_message: format!("SQL 声明输出 {declared_type}，Archery 实际返回 {actual_type}"),
        });
    }
    match actual_type {
        "table" => prepare_table_artifact(result),
        "object" => prepare_command_artifact(result),
        _ => unreachable!(),
    }
}

fn declared_artifact_type(node: &WorkflowNodeInput) -> Result<&'static str, RuntimeError> {
    match node.sql_kind.as_deref() {
        Some(QUERY_SQL_KIND) if node.output_type == "table" => Ok("table"),
        Some(COMMAND_SQL_KIND) if node.output_type == "object" => Ok("object"),
        Some(QUERY_SQL_KIND) | Some(COMMAND_SQL_KIND) => {
            Err(invalid_version("SQL 类型与发布版本输出类型不一致"))
        }
        _ => Err(invalid_version("发布版本 SQL 类型无效")),
    }
}

fn prepare_table_artifact(result: ArcheryQueryResult) -> Result<PreparedArtifact, RuntimeError> {
    let row_count = result.rows.len();
    let column_count = result.columns.len();
    let payload = TableArtifact {
        columns: result.columns,
        column_types: result.column_types,
        rows: result.rows,
        elapsed_seconds: result.elapsed_seconds,
        affected_rows: result.affected_rows,
        full_sql: result.full_sql,
        is_masked: result.is_masked,
        returned_row_count: row_count,
    };
    encoded_artifact(
        "table",
        &payload,
        Some(row_count as i64),
        format!("Archery 实际返回 {row_count} 行、{column_count} 列"),
    )
}

fn prepare_command_artifact(result: ArcheryQueryResult) -> Result<PreparedArtifact, RuntimeError> {
    let affected = result.affected_rows;
    let payload = CommandArtifact {
        affected_rows: affected,
        elapsed_seconds: result.elapsed_seconds,
        full_sql: result.full_sql,
        is_masked: result.is_masked,
    };
    let summary = match affected {
        Some(rows) => format!("Archery 报告影响 {rows} 行"),
        None => "Archery 未报告影响行数".into(),
    };
    encoded_artifact("object", &payload, None, summary)
}

fn encoded_artifact<T: Serialize>(
    artifact_type: &str,
    payload: &T,
    row_count: Option<i64>,
    summary: String,
) -> Result<PreparedArtifact, RuntimeError> {
    let mut content = Vec::new();
    ciborium::into_writer(payload, &mut content).map_err(|error| RuntimeError {
        code: "ARTIFACT_ENCODE_FAILED",
        user_message: format!("执行产物编码失败：{error}"),
        stored_message: "执行产物编码失败".into(),
    })?;
    Ok(PreparedArtifact {
        artifact_type: artifact_type.into(),
        encoding: "cbor".into(),
        byte_size: content.len() as i64,
        sha256: sha256_hex(&content),
        content,
        row_count,
        summary,
        contains_sensitive_data: true,
    })
}

fn sha256_hex(content: &[u8]) -> String {
    Sha256::digest(content)
        .iter()
        .fold(String::with_capacity(64), |mut output, byte| {
            write!(&mut output, "{byte:02x}").expect("writing to String cannot fail");
            output
        })
}

fn archery_error(message: String) -> RuntimeError {
    RuntimeError {
        code: "ARCHERY_SQL_FAILED",
        user_message: message,
        stored_message: "Archery SQL 执行失败".into(),
    }
}

fn invalid_version(message: &str) -> RuntimeError {
    RuntimeError {
        code: "INVALID_WORKFLOW_VERSION",
        user_message: message.into(),
        stored_message: message.into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sql_node(kind: &str, output: &str) -> WorkflowNodeInput {
        WorkflowNodeInput {
            id: "sql-source-id".into(),
            position: 0,
            node_kind: "sql".into(),
            name: "SQL".into(),
            plugin_resource_id: None,
            plugin_key: None,
            category: "sql".into(),
            terminal: false,
            input_type: None,
            output_type: output.into(),
            sql: Some("SELECT 1".into()),
            sql_kind: Some(kind.into()),
            plugin_config: None,
        }
    }

    fn query_result(columns: Vec<&str>, rows: Vec<Vec<Value>>) -> ArcheryQueryResult {
        let column_count = columns.len();
        ArcheryQueryResult {
            columns: columns.into_iter().map(str::to_string).collect(),
            column_types: vec![json_value("UNKNOWN"); column_count],
            rows,
            elapsed_seconds: 0.1,
            affected_rows: Some(0),
            full_sql: "SELECT 1 LIMIT 100".into(),
            is_masked: false,
        }
    }

    fn json_value(value: &str) -> Value {
        Value::String(value.into())
    }

    #[test]
    fn query_result_round_trips_as_cbor_table() {
        let row = vec![
            Value::from(1),
            Value::Bool(true),
            Value::Null,
            Value::Array(vec![Value::from("nested")]),
            Value::Object(serde_json::Map::from_iter([(
                "key".into(),
                Value::from("value"),
            )])),
        ];
        let result = query_result(
            vec!["number", "boolean", "null", "array", "object"],
            vec![row.clone()],
        );
        let artifact = prepare_artifact(&sql_node("query", "table"), result).unwrap();
        let decoded: TableArtifact = ciborium::from_reader(artifact.content.as_slice()).unwrap();
        assert_eq!(artifact.artifact_type, "table");
        assert_eq!(artifact.row_count, Some(1));
        assert_eq!(decoded.rows, vec![row]);
        assert_eq!(decoded.full_sql, "SELECT 1 LIMIT 100");
        assert_eq!(artifact.sha256.len(), 64);
    }

    #[test]
    fn command_result_round_trips_as_cbor_object() {
        let mut result = query_result(Vec::new(), Vec::new());
        result.column_types.clear();
        result.affected_rows = Some(3);
        let artifact = prepare_artifact(&sql_node("command", "object"), result).unwrap();
        let decoded: CommandArtifact = ciborium::from_reader(artifact.content.as_slice()).unwrap();
        assert_eq!(artifact.artifact_type, "object");
        assert_eq!(decoded.affected_rows, Some(3));
    }

    #[test]
    fn rejects_declared_and_actual_result_type_mismatch() {
        let result = query_result(vec!["id"], vec![vec![Value::from(1)]]);
        let error = prepare_artifact(&sql_node("command", "object"), result).unwrap_err();
        assert_eq!(error.code, "SQL_RESULT_TYPE_MISMATCH");
    }
}
