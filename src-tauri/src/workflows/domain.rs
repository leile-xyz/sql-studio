use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DataSource {
    pub environment_id: String,
    pub instance_id: String,
    pub instance_name: String,
    pub database_name: String,
    pub database_type: String,
    pub schema_name: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowNodeInput {
    pub id: String,
    pub position: i64,
    pub node_kind: String,
    pub name: String,
    pub plugin_resource_id: Option<String>,
    pub plugin_key: Option<String>,
    pub category: String,
    pub terminal: bool,
    pub input_type: Option<String>,
    pub output_type: String,
    pub sql: Option<String>,
    pub sql_kind: Option<String>,
    #[serde(default)]
    pub plugin_config: Option<Value>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateWorkflow {
    pub name: String,
    pub description: String,
    pub data_source: DataSource,
    pub nodes: Vec<WorkflowNodeInput>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateWorkflow {
    pub workflow_id: String,
    pub expected_draft_revision: i64,
    pub name: String,
    pub description: String,
    pub data_source: DataSource,
    pub nodes: Vec<WorkflowNodeInput>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowSummary {
    pub id: String,
    pub name: String,
    pub description: String,
    pub draft_revision: i64,
    pub active_version_id: Option<String>,
    pub enabled: bool,
    pub next_run_at: Option<String>,
    pub schedule_timezone: Option<String>,
    pub updated_at: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowDetail {
    pub id: String,
    pub name: String,
    pub description: String,
    pub data_source: DataSource,
    pub nodes: Vec<WorkflowNodeInput>,
    pub draft_revision: i64,
    pub active_version_id: Option<String>,
    pub enabled: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginResourceInput {
    pub id: String,
    pub plugin_key: String,
    pub name: String,
    pub enabled: bool,
    pub credential_ref: Option<String>,
    #[serde(default)]
    pub config: Value,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginResourceSummary {
    pub id: String,
    pub plugin_key: String,
    pub name: String,
    pub enabled: bool,
    pub configured: bool,
    pub config: Value,
    pub category: String,
    pub terminal: bool,
    pub input_type: Option<String>,
    pub output_type: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishWorkflowInput {
    pub workflow_id: String,
    pub expected_draft_revision: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetWorkflowEnabledInput {
    pub workflow_id: String,
    pub enabled: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowVersionDetail {
    pub id: String,
    pub version_number: i64,
    pub source_draft_revision: i64,
    pub name: String,
    pub description: String,
    pub data_source: DataSource,
    pub nodes: Vec<WorkflowNodeInput>,
}
