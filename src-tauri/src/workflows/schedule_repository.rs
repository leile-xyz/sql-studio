use chrono::{DateTime, Utc};
use rusqlite::{params, Connection, OptionalExtension, Row, Transaction, TransactionBehavior};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::schedule_domain;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpsertScheduleInput {
    pub workflow_id: String,
    pub cron_expression: String,
    pub timezone: String,
    pub enabled: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetScheduleEnabledInput {
    pub workflow_id: String,
    pub enabled: bool,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowSchedule {
    pub id: String,
    pub workflow_id: String,
    pub workflow_version_id: String,
    pub cron_expression: String,
    pub timezone: String,
    pub enabled: bool,
    pub next_run_at: Option<String>,
    pub last_scheduled_at: Option<String>,
    pub last_missed_at: Option<String>,
    pub last_execution_status: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NextDueSchedule {
    pub schedule_id: String,
    pub next_run_at: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ScheduledExecution {
    pub execution_id: String,
    pub workflow_id: String,
    pub workflow_version_id: String,
    pub sql_node_execution_id: String,
    pub scheduled_for: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MissedSchedule {
    pub schedule_id: String,
    pub workflow_id: String,
    pub scheduled_for: String,
    pub next_run_at: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DueScheduleResult {
    Enqueued(ScheduledExecution),
    Skipped(MissedSchedule),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ClaimedExecution {
    pub execution_id: String,
    pub workflow_id: String,
    pub workflow_version_id: String,
    pub sql_node_execution_id: String,
}

struct DueSnapshot {
    schedule_id: String,
    workflow_id: String,
    version_id: String,
    cron_expression: String,
    timezone: String,
    scheduled_for: String,
    workflow_enabled: bool,
    workflow_name: String,
    version_number: i64,
    environment_id: String,
    instance_id: String,
    instance_name: String,
    database_name: String,
    database_type: String,
    schema_name: Option<String>,
}

struct ScheduleAdvance<'a> {
    next_run_at: &'a str,
    updated_at: &'a str,
}

pub fn get(connection: &Connection, workflow_id: &str) -> Result<Option<WorkflowSchedule>, String> {
    connection
        .query_row(
            "SELECT s.id,s.workflow_id,s.workflow_version_id,s.cron_expression,s.timezone,
                    s.enabled,s.next_run_at,s.last_scheduled_at,s.last_missed_at,
                    (SELECT e.status FROM workflow_executions e WHERE e.schedule_id=s.id
                     ORDER BY e.scheduled_for DESC LIMIT 1),s.created_at,s.updated_at
             FROM workflow_schedules s WHERE s.workflow_id=?1",
            params![workflow_id],
            map_schedule,
        )
        .optional()
        .map_err(db)
}

pub fn upsert(
    connection: &mut Connection,
    input: &UpsertScheduleInput,
    now: &str,
) -> Result<WorkflowSchedule, String> {
    schedule_domain::validate(&input.cron_expression, &input.timezone)?;
    let now_value = schedule_domain::parse_utc(now)?;
    let next = enabled_next(input.enabled, input, now_value)?;
    let tx = immediate(connection)?;
    let version_id = active_version(&tx, &input.workflow_id)?;
    let id = existing_id(&tx, &input.workflow_id)?.unwrap_or_else(new_id);
    tx.execute(
        "INSERT INTO workflow_schedules(id,workflow_id,workflow_version_id,cron_expression,
         timezone,enabled,next_run_at,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?8)
         ON CONFLICT(workflow_id) DO UPDATE SET workflow_version_id=excluded.workflow_version_id,
         cron_expression=excluded.cron_expression,timezone=excluded.timezone,enabled=excluded.enabled,
         next_run_at=excluded.next_run_at,updated_at=excluded.updated_at",
        params![id,input.workflow_id,version_id,input.cron_expression.trim(),input.timezone.trim(),
            input.enabled as i64,next,now],
    ).map_err(db)?;
    tx.commit().map_err(db)?;
    get(connection, &input.workflow_id)?.ok_or_else(|| "保存调度配置后读取失败".into())
}

pub fn set_enabled(
    connection: &mut Connection,
    input: &SetScheduleEnabledInput,
    now: &str,
) -> Result<WorkflowSchedule, String> {
    let now_value = schedule_domain::parse_utc(now)?;
    let tx = immediate(connection)?;
    let current =
        get(&tx, &input.workflow_id)?.ok_or_else(|| "流程尚未配置定时计划".to_string())?;
    let next = if input.enabled {
        Some(next_string(
            &current.cron_expression,
            &current.timezone,
            now_value,
        )?)
    } else {
        None
    };
    let version_id = if input.enabled {
        active_version(&tx, &input.workflow_id)?
    } else {
        current.workflow_version_id
    };
    tx.execute(
        "UPDATE workflow_schedules SET workflow_version_id=?1,enabled=?2,next_run_at=?3,updated_at=?4
         WHERE workflow_id=?5",
        params![version_id,input.enabled as i64,next,now,input.workflow_id],
    ).map_err(db)?;
    tx.commit().map_err(db)?;
    get(connection, &input.workflow_id)?.ok_or_else(|| "更新调度配置后读取失败".into())
}

pub fn delete(connection: &Connection, workflow_id: &str) -> Result<(), String> {
    let changed = connection
        .execute(
            "DELETE FROM workflow_schedules WHERE workflow_id=?1",
            params![workflow_id],
        )
        .map_err(db)?;
    if changed == 1 {
        Ok(())
    } else {
        Err("流程尚未配置定时计划".into())
    }
}

pub fn next_due(connection: &Connection) -> Result<Option<NextDueSchedule>, String> {
    connection
        .query_row(
            "SELECT id,next_run_at FROM workflow_schedules
             WHERE enabled=1 ORDER BY next_run_at LIMIT 1",
            [],
            |row| {
                Ok(NextDueSchedule {
                    schedule_id: row.get(0)?,
                    next_run_at: row.get(1)?,
                })
            },
        )
        .optional()
        .map_err(db)
}

pub fn enqueue_due(
    connection: &mut Connection,
    now: &str,
) -> Result<Option<DueScheduleResult>, String> {
    let now_value = schedule_domain::parse_utc(now)?;
    let tx = immediate(connection)?;
    let snapshot = match load_due(&tx, now)? {
        Some(value) => value,
        None => return Ok(None),
    };
    let missed_due_time = schedule_domain::parse_utc(&snapshot.scheduled_for)? < now_value;
    let next = next_string(&snapshot.cron_expression, &snapshot.timezone, now_value)?;
    let advance = ScheduleAdvance {
        next_run_at: &next,
        updated_at: now,
    };
    if !snapshot.workflow_enabled || missed_due_time {
        let missed = advance_missed(&tx, &snapshot, &advance)?;
        tx.commit().map_err(db)?;
        return Ok(Some(DueScheduleResult::Skipped(missed)));
    }
    let execution = create_scheduled_execution(&tx, &snapshot, now)?;
    advance_scheduled(&tx, &snapshot, &advance)?;
    tx.commit().map_err(db)?;
    Ok(Some(DueScheduleResult::Enqueued(execution)))
}

pub fn skip_missed(connection: &mut Connection, now: &str) -> Result<Vec<MissedSchedule>, String> {
    let now_value = schedule_domain::parse_utc(now)?;
    let tx = immediate(connection)?;
    let snapshots = load_all_due(&tx, now)?;
    let mut missed = Vec::with_capacity(snapshots.len());
    for snapshot in snapshots {
        let next = next_string(&snapshot.cron_expression, &snapshot.timezone, now_value)?;
        let advance = ScheduleAdvance {
            next_run_at: &next,
            updated_at: now,
        };
        missed.push(advance_missed(&tx, &snapshot, &advance)?);
    }
    tx.commit().map_err(db)?;
    Ok(missed)
}

pub fn claim_next_pending(
    connection: &mut Connection,
    now: &str,
) -> Result<Option<ClaimedExecution>, String> {
    schedule_domain::parse_utc(now)?;
    let tx = immediate(connection)?;
    if has_running(&tx)? {
        return Ok(None);
    }
    let claimed = match first_pending(&tx)? {
        Some(value) => value,
        None => return Ok(None),
    };
    claim_execution(&tx, &claimed, now)?;
    tx.commit().map_err(db)?;
    Ok(Some(claimed))
}

fn enabled_next(
    enabled: bool,
    input: &UpsertScheduleInput,
    after: DateTime<Utc>,
) -> Result<Option<String>, String> {
    if !enabled {
        return Ok(None);
    }
    next_string(&input.cron_expression, &input.timezone, after).map(Some)
}

fn next_string(expression: &str, timezone: &str, after: DateTime<Utc>) -> Result<String, String> {
    schedule_domain::next_run_at(expression, timezone, after).map(schedule_domain::format_utc)
}

fn immediate(connection: &mut Connection) -> Result<Transaction<'_>, String> {
    connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(db)
}

fn active_version(connection: &Connection, workflow_id: &str) -> Result<String, String> {
    connection
        .query_row(
            "SELECT active_version_id FROM workflow_definitions
             WHERE id=?1 AND deleted_at IS NULL",
            params![workflow_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()
        .map_err(db)?
        .flatten()
        .ok_or_else(|| "流程尚未发布或已删除".to_string())
}

fn existing_id(connection: &Connection, workflow_id: &str) -> Result<Option<String>, String> {
    connection
        .query_row(
            "SELECT id FROM workflow_schedules WHERE workflow_id=?1",
            params![workflow_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(db)
}

fn load_due(connection: &Connection, now: &str) -> Result<Option<DueSnapshot>, String> {
    let sql = due_query("LIMIT 1");
    connection
        .query_row(&sql, params![now], map_due)
        .optional()
        .map_err(db)
}

fn load_all_due(connection: &Connection, now: &str) -> Result<Vec<DueSnapshot>, String> {
    let sql = due_query("");
    let mut statement = connection.prepare(&sql).map_err(db)?;
    let rows = statement.query_map(params![now], map_due).map_err(db)?;
    rows.collect::<Result<_, _>>().map_err(db)
}

fn due_query(limit: &str) -> String {
    format!(
        "SELECT s.id,s.workflow_id,s.workflow_version_id,s.cron_expression,s.timezone,s.next_run_at,
         w.enabled,v.name,v.version_number,v.environment_id,v.instance_id,v.instance_name,
         v.database_name,v.database_type,v.schema_name
         FROM workflow_schedules s JOIN workflow_definitions w ON w.id=s.workflow_id
         JOIN workflow_versions v ON v.id=s.workflow_version_id AND v.workflow_id=s.workflow_id
         WHERE s.enabled=1 AND s.next_run_at<=?1 AND w.deleted_at IS NULL ORDER BY s.next_run_at {limit}"
    )
}

fn map_due(row: &Row<'_>) -> rusqlite::Result<DueSnapshot> {
    Ok(DueSnapshot {
        schedule_id: row.get(0)?,
        workflow_id: row.get(1)?,
        version_id: row.get(2)?,
        cron_expression: row.get(3)?,
        timezone: row.get(4)?,
        scheduled_for: row.get(5)?,
        workflow_enabled: row.get::<_, i64>(6)? != 0,
        workflow_name: row.get(7)?,
        version_number: row.get(8)?,
        environment_id: row.get(9)?,
        instance_id: row.get(10)?,
        instance_name: row.get(11)?,
        database_name: row.get(12)?,
        database_type: row.get(13)?,
        schema_name: row.get(14)?,
    })
}

fn create_scheduled_execution(
    tx: &Transaction<'_>,
    snapshot: &DueSnapshot,
    created_at: &str,
) -> Result<ScheduledExecution, String> {
    let execution_id = new_id();
    tx.execute(
        "INSERT INTO workflow_executions(id,workflow_id,workflow_version_id,workflow_name,
         version_number,trigger_type,schedule_id,scheduled_for,status,environment_id,instance_id,
         instance_name,database_name,database_type,schema_name,created_at)
         VALUES(?1,?2,?3,?4,?5,'schedule',?6,?7,'pending',?8,?9,?10,?11,?12,?13,?14)",
        params![
            execution_id,
            snapshot.workflow_id,
            snapshot.version_id,
            snapshot.workflow_name,
            snapshot.version_number,
            snapshot.schedule_id,
            snapshot.scheduled_for,
            snapshot.environment_id,
            snapshot.instance_id,
            snapshot.instance_name,
            snapshot.database_name,
            snapshot.database_type,
            snapshot.schema_name,
            created_at
        ],
    )
    .map_err(db)?;
    let context = ExecutionNodeContext {
        id: &execution_id,
        created_at,
    };
    let sql_node_execution_id = insert_execution_nodes(tx, snapshot, &context)?;
    Ok(ScheduledExecution {
        execution_id,
        workflow_id: snapshot.workflow_id.clone(),
        workflow_version_id: snapshot.version_id.clone(),
        sql_node_execution_id,
        scheduled_for: snapshot.scheduled_for.clone(),
    })
}

fn insert_execution_nodes(
    tx: &Transaction<'_>,
    snapshot: &DueSnapshot,
    execution: &ExecutionNodeContext<'_>,
) -> Result<String, String> {
    let mut statement = tx
        .prepare(
            "SELECT id,position,node_kind,name FROM workflow_version_nodes
         WHERE version_id=?1 ORDER BY position",
        )
        .map_err(db)?;
    let rows = statement
        .query_map(params![snapshot.version_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
            ))
        })
        .map_err(db)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db)?;
    drop(statement);
    if rows.is_empty() {
        return Err("发布版本没有节点".into());
    }
    let mut sql_node_id = None;
    for (version_node_id, position, kind, name) in rows {
        let node_id = new_id();
        if position == 0 {
            sql_node_id = Some(node_id.clone());
        }
        tx.execute(
            "INSERT INTO node_executions(id,execution_id,version_node_id,position,node_kind,name,
             status,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,'pending',?7,?7)",
            params![
                node_id,
                execution.id,
                version_node_id,
                position,
                kind,
                name,
                execution.created_at
            ],
        )
        .map_err(db)?;
    }
    sql_node_id.ok_or_else(|| "发布版本缺少首个 SQL 节点".into())
}

struct ExecutionNodeContext<'a> {
    id: &'a str,
    created_at: &'a str,
}

fn advance_scheduled(
    tx: &Transaction<'_>,
    snapshot: &DueSnapshot,
    advance: &ScheduleAdvance<'_>,
) -> Result<(), String> {
    let changed = tx
        .execute(
            "UPDATE workflow_schedules SET next_run_at=?1,last_scheduled_at=?2,updated_at=?3
         WHERE id=?4 AND next_run_at=?2 AND enabled=1",
            params![
                advance.next_run_at,
                snapshot.scheduled_for,
                advance.updated_at,
                snapshot.schedule_id
            ],
        )
        .map_err(db)?;
    exactly_one(changed, "调度计划已被其他领取者推进")
}

fn advance_missed(
    tx: &Transaction<'_>,
    snapshot: &DueSnapshot,
    advance: &ScheduleAdvance<'_>,
) -> Result<MissedSchedule, String> {
    let changed = tx
        .execute(
            "UPDATE workflow_schedules SET next_run_at=?1,last_missed_at=?2,updated_at=?3
         WHERE id=?4 AND next_run_at=?2 AND enabled=1",
            params![
                advance.next_run_at,
                snapshot.scheduled_for,
                advance.updated_at,
                snapshot.schedule_id
            ],
        )
        .map_err(db)?;
    exactly_one(changed, "错过计划已被其他领取者推进")?;
    Ok(MissedSchedule {
        schedule_id: snapshot.schedule_id.clone(),
        workflow_id: snapshot.workflow_id.clone(),
        scheduled_for: snapshot.scheduled_for.clone(),
        next_run_at: advance.next_run_at.to_string(),
    })
}

fn has_running(connection: &Connection) -> Result<bool, String> {
    connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM workflow_executions WHERE status='running')",
            [],
            |row| row.get(0),
        )
        .map_err(db)
}

fn first_pending(connection: &Connection) -> Result<Option<ClaimedExecution>, String> {
    connection
        .query_row(
            "SELECT e.id,e.workflow_id,e.workflow_version_id,n.id FROM workflow_executions e
         JOIN node_executions n ON n.execution_id=e.id AND n.position=0
         WHERE e.status='pending' AND n.status='pending'
         ORDER BY COALESCE(e.scheduled_for,e.created_at),e.created_at LIMIT 1",
            [],
            |row| {
                Ok(ClaimedExecution {
                    execution_id: row.get(0)?,
                    workflow_id: row.get(1)?,
                    workflow_version_id: row.get(2)?,
                    sql_node_execution_id: row.get(3)?,
                })
            },
        )
        .optional()
        .map_err(db)
}

fn claim_execution(
    tx: &Transaction<'_>,
    claimed: &ClaimedExecution,
    now: &str,
) -> Result<(), String> {
    let execution_changed = tx
        .execute(
            "UPDATE workflow_executions SET status='running',started_at=?1
         WHERE id=?2 AND status='pending'
         AND NOT EXISTS(SELECT 1 FROM workflow_executions WHERE status='running')",
            params![now, claimed.execution_id],
        )
        .map_err(db)?;
    exactly_one(execution_changed, "执行记录已被领取或全局队列繁忙")?;
    let node_changed = tx
        .execute(
            "UPDATE node_executions SET status='running',started_at=?1,updated_at=?1
         WHERE id=?2 AND execution_id=?3 AND status='pending'",
            params![now, claimed.sql_node_execution_id, claimed.execution_id],
        )
        .map_err(db)?;
    exactly_one(node_changed, "SQL 节点状态无效")
}

fn map_schedule(row: &Row<'_>) -> rusqlite::Result<WorkflowSchedule> {
    Ok(WorkflowSchedule {
        id: row.get(0)?,
        workflow_id: row.get(1)?,
        workflow_version_id: row.get(2)?,
        cron_expression: row.get(3)?,
        timezone: row.get(4)?,
        enabled: row.get::<_, i64>(5)? != 0,
        next_run_at: row.get(6)?,
        last_scheduled_at: row.get(7)?,
        last_missed_at: row.get(8)?,
        last_execution_status: row.get(9)?,
        created_at: row.get(10)?,
        updated_at: row.get(11)?,
    })
}

fn exactly_one(changed: usize, message: &str) -> Result<(), String> {
    if changed == 1 {
        Ok(())
    } else {
        Err(message.into())
    }
}

fn db(error: rusqlite::Error) -> String {
    format!("workflow.db 调度操作失败：{error}")
}

fn new_id() -> String {
    Uuid::new_v4().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::migrations;

    const BASE: &str = "2026-07-16T00:00:00Z";
    const DUE: &str = "2026-07-16T00:01:00Z";

    fn connection() -> Connection {
        let mut connection = Connection::open_in_memory().unwrap();
        connection.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
        migrations::migrate(&mut connection).unwrap();
        seed_workflow(&connection, "workflow-1", "version-1");
        connection
    }

    fn seed_workflow(connection: &Connection, workflow: &str, version: &str) {
        connection
            .execute(
                "INSERT INTO workflow_definitions(id,name,description,environment_id,
            instance_id,instance_name,database_name,database_type,draft_revision,enabled,created_at,
            updated_at) VALUES(?1,'日报','','env','instance','实例','database','mysql',1,1,?2,?2)",
                params![workflow, BASE],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO workflow_versions(id,workflow_id,version_number,
            source_draft_revision,name,description,environment_id,instance_id,instance_name,
            database_name,database_type,published_at) VALUES(?1,?2,1,1,'日报','','env','instance',
            '实例','database','mysql',?3)",
                params![version, workflow, BASE],
            )
            .unwrap();
        connection
            .execute(
                "UPDATE workflow_definitions SET active_version_id=?1 WHERE id=?2",
                params![version, workflow],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO workflow_version_nodes(id,version_id,source_draft_node_id,
            position,node_kind,name,category,terminal,output_type,config_cbor)
            VALUES(?1,?2,'draft-node',0,'sql','查询','sql',0,'table',X'80')",
                params![format!("node-{workflow}"), version],
            )
            .unwrap();
    }

    fn input(workflow_id: &str, enabled: bool) -> UpsertScheduleInput {
        UpsertScheduleInput {
            workflow_id: workflow_id.into(),
            cron_expression: "* * * * *".into(),
            timezone: "UTC".into(),
            enabled,
        }
    }

    #[test]
    fn upserts_and_toggles_schedule_with_active_version() {
        let mut connection = connection();
        let schedule = upsert(&mut connection, &input("workflow-1", true), BASE).unwrap();
        assert_eq!(schedule.workflow_version_id, "version-1");
        assert_eq!(schedule.next_run_at.as_deref(), Some(DUE));
        let disabled = set_enabled(
            &mut connection,
            &SetScheduleEnabledInput {
                workflow_id: "workflow-1".into(),
                enabled: false,
            },
            DUE,
        )
        .unwrap();
        assert!(!disabled.enabled);
        assert_eq!(disabled.next_run_at, None);
    }

    #[test]
    fn creates_each_scheduled_execution_once_and_advances_atomically() {
        let mut connection = connection();
        upsert(&mut connection, &input("workflow-1", true), BASE).unwrap();
        let first = enqueue_due(&mut connection, DUE).unwrap().unwrap();
        let execution = match first {
            DueScheduleResult::Enqueued(value) => value,
            DueScheduleResult::Skipped(_) => panic!("workflow should be enqueued"),
        };
        assert_eq!(execution.scheduled_for, DUE);
        assert!(enqueue_due(&mut connection, DUE).unwrap().is_none());
        let count: i64 = connection
            .query_row("SELECT COUNT(*) FROM workflow_executions", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(count, 1);
        let schedule = get(&connection, "workflow-1").unwrap().unwrap();
        assert_eq!(
            schedule.next_run_at.as_deref(),
            Some("2026-07-16T00:02:00Z")
        );
        assert_eq!(schedule.last_execution_status.as_deref(), Some("pending"));
    }

    #[test]
    fn overdue_schedule_is_skipped_without_creating_execution() {
        let mut connection = connection();
        upsert(&mut connection, &input("workflow-1", true), BASE).unwrap();
        let result = enqueue_due(&mut connection, "2026-07-16T00:10:00Z")
            .unwrap()
            .unwrap();
        let missed = match result {
            DueScheduleResult::Skipped(value) => value,
            DueScheduleResult::Enqueued(_) => panic!("overdue schedule must not be enqueued"),
        };
        let count: i64 = connection
            .query_row("SELECT COUNT(*) FROM workflow_executions", [], |row| {
                row.get(0)
            })
            .unwrap();

        assert_eq!(missed.scheduled_for, DUE);
        assert_eq!(missed.next_run_at, "2026-07-16T00:11:00Z");
        assert_eq!(count, 0);
    }

    #[test]
    fn skips_missed_times_without_creating_execution() {
        let mut connection = connection();
        upsert(&mut connection, &input("workflow-1", true), BASE).unwrap();
        let missed = skip_missed(&mut connection, "2026-07-16T00:10:00Z").unwrap();
        assert_eq!(missed.len(), 1);
        assert_eq!(missed[0].scheduled_for, DUE);
        assert_eq!(missed[0].next_run_at, "2026-07-16T00:11:00Z");
        let count: i64 = connection
            .query_row("SELECT COUNT(*) FROM workflow_executions", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn disabled_workflow_due_time_is_skipped() {
        let mut connection = connection();
        connection
            .execute(
                "UPDATE workflow_definitions SET enabled=0 WHERE id='workflow-1'",
                [],
            )
            .unwrap();
        upsert(&mut connection, &input("workflow-1", true), BASE).unwrap();
        assert!(matches!(
            enqueue_due(&mut connection, DUE).unwrap(),
            Some(DueScheduleResult::Skipped(_))
        ));
    }

    #[test]
    fn deleted_workflow_due_time_is_ignored() {
        let mut connection = connection();
        upsert(&mut connection, &input("workflow-1", true), BASE).unwrap();
        connection
            .execute(
                "UPDATE workflow_definitions SET enabled=0,deleted_at=?1 WHERE id='workflow-1'",
                params![BASE],
            )
            .unwrap();
        assert!(enqueue_due(&mut connection, DUE).unwrap().is_none());
        assert!(skip_missed(&mut connection, "2026-07-16T00:10:00Z")
            .unwrap()
            .is_empty());
    }

    #[test]
    fn global_claim_allows_only_one_running_execution() {
        let mut connection = connection();
        seed_workflow(&connection, "workflow-2", "version-2");
        upsert(&mut connection, &input("workflow-1", true), BASE).unwrap();
        upsert(&mut connection, &input("workflow-2", true), BASE).unwrap();
        enqueue_due(&mut connection, DUE).unwrap();
        enqueue_due(&mut connection, DUE).unwrap();
        let claimed = claim_next_pending(&mut connection, DUE).unwrap();
        assert!(claimed.is_some());
        assert!(claim_next_pending(&mut connection, DUE).unwrap().is_none());
        let running: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM workflow_executions WHERE status='running'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(running, 1);
    }

    #[test]
    fn database_rejects_schedule_version_from_another_workflow() {
        let connection = connection();
        seed_workflow(&connection, "workflow-2", "version-2");
        let result = connection.execute(
            "INSERT INTO workflow_schedules(id,workflow_id,
            workflow_version_id,cron_expression,timezone,enabled,next_run_at,created_at,updated_at)
            VALUES('bad','workflow-1','version-2','* * * * *','UTC',1,?1,?1,?1)",
            params![DUE],
        );
        assert!(result.is_err());
    }
}
