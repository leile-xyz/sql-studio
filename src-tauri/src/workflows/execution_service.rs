use serde::Serialize;
use tauri::AppHandle;

use super::{
    execution,
    execution_models::{ArtifactEncoding, ArtifactType, NewArtifact},
    execution_repository::{self, CreatedExecution},
    plugin_execution, repository,
};
use crate::{
    archery::{ArcheryService, SessionContext},
    notifications,
    storage::WorkflowDb,
};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionOutcome {
    pub execution_id: String,
    pub status: String,
}

pub struct ExecutionRunContext<'a> {
    pub app: &'a AppHandle,
    pub db: &'a WorkflowDb,
    pub archery: &'a ArcheryService,
}

#[derive(Debug)]
pub struct PreflightFailure<'a> {
    pub code: &'a str,
    pub safe_message: &'a str,
}

pub async fn run_claimed(
    context: &ExecutionRunContext<'_>,
    created: CreatedExecution,
    session: SessionContext,
) -> Result<ExecutionOutcome, String> {
    let version = repository::get_version(&context.db.open_connection()?, &created.version_id)?;
    let artifact = match execution::execute_sql_node(context.archery, &session, &version).await {
        Ok(value) => value,
        Err(error) => {
            execution_repository::fail(
                &mut context.db.open_connection()?,
                &created.id,
                0,
                error.code,
                &error.stored_message,
            )?;
            notify_terminal(context.app, context.db, &created.id, "failed")?;
            return Ok(outcome(created.id, "failed"));
        }
    };
    let has_plugin = version.nodes.len() > 1;
    let chain = plugin_execution::ChainInput {
        artifact_id: String::new(),
        artifact_type: artifact.artifact_type.clone(),
        content: artifact.content.clone(),
    };
    let stored = NewArtifact {
        artifact_type: ArtifactType::parse(&artifact.artifact_type)?,
        encoding: ArtifactEncoding::parse(&artifact.encoding)?,
        content: Some(artifact.content),
        file_reference: None,
        row_count: artifact.row_count,
        summary: artifact.summary,
        contains_sensitive_data: artifact.contains_sensitive_data,
    };
    let artifact_id = execution_repository::complete_sql(
        &mut context.db.open_connection()?,
        &created.id,
        &created.sql_node_id,
        &stored,
        !has_plugin,
    )?;
    if !has_plugin {
        notify_terminal(context.app, context.db, &created.id, "succeeded")?;
        return Ok(outcome(created.id, "succeeded"));
    }
    let status = plugin_execution::execute(
        context.db,
        &created.id,
        &version,
        plugin_execution::ChainInput {
            artifact_id,
            ..chain
        },
    )
    .await?;
    notify_terminal(context.app, context.db, &created.id, &status)?;
    Ok(outcome(created.id, &status))
}

pub fn fail_before_sql(
    context: &ExecutionRunContext<'_>,
    created: CreatedExecution,
    failure: PreflightFailure<'_>,
) -> Result<ExecutionOutcome, String> {
    execution_repository::fail(
        &mut context.db.open_connection()?,
        &created.id,
        0,
        failure.code,
        failure.safe_message,
    )?;
    notify_terminal(context.app, context.db, &created.id, "failed")?;
    Ok(outcome(created.id, "failed"))
}

fn notify_terminal(
    app: &AppHandle,
    db: &WorkflowDb,
    execution_id: &str,
    status: &str,
) -> Result<(), String> {
    let id = notifications::repository::create_execution_terminal_connection(
        &mut db.open_connection()?,
        execution_id,
        status,
    )?;
    notifications::service::deliver_if_needed(app, db, &id)?;
    Ok(())
}

fn outcome(execution_id: String, status: &str) -> ExecutionOutcome {
    ExecutionOutcome {
        execution_id,
        status: status.into(),
    }
}
