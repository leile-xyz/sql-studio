use serde::Serialize;
use serde_json::json;

use super::{
    domain::WorkflowVersionDetail,
    execution_models::{ArtifactEncoding, ArtifactType, NewArtifact},
    execution_repository,
};
use crate::{
    plugins::{
        dingtalk::{self, DingTalkMessage, DispatchFailureKind},
        message_builder::{self, MessageBuildContext, StandardMessage},
    },
    storage::WorkflowDb,
};

pub(crate) struct ChainInput {
    pub artifact_id: String,
    pub artifact_type: String,
    pub content: Vec<u8>,
}

pub(crate) async fn execute(
    db: &WorkflowDb,
    execution_id: &str,
    version: &WorkflowVersionDetail,
    mut input: ChainInput,
) -> Result<String, String> {
    let last_position = version.nodes.last().map(|node| node.position).unwrap_or(0);
    for node in version.nodes.iter().filter(|node| node.position > 0) {
        let node_id = execution_repository::start_plugin(
            &mut db.open_connection()?,
            execution_id,
            node.position,
            &input.artifact_id,
        )?;
        match node.plugin_key.as_deref() {
            Some("message_builder") => match build_message(version, node, &input) {
                Ok((message, artifact)) => {
                    let artifact_id = execution_repository::complete_node(
                        &mut db.open_connection()?,
                        execution_id,
                        &node_id,
                        &artifact,
                        node.position == last_position,
                    )?;
                    input = ChainInput {
                        artifact_id,
                        artifact_type: "message".into(),
                        content: encode(&message)?,
                    };
                }
                Err(message) => {
                    return fail(
                        db,
                        execution_id,
                        node.position,
                        "MESSAGE_BUILD_FAILED",
                        &message,
                    )
                }
            },
            Some("dingtalk") => {
                return dispatch_dingtalk(db, execution_id, node.position, &node_id, &input).await
            }
            Some(key) => {
                return fail(
                    db,
                    execution_id,
                    node.position,
                    "PLUGIN_EXECUTOR_NOT_REGISTERED",
                    &format!("插件执行器尚未注册：{key}"),
                )
            }
            None => {
                return fail(
                    db,
                    execution_id,
                    node.position,
                    "PLUGIN_KEY_MISSING",
                    "插件节点缺少类型",
                )
            }
        }
    }
    Ok("succeeded".into())
}

fn build_message(
    version: &WorkflowVersionDetail,
    node: &super::domain::WorkflowNodeInput,
    input: &ChainInput,
) -> Result<(StandardMessage, NewArtifact), String> {
    let config = node
        .plugin_config
        .as_ref()
        .ok_or_else(|| "消息构建节点缺少配置".to_string())?;
    let message = message_builder::build_message(
        config,
        MessageBuildContext {
            workflow_name: &version.name,
            input_type: &input.artifact_type,
            input_cbor: &input.content,
        },
    )?;
    let content = encode(&message)?;
    let summary = if message.skip_delivery {
        "空结果，按配置跳过外部发送"
    } else {
        "消息构建完成"
    };
    Ok((
        message,
        NewArtifact {
            artifact_type: ArtifactType::Message,
            encoding: ArtifactEncoding::Cbor,
            content: Some(content),
            file_reference: None,
            row_count: None,
            summary: summary.into(),
            contains_sensitive_data: false,
        },
    ))
}

async fn dispatch_dingtalk(
    db: &WorkflowDb,
    execution_id: &str,
    position: i64,
    node_id: &str,
    input: &ChainInput,
) -> Result<String, String> {
    if input.artifact_type != "message" {
        return fail(
            db,
            execution_id,
            position,
            "PLUGIN_INPUT_TYPE_MISMATCH",
            "钉钉插件需要 message 输入",
        );
    }
    let message: StandardMessage = match ciborium::from_reader(input.content.as_slice()) {
        Ok(message) => message,
        Err(_) => {
            return fail(
                db,
                execution_id,
                position,
                "MESSAGE_ARTIFACT_INVALID",
                "message 产物解码失败",
            )
        }
    };
    if message.skip_delivery {
        return complete_skipped(db, execution_id, node_id);
    }
    execution_repository::mark_dispatching(&db.open_connection()?, execution_id, node_id)?;
    let request = DingTalkMessage {
        format: message.format,
        title: message.title,
        body: message.body,
        at_all: message.at.all,
        at_mobiles: message.at.mobiles,
    };
    match dingtalk::send_message(&request).await {
        Ok(receipt) => complete_delivery(db, execution_id, node_id, receipt),
        Err(error) if error.kind == DispatchFailureKind::Interrupted => {
            execution_repository::interrupt_dispatch(
                &mut db.open_connection()?,
                execution_id,
                node_id,
                error.code,
                &error.safe_message,
            )?;
            Ok("interrupted".into())
        }
        Err(error) => fail(db, execution_id, position, error.code, &error.safe_message),
    }
}

fn complete_delivery<T: Serialize>(
    db: &WorkflowDb,
    execution_id: &str,
    node_id: &str,
    receipt: T,
) -> Result<String, String> {
    let artifact = none_artifact(encode(&receipt)?, "钉钉消息发送成功");
    execution_repository::complete_node(
        &mut db.open_connection()?,
        execution_id,
        node_id,
        &artifact,
        true,
    )?;
    Ok("succeeded".into())
}

fn complete_skipped(db: &WorkflowDb, execution_id: &str, node_id: &str) -> Result<String, String> {
    let artifact = none_artifact(
        encode(&json!({"skipped":true,"reason":"empty_result"}))?,
        "空结果，未调用钉钉",
    );
    execution_repository::complete_node(
        &mut db.open_connection()?,
        execution_id,
        node_id,
        &artifact,
        true,
    )?;
    Ok("succeeded".into())
}

fn none_artifact(content: Vec<u8>, summary: &str) -> NewArtifact {
    NewArtifact {
        artifact_type: ArtifactType::None,
        encoding: ArtifactEncoding::Cbor,
        content: Some(content),
        file_reference: None,
        row_count: None,
        summary: summary.into(),
        contains_sensitive_data: false,
    }
}
fn encode<T: Serialize>(value: &T) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    ciborium::into_writer(value, &mut bytes).map_err(|e| format!("插件产物编码失败：{e}"))?;
    Ok(bytes)
}
fn fail(
    db: &WorkflowDb,
    execution_id: &str,
    position: i64,
    code: &str,
    message: &str,
) -> Result<String, String> {
    execution_repository::fail(
        &mut db.open_connection()?,
        execution_id,
        position,
        code,
        message,
    )?;
    Ok("failed".into())
}
