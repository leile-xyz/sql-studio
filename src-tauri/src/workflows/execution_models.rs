use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TriggerType {
    Manual,
    Schedule,
}

impl TriggerType {
    pub fn parse(value: &str) -> Result<Self, String> {
        match value {
            "manual" => Ok(Self::Manual),
            "schedule" => Ok(Self::Schedule),
            _ => Err(format!("未知执行触发类型：{value}")),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionStatus {
    Pending,
    Running,
    Succeeded,
    Failed,
    Cancelled,
    Interrupted,
}

impl ExecutionStatus {
    pub fn parse(value: &str) -> Result<Self, String> {
        match value {
            "pending" => Ok(Self::Pending),
            "running" => Ok(Self::Running),
            "succeeded" => Ok(Self::Succeeded),
            "failed" => Ok(Self::Failed),
            "cancelled" => Ok(Self::Cancelled),
            "interrupted" => Ok(Self::Interrupted),
            _ => Err(format!("未知流程执行状态：{value}")),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NodeExecutionStatus {
    Pending,
    Running,
    Dispatching,
    Succeeded,
    Failed,
    SkippedDueToFailure,
    Interrupted,
}

impl NodeExecutionStatus {
    pub fn parse(value: &str) -> Result<Self, String> {
        match value {
            "pending" => Ok(Self::Pending),
            "running" => Ok(Self::Running),
            "dispatching" => Ok(Self::Dispatching),
            "succeeded" => Ok(Self::Succeeded),
            "failed" => Ok(Self::Failed),
            "skipped_due_to_failure" => Ok(Self::SkippedDueToFailure),
            "interrupted" => Ok(Self::Interrupted),
            _ => Err(format!("未知节点执行状态：{value}")),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ArtifactType {
    Table,
    Object,
    Text,
    Message,
    Files,
    None,
}

impl ArtifactType {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Table => "table",
            Self::Object => "object",
            Self::Text => "text",
            Self::Message => "message",
            Self::Files => "files",
            Self::None => "none",
        }
    }

    pub fn parse(value: &str) -> Result<Self, String> {
        match value {
            "table" => Ok(Self::Table),
            "object" => Ok(Self::Object),
            "text" => Ok(Self::Text),
            "message" => Ok(Self::Message),
            "files" => Ok(Self::Files),
            "none" => Ok(Self::None),
            _ => Err(format!("未知执行产物类型：{value}")),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ArtifactEncoding {
    Cbor,
    Utf8,
    Binary,
    File,
}

impl ArtifactEncoding {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Cbor => "cbor",
            Self::Utf8 => "utf8",
            Self::Binary => "binary",
            Self::File => "file",
        }
    }

    pub fn parse(value: &str) -> Result<Self, String> {
        match value {
            "cbor" => Ok(Self::Cbor),
            "utf8" => Ok(Self::Utf8),
            "binary" => Ok(Self::Binary),
            "file" => Ok(Self::File),
            _ => Err(format!("未知执行产物编码：{value}")),
        }
    }
}

#[derive(Clone, Debug)]
pub struct NewArtifact {
    pub artifact_type: ArtifactType,
    pub encoding: ArtifactEncoding,
    pub content: Option<Vec<u8>>,
    pub file_reference: Option<String>,
    pub row_count: Option<i64>,
    pub summary: String,
    pub contains_sensitive_data: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionDataSource {
    pub environment_id: String,
    pub instance_id: String,
    pub instance_name: String,
    pub database_name: String,
    pub database_type: String,
    pub schema_name: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionSummary {
    pub id: String,
    pub workflow_id: String,
    pub workflow_version_id: String,
    pub workflow_name: String,
    pub version_number: i64,
    pub trigger_type: TriggerType,
    pub schedule_id: Option<String>,
    pub scheduled_for: Option<String>,
    pub status: ExecutionStatus,
    pub created_at: String,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub duration_ms: Option<i64>,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeExecutionDetail {
    pub id: String,
    pub version_node_id: String,
    pub position: i64,
    pub node_kind: String,
    pub name: String,
    pub status: NodeExecutionStatus,
    pub input_artifact_id: Option<String>,
    pub output_artifact_id: Option<String>,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub duration_ms: Option<i64>,
    pub summary: Option<String>,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionDetail {
    pub summary: ExecutionSummary,
    pub data_source: ExecutionDataSource,
    pub nodes: Vec<NodeExecutionDetail>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionArtifact {
    pub id: String,
    pub execution_id: String,
    pub producer_node_execution_id: String,
    pub artifact_type: ArtifactType,
    pub encoding: ArtifactEncoding,
    pub content: Option<Vec<u8>>,
    pub file_reference: Option<String>,
    pub row_count: Option<i64>,
    pub byte_size: i64,
    pub sha256: String,
    pub summary: String,
    pub contains_sensitive_data: bool,
    pub created_at: String,
}
