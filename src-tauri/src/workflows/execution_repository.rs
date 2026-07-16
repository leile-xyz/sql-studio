use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use uuid::Uuid;

use crate::notifications;

use super::execution_models::{
    ArtifactEncoding, ArtifactType, ExecutionArtifact, ExecutionDataSource, ExecutionDetail,
    ExecutionStatus, ExecutionSummary, NewArtifact, NodeExecutionDetail, NodeExecutionStatus,
    TriggerType,
};

pub struct CreatedExecution {
    pub id: String,
    pub version_id: String,
    pub sql_node_id: String,
}

pub fn create_manual(
    connection: &mut Connection,
    workflow_id: &str,
) -> Result<CreatedExecution, String> {
    let tx = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(db)?;
    let version: (String, String, i64, String, String, String, String, String, Option<String>) = tx.query_row(
        "SELECT v.id,v.name,v.version_number,v.environment_id,v.instance_id,v.instance_name,v.database_name,v.database_type,v.schema_name FROM workflow_definitions w JOIN workflow_versions v ON v.id=w.active_version_id WHERE w.id=?1 AND w.deleted_at IS NULL",
        params![workflow_id], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?,r.get(7)?,r.get(8)?)))
        .optional().map_err(db)?.ok_or_else(|| "流程尚未发布或已删除".to_string())?;
    let id = new_id();
    let now = now();
    tx.execute("INSERT INTO workflow_executions(id,workflow_id,workflow_version_id,workflow_name,version_number,trigger_type,status,environment_id,instance_id,instance_name,database_name,database_type,schema_name,created_at) VALUES(?1,?2,?3,?4,?5,'manual','pending',?6,?7,?8,?9,?10,?11,?12)", params![id,workflow_id,version.0,version.1,version.2,version.3,version.4,version.5,version.6,version.7,version.8,now]).map_err(db)?;
    let mut stmt = tx.prepare("SELECT id,position,node_kind,name FROM workflow_version_nodes WHERE version_id=?1 ORDER BY position").map_err(db)?;
    let nodes: Vec<(String, i64, String, String)> = stmt
        .query_map(params![version.0], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
        })
        .map_err(db)?
        .collect::<Result<_, _>>()
        .map_err(db)?;
    drop(stmt);
    if nodes.is_empty() {
        return Err("发布版本没有节点".into());
    }
    let mut sql_node_id = String::new();
    for (version_node_id, position, kind, name) in nodes {
        let node_id = new_id();
        if position == 0 {
            sql_node_id = node_id.clone();
        }
        tx.execute("INSERT INTO node_executions(id,execution_id,version_node_id,position,node_kind,name,status,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,'pending',?7,?7)", params![node_id,id,version_node_id,position,kind,name,now]).map_err(db)?;
    }
    tx.commit().map_err(db)?;
    Ok(CreatedExecution {
        id,
        version_id: version.0,
        sql_node_id,
    })
}

pub fn claim(connection: &mut Connection, execution_id: &str, node_id: &str) -> Result<(), String> {
    let tx = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(db)?;
    let now = now();
    let changed=tx.execute("UPDATE workflow_executions SET status='running',started_at=?1 WHERE id=?2 AND status='pending' AND NOT EXISTS (SELECT 1 FROM workflow_executions active WHERE active.workflow_id=workflow_executions.workflow_id AND active.status='running')",params![now,execution_id]).map_err(db)?;
    if changed != 1 {
        return Err("执行记录已被领取或状态无效".into());
    }
    let node_changed=tx.execute("UPDATE node_executions SET status='running',started_at=?1,updated_at=?1 WHERE id=?2 AND execution_id=?3 AND status='pending'",params![now,node_id,execution_id]).map_err(db)?;
    if node_changed != 1 {
        return Err("SQL 节点状态无效".into());
    }
    tx.commit().map_err(db)
}

pub fn complete_sql(
    connection: &mut Connection,
    execution_id: &str,
    node_id: &str,
    artifact: &NewArtifact,
    finish_workflow: bool,
) -> Result<String, String> {
    complete_node(connection, execution_id, node_id, artifact, finish_workflow)
}

pub fn start_plugin(
    connection: &mut Connection,
    execution_id: &str,
    position: i64,
    input_artifact_id: &str,
) -> Result<String, String> {
    let tx = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(db)?;
    let node_id: String = tx
        .query_row(
            "SELECT id FROM node_executions WHERE execution_id=?1 AND position=?2",
            params![execution_id, position],
            |row| row.get(0),
        )
        .optional()
        .map_err(db)?
        .ok_or_else(|| "插件节点执行记录不存在".to_string())?;
    let timestamp = now();
    let changed = tx.execute(
        "UPDATE node_executions SET status='running',input_artifact_id=?1,started_at=?2,updated_at=?2
         WHERE id=?3 AND status='pending' AND EXISTS (
           SELECT 1 FROM node_executions previous
           WHERE previous.execution_id=node_executions.execution_id
             AND previous.position=node_executions.position-1
             AND previous.status='succeeded' AND previous.output_artifact_id=?1)",
        params![input_artifact_id, timestamp, node_id],
    ).map_err(db)?;
    if changed != 1 {
        return Err("插件节点前序产物或状态无效".into());
    }
    tx.commit().map_err(db)?;
    Ok(node_id)
}

pub fn mark_dispatching(
    connection: &Connection,
    execution_id: &str,
    node_id: &str,
) -> Result<(), String> {
    let changed = connection
        .execute(
            "UPDATE node_executions SET status='dispatching',updated_at=?1
             WHERE id=?2 AND execution_id=?3 AND status='running'",
            params![now(), node_id, execution_id],
        )
        .map_err(db)?;
    if changed != 1 {
        return Err("终止插件节点未处于运行状态".into());
    }
    Ok(())
}

pub fn complete_node(
    connection: &mut Connection,
    execution_id: &str,
    node_id: &str,
    artifact: &NewArtifact,
    finish_workflow: bool,
) -> Result<String, String> {
    let tx = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(db)?;
    let artifact_id = new_id();
    let finished = now();
    let content = artifact.content.as_deref();
    let bytes = content.map_or(0, |v| v.len() as i64);
    let hash = content.map(sha256_hex).unwrap_or_default();
    tx.execute("INSERT INTO execution_artifacts(id,execution_id,producer_node_execution_id,artifact_type,encoding,content_blob,file_reference,row_count,byte_size,sha256,summary,contains_sensitive_data,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)",params![artifact_id,execution_id,node_id,artifact.artifact_type.as_str(),artifact.encoding.as_str(),content,artifact.file_reference,artifact.row_count,bytes,hash,artifact.summary,artifact.contains_sensitive_data as i64,finished]).map_err(db)?;
    let node_changed=tx.execute("UPDATE node_executions SET status='succeeded',output_artifact_id=?1,finished_at=?2,duration_ms=CAST((julianday(?2)-julianday(started_at))*86400000 AS INTEGER),summary=?3,updated_at=?2 WHERE id=?4 AND execution_id=?5 AND status IN ('running','dispatching')",params![artifact_id,finished,artifact.summary,node_id,execution_id]).map_err(db)?;
    if node_changed != 1 {
        return Err("节点未处于可完成状态".into());
    }
    if finish_workflow {
        let changed=tx.execute("UPDATE workflow_executions SET status='succeeded',finished_at=?1,duration_ms=CAST((julianday(?1)-julianday(started_at))*86400000 AS INTEGER) WHERE id=?2 AND status='running'",params![finished,execution_id]).map_err(db)?;
        if changed != 1 {
            return Err("流程执行未处于运行状态".into());
        }
        notifications::repository::create_execution_terminal(&tx, execution_id, "succeeded")?;
    }
    tx.commit().map_err(db)?;
    Ok(artifact_id)
}

pub fn interrupt_dispatch(
    connection: &mut Connection,
    execution_id: &str,
    node_id: &str,
    code: &str,
    message: &str,
) -> Result<(), String> {
    let tx = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(db)?;
    let finished = now();
    let changed=tx.execute("UPDATE node_executions SET status='interrupted',finished_at=?1,duration_ms=CAST((julianday(?1)-julianday(started_at))*86400000 AS INTEGER),error_code=?2,error_message=?3,updated_at=?1 WHERE id=?4 AND execution_id=?5 AND status='dispatching'",params![finished,code,message,node_id,execution_id]).map_err(db)?;
    if changed != 1 {
        return Err("终止插件节点未处于发送中状态".into());
    }
    tx.execute("UPDATE workflow_executions SET status='interrupted',finished_at=?1,duration_ms=CAST((julianday(?1)-julianday(started_at))*86400000 AS INTEGER),error_code=?2,error_message=?3 WHERE id=?4 AND status='running'",params![finished,code,message,execution_id]).map_err(db)?;
    notifications::repository::create_execution_terminal(&tx, execution_id, "interrupted")?;
    tx.commit().map_err(db)
}

pub fn fail(
    connection: &mut Connection,
    execution_id: &str,
    node_position: i64,
    code: &str,
    message: &str,
) -> Result<(), String> {
    let tx = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(db)?;
    let finished = now();
    tx.execute("UPDATE node_executions SET status='failed',started_at=COALESCE(started_at,?1),finished_at=?1,duration_ms=CAST((julianday(?1)-julianday(COALESCE(started_at,?1)))*86400000 AS INTEGER),error_code=?2,error_message=?3,updated_at=?1 WHERE execution_id=?4 AND position=?5 AND status IN ('pending','running','dispatching')",params![finished,code,message,execution_id,node_position]).map_err(db)?;
    tx.execute("UPDATE node_executions SET status='skipped_due_to_failure',updated_at=?1 WHERE execution_id=?2 AND position>?3 AND status='pending'",params![finished,execution_id,node_position]).map_err(db)?;
    tx.execute("UPDATE workflow_executions SET status='failed',started_at=COALESCE(started_at,?1),finished_at=?1,duration_ms=CAST((julianday(?1)-julianday(COALESCE(started_at,?1)))*86400000 AS INTEGER),error_code=?2,error_message=?3 WHERE id=?4 AND status IN ('pending','running')",params![finished,code,message,execution_id]).map_err(db)?;
    notifications::repository::create_execution_terminal(&tx, execution_id, "failed")?;
    tx.commit().map_err(db)
}

pub fn list(connection: &Connection, workflow_id: &str) -> Result<Vec<ExecutionSummary>, String> {
    let mut s=connection.prepare("SELECT id,workflow_id,workflow_version_id,workflow_name,version_number,trigger_type,schedule_id,scheduled_for,status,created_at,started_at,finished_at,duration_ms,error_code,error_message FROM workflow_executions WHERE workflow_id=?1 ORDER BY created_at DESC LIMIT 100").map_err(db)?;
    let rows = s.query_map(params![workflow_id], map_summary).map_err(db)?;
    rows.collect::<Result<_, _>>().map_err(db)
}

pub fn detail(
    connection: &Connection,
    id: &str,
) -> Result<(ExecutionDetail, Vec<ExecutionArtifact>), String> {
    let summary=connection.query_row("SELECT id,workflow_id,workflow_version_id,workflow_name,version_number,trigger_type,schedule_id,scheduled_for,status,created_at,started_at,finished_at,duration_ms,error_code,error_message FROM workflow_executions WHERE id=?1",params![id],map_summary).optional().map_err(db)?.ok_or_else(||"执行记录不存在".to_string())?;
    let source=connection.query_row("SELECT environment_id,instance_id,instance_name,database_name,database_type,schema_name FROM workflow_executions WHERE id=?1",params![id],|r|Ok(ExecutionDataSource{environment_id:r.get(0)?,instance_id:r.get(1)?,instance_name:r.get(2)?,database_name:r.get(3)?,database_type:r.get(4)?,schema_name:r.get(5)?})).map_err(db)?;
    let mut ns=connection.prepare("SELECT id,version_node_id,position,node_kind,name,status,input_artifact_id,output_artifact_id,started_at,finished_at,duration_ms,summary,error_code,error_message FROM node_executions WHERE execution_id=?1 ORDER BY position").map_err(db)?;
    let nodes = ns
        .query_map(params![id], |r| {
            Ok(NodeExecutionDetail {
                id: r.get(0)?,
                version_node_id: r.get(1)?,
                position: r.get(2)?,
                node_kind: r.get(3)?,
                name: r.get(4)?,
                status: NodeExecutionStatus::parse(&r.get::<_, String>(5)?).map_err(conv)?,
                input_artifact_id: r.get(6)?,
                output_artifact_id: r.get(7)?,
                started_at: r.get(8)?,
                finished_at: r.get(9)?,
                duration_ms: r.get(10)?,
                summary: r.get(11)?,
                error_code: r.get(12)?,
                error_message: r.get(13)?,
            })
        })
        .map_err(db)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db)?;
    let mut ars=connection.prepare("SELECT id,execution_id,producer_node_execution_id,artifact_type,encoding,content_blob,file_reference,row_count,byte_size,sha256,summary,contains_sensitive_data,created_at FROM execution_artifacts WHERE execution_id=?1 ORDER BY created_at").map_err(db)?;
    let artifacts = ars
        .query_map(params![id], |r| {
            Ok(ExecutionArtifact {
                id: r.get(0)?,
                execution_id: r.get(1)?,
                producer_node_execution_id: r.get(2)?,
                artifact_type: ArtifactType::parse(&r.get::<_, String>(3)?).map_err(conv)?,
                encoding: ArtifactEncoding::parse(&r.get::<_, String>(4)?).map_err(conv)?,
                content: r.get(5)?,
                file_reference: r.get(6)?,
                row_count: r.get(7)?,
                byte_size: r.get(8)?,
                sha256: r.get(9)?,
                summary: r.get(10)?,
                contains_sensitive_data: r.get::<_, i64>(11)? != 0,
                created_at: r.get(12)?,
            })
        })
        .map_err(db)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db)?;
    Ok((
        ExecutionDetail {
            summary,
            data_source: source,
            nodes,
        },
        artifacts,
    ))
}

pub fn interrupt_running(connection: &mut Connection) -> Result<usize, String> {
    let tx = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(db)?;
    let execution_ids: Vec<String> = {
        let mut statement = tx
            .prepare("SELECT id FROM workflow_executions WHERE status='running'")
            .map_err(db)?;
        let rows: Vec<String> = statement
            .query_map([], |row| row.get(0))
            .map_err(db)?
            .collect::<Result<_, _>>()
            .map_err(db)?;
        rows
    };
    let timestamp = now();
    tx.execute("UPDATE node_executions SET status='interrupted',finished_at=?1,updated_at=?1,error_code='PROCESS_RESTARTED',error_message='应用重启导致执行中断' WHERE status IN ('running','dispatching')",params![timestamp]).map_err(db)?;
    tx.execute("UPDATE workflow_executions SET status='interrupted',finished_at=?1,error_code='PROCESS_RESTARTED',error_message='应用重启导致执行中断' WHERE status='running'",params![timestamp]).map_err(db)?;
    for execution_id in &execution_ids {
        notifications::repository::create_execution_terminal(&tx, execution_id, "interrupted")?;
    }
    tx.commit().map_err(db)?;
    Ok(execution_ids.len())
}

fn map_summary(r: &rusqlite::Row<'_>) -> rusqlite::Result<ExecutionSummary> {
    Ok(ExecutionSummary {
        id: r.get(0)?,
        workflow_id: r.get(1)?,
        workflow_version_id: r.get(2)?,
        workflow_name: r.get(3)?,
        version_number: r.get(4)?,
        trigger_type: TriggerType::parse(&r.get::<_, String>(5)?).map_err(conv)?,
        schedule_id: r.get(6)?,
        scheduled_for: r.get(7)?,
        status: ExecutionStatus::parse(&r.get::<_, String>(8)?).map_err(conv)?,
        created_at: r.get(9)?,
        started_at: r.get(10)?,
        finished_at: r.get(11)?,
        duration_ms: r.get(12)?,
        error_code: r.get(13)?,
        error_message: r.get(14)?,
    })
}
fn conv(message: String) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, message.into())
}
fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    format!("{:x}", Sha256::digest(bytes))
}
fn new_id() -> String {
    Uuid::new_v4().to_string()
}
fn now() -> String {
    Utc::now().to_rfc3339()
}
fn db(e: rusqlite::Error) -> String {
    format!("workflow.db 操作失败：{e}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::WorkflowDb;

    fn database() -> (tempfile::TempDir, WorkflowDb) {
        let dir = tempfile::tempdir().unwrap();
        let db = WorkflowDb::initialize(dir.path().join("workflow.db")).unwrap();
        let connection = db.open_connection().unwrap();
        connection.execute("INSERT INTO workflow_definitions(id,name,description,environment_id,instance_id,instance_name,database_name,database_type,draft_revision,enabled,created_at,updated_at) VALUES('w','流程','', 'env','1','db','app','mysql',1,1,'now','now')", []).unwrap();
        connection.execute("INSERT INTO workflow_versions(id,workflow_id,version_number,source_draft_revision,name,description,environment_id,instance_id,instance_name,database_name,database_type,published_at) VALUES('v','w',1,1,'流程','', 'env','1','db','app','mysql','now')", []).unwrap();
        connection.execute("INSERT INTO workflow_version_nodes(id,version_id,source_draft_node_id,position,node_kind,name,category,terminal,output_type,config_cbor) VALUES('vn','v','draft',0,'sql','SQL','sql',0,'table',X'01')", []).unwrap();
        connection
            .execute(
                "UPDATE workflow_definitions SET active_version_id='v' WHERE id='w'",
                [],
            )
            .unwrap();
        (dir, db)
    }

    #[test]
    fn creates_records_and_claims_only_once() {
        let (_dir, db) = database();
        let created = create_manual(&mut db.open_connection().unwrap(), "w").unwrap();
        claim(
            &mut db.open_connection().unwrap(),
            &created.id,
            &created.sql_node_id,
        )
        .unwrap();
        assert!(claim(
            &mut db.open_connection().unwrap(),
            &created.id,
            &created.sql_node_id
        )
        .is_err());
        let detail = detail(&db.open_connection().unwrap(), &created.id)
            .unwrap()
            .0;
        assert_eq!(detail.summary.status, ExecutionStatus::Running);
        assert_eq!(detail.nodes.len(), 1);
    }

    #[test]
    fn startup_marks_running_execution_interrupted() {
        let (_dir, db) = database();
        let created = create_manual(&mut db.open_connection().unwrap(), "w").unwrap();
        claim(
            &mut db.open_connection().unwrap(),
            &created.id,
            &created.sql_node_id,
        )
        .unwrap();
        assert_eq!(
            interrupt_running(&mut db.open_connection().unwrap()).unwrap(),
            1
        );
        let detail = detail(&db.open_connection().unwrap(), &created.id)
            .unwrap()
            .0;
        assert_eq!(detail.summary.status, ExecutionStatus::Interrupted);
    }

    #[test]
    fn failure_creates_one_deduplicated_application_message() {
        let (_dir, db) = database();
        let created = create_manual(&mut db.open_connection().unwrap(), "w").unwrap();
        claim(
            &mut db.open_connection().unwrap(),
            &created.id,
            &created.sql_node_id,
        )
        .unwrap();
        fail(
            &mut db.open_connection().unwrap(),
            &created.id,
            0,
            "SQL_FAILED",
            "SQL 执行失败",
        )
        .unwrap();
        let messages =
            crate::notifications::repository::list(&db.open_connection().unwrap()).unwrap();
        assert_eq!(messages.len(), 1);
        assert_eq!(
            messages[0].execution_id.as_deref(),
            Some(created.id.as_str())
        );
        assert_eq!(messages[0].severity, "error");
        assert!(!messages[0].content.contains("SELECT"));
    }
}
