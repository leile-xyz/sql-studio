use super::{
    domain::{
        CreateWorkflow, PluginResourceInput, PluginResourceSummary, PublishWorkflowInput,
        SetWorkflowEnabledInput, UpdateWorkflow, WorkflowDetail, WorkflowSummary,
        WorkflowVersionDetail,
    },
    repository,
};
use crate::storage::WorkflowDb;
use serde_json::{json, Value};
use tauri::State;

use super::{
    execution, execution_models::ArtifactEncoding, execution_repository, execution_service,
};
use crate::scheduler::{ManualSubmission, SchedulerHost};

#[tauri::command]
pub fn workflow_create(db: State<'_, WorkflowDb>, input: CreateWorkflow) -> Result<String, String> {
    repository::create_workflow(&mut db.open_connection()?, &input)
}

#[tauri::command]
pub fn workflow_list(
    db: State<'_, WorkflowDb>,
    environment_id: String,
) -> Result<Vec<WorkflowSummary>, String> {
    repository::list_workflows(&db.open_connection()?, &environment_id)
}

#[tauri::command]
pub fn workflow_get(
    db: State<'_, WorkflowDb>,
    workflow_id: String,
) -> Result<WorkflowDetail, String> {
    repository::get_workflow(&db.open_connection()?, &workflow_id)
}

#[tauri::command]
pub fn workflow_update(db: State<'_, WorkflowDb>, input: UpdateWorkflow) -> Result<i64, String> {
    repository::update_workflow(&mut db.open_connection()?, &input)
}

#[tauri::command]
pub fn workflow_copy(db: State<'_, WorkflowDb>, workflow_id: String) -> Result<String, String> {
    repository::copy_workflow(&mut db.open_connection()?, &workflow_id)
}

#[tauri::command]
pub fn workflow_archive(db: State<'_, WorkflowDb>, workflow_id: String) -> Result<(), String> {
    repository::archive_workflow(&db.open_connection()?, &workflow_id)
}

#[tauri::command]
pub fn workflow_set_enabled(
    db: State<'_, WorkflowDb>,
    input: SetWorkflowEnabledInput,
) -> Result<(), String> {
    repository::set_workflow_enabled(&db.open_connection()?, &input)
}

#[tauri::command]
pub fn workflow_plugin_resource_register(
    db: State<'_, WorkflowDb>,
    input: PluginResourceInput,
) -> Result<(), String> {
    repository::register_plugin_resource(&db.open_connection()?, &input)
}

#[tauri::command]
pub fn workflow_plugin_resources(
    db: State<'_, WorkflowDb>,
) -> Result<Vec<PluginResourceSummary>, String> {
    let mut resources = repository::list_plugin_resources(&db.open_connection()?)?;
    for resource in &mut resources {
        if resource.id == "dingtalk:default" {
            resource.configured = crate::plugins::dingtalk::is_configured()?;
        }
    }
    Ok(resources)
}

#[tauri::command]
pub fn workflow_publish(
    db: State<'_, WorkflowDb>,
    input: PublishWorkflowInput,
) -> Result<String, String> {
    let mut connection = db.open_connection()?;
    let draft = repository::get_workflow(&connection, &input.workflow_id)?;
    let uses_dingtalk = draft
        .nodes
        .iter()
        .any(|node| node.plugin_resource_id.as_deref() == Some("dingtalk:default"));
    if uses_dingtalk && !crate::plugins::dingtalk::is_configured()? {
        return Err("PLUGIN_NOT_CONFIGURED:钉钉机器人尚未配置".into());
    }
    repository::publish_workflow(&mut connection, &input)
}

#[tauri::command]
pub fn workflow_version_get(
    db: State<'_, WorkflowDb>,
    version_id: String,
) -> Result<WorkflowVersionDetail, String> {
    repository::get_version(&db.open_connection()?, &version_id)
}

#[tauri::command]
pub async fn run_workflow_manual(
    db: State<'_, WorkflowDb>,
    scheduler: State<'_, SchedulerHost>,
    input: execution::ManualExecutionInput,
) -> Result<execution_service::ExecutionOutcome, String> {
    let session = input.session();
    scheduler
        .submit_manual(ManualSubmission {
            db: &db,
            workflow_id: &input.workflow_id,
            session,
        })
        .await
}

#[tauri::command]
pub fn list_workflow_executions(
    db: State<'_, WorkflowDb>,
    workflow_id: String,
) -> Result<Vec<super::execution_models::ExecutionSummary>, String> {
    execution_repository::list(&db.open_connection()?, &workflow_id)
}

#[tauri::command]
pub fn get_workflow_execution(
    db: State<'_, WorkflowDb>,
    execution_id: String,
) -> Result<Value, String> {
    let (detail, artifacts) = execution_repository::detail(&db.open_connection()?, &execution_id)?;
    let mut value = serde_json::to_value(&detail.summary).map_err(|e| e.to_string())?;
    let object = value
        .as_object_mut()
        .ok_or_else(|| "执行详情序列化失败".to_string())?;
    object.insert(
        "dataSource".into(),
        serde_json::to_value(detail.data_source).map_err(|e| e.to_string())?,
    );
    object.insert(
        "nodeExecutions".into(),
        serde_json::to_value(detail.nodes).map_err(|e| e.to_string())?,
    );
    object.insert(
        "artifacts".into(),
        Value::Array(
            artifacts
                .into_iter()
                .map(artifact_view)
                .collect::<Result<_, _>>()?,
        ),
    );
    Ok(value)
}

fn artifact_view(artifact: super::execution_models::ExecutionArtifact) -> Result<Value, String> {
    let value = match (&artifact.encoding, artifact.content.as_deref()) {
        (ArtifactEncoding::Cbor, Some(content)) => {
            ciborium::from_reader(content).map_err(|e| format!("执行产物解码失败：{e}"))?
        }
        (ArtifactEncoding::Utf8, Some(content)) => Value::String(
            String::from_utf8(content.to_vec()).map_err(|e| format!("文本产物编码无效：{e}"))?,
        ),
        _ => Value::Null,
    };
    Ok(
        json!({"id":artifact.id,"artifactType":artifact.artifact_type,"encoding":artifact.encoding,"rowCount":artifact.row_count,"byteSize":artifact.byte_size,"sha256":artifact.sha256,"summary":artifact.summary,"value":value}),
    )
}
