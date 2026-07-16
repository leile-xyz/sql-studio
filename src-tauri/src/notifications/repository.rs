use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension, Row, Transaction, TransactionBehavior};
use uuid::Uuid;

use super::domain::{AppMessage, MessagePreferences, NewMessage, UpdateMessagePreferences};

const MAX_TITLE_CHARS: usize = 120;
const MAX_CONTENT_CHARS: usize = 500;

pub struct DeliveryUpdate<'a> {
    pub message_id: &'a str,
    pub status: &'a str,
    pub error_code: Option<&'a str>,
    pub error_message: Option<&'a str>,
}

pub fn create(connection: &mut Connection, input: &NewMessage) -> Result<String, String> {
    validate_message(input)?;
    let tx = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(db)?;
    let id = insert_message(&tx, input)?;
    tx.commit().map_err(db)?;
    Ok(id)
}

pub fn create_execution_terminal(
    tx: &Transaction<'_>,
    execution_id: &str,
    status: &str,
) -> Result<String, String> {
    let snapshot: (String, String, i64) = tx
        .query_row(
            "SELECT workflow_id,workflow_name,version_number FROM workflow_executions WHERE id=?1",
            params![execution_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .map_err(db)?;
    let input = terminal_message(execution_id, status, snapshot)?;
    validate_message(&input)?;
    insert_message(tx, &input)
}

pub fn create_execution_terminal_connection(
    connection: &mut Connection,
    execution_id: &str,
    status: &str,
) -> Result<String, String> {
    let tx = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(db)?;
    let id = create_execution_terminal(&tx, execution_id, status)?;
    tx.commit().map_err(db)?;
    Ok(id)
}

pub fn list(connection: &Connection) -> Result<Vec<AppMessage>, String> {
    let mut statement = connection.prepare(
        "SELECT id,message_kind,severity,title,content,workflow_id,execution_id,state,created_at,read_at
         FROM app_messages WHERE state<>'archived' ORDER BY created_at DESC LIMIT 100",
    ).map_err(db)?;
    let rows = statement
        .query_map([], map_message)
        .map_err(db)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db);
    rows
}

pub fn get(connection: &Connection, id: &str) -> Result<AppMessage, String> {
    connection
        .query_row(
            "SELECT id,message_kind,severity,title,content,workflow_id,execution_id,state,created_at,read_at FROM app_messages WHERE id=?1",
            params![id],
            map_message,
        )
        .optional()
        .map_err(db)?
        .ok_or_else(|| "通知不存在".to_string())
}

pub fn unread_count(connection: &Connection) -> Result<i64, String> {
    connection
        .query_row(
            "SELECT COUNT(*) FROM app_messages WHERE state='unread'",
            [],
            |row| row.get(0),
        )
        .map_err(db)
}

pub fn mark_read(connection: &Connection, id: &str) -> Result<(), String> {
    let changed = connection
        .execute(
            "UPDATE app_messages SET state='read',read_at=?1 WHERE id=?2 AND state='unread'",
            params![now(), id],
        )
        .map_err(db)?;
    if changed == 1 || get(connection, id)?.state == "read" {
        return Ok(());
    }
    Err("通知状态无法标记为已读".into())
}

pub fn mark_all_read(connection: &Connection) -> Result<usize, String> {
    connection
        .execute(
            "UPDATE app_messages SET state='read',read_at=?1 WHERE state='unread'",
            params![now()],
        )
        .map_err(db)
}

pub fn preferences(connection: &Connection) -> Result<MessagePreferences, String> {
    connection
        .query_row(
            "SELECT native_success_enabled,native_failure_enabled FROM message_preferences WHERE id='default'",
            [],
            |row| Ok(MessagePreferences {
                native_success_enabled: row.get::<_, i64>(0)? != 0,
                native_failure_enabled: row.get::<_, i64>(1)? != 0,
            }),
        )
        .map_err(db)
}

pub fn update_preferences(
    connection: &Connection,
    input: &UpdateMessagePreferences,
) -> Result<(), String> {
    connection
        .execute(
            "UPDATE message_preferences SET native_success_enabled=?1,native_failure_enabled=?2,updated_at=?3 WHERE id='default'",
            params![input.native_success_enabled as i64,input.native_failure_enabled as i64,now()],
        )
        .map_err(db)?;
    Ok(())
}

pub fn record_windows_delivery(
    connection: &Connection,
    update: &DeliveryUpdate<'_>,
) -> Result<(), String> {
    if !matches!(update.status, "pending" | "succeeded" | "failed") {
        return Err("原生通知投递状态无效".into());
    }
    let timestamp = now();
    connection.execute(
        "INSERT INTO message_deliveries(id,message_id,channel,status,attempted_at,error_code,error_message,created_at,updated_at)
         VALUES(?1,?2,'windows',?3,?4,?5,?6,?4,?4)
         ON CONFLICT(message_id,channel) DO UPDATE SET status=excluded.status,attempted_at=excluded.attempted_at,error_code=excluded.error_code,error_message=excluded.error_message,updated_at=excluded.updated_at",
        params![new_id(),update.message_id,update.status,timestamp,update.error_code,update.error_message],
    ).map_err(db)?;
    Ok(())
}

fn insert_message(tx: &Transaction<'_>, input: &NewMessage) -> Result<String, String> {
    let id = new_id();
    let timestamp = now();
    tx.execute(
        "INSERT OR IGNORE INTO app_messages(id,message_kind,severity,title,content,workflow_id,execution_id,dedupe_key,state,created_at)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,'unread',?9)",
        params![id,input.message_kind,input.severity,input.title,input.content,input.workflow_id,input.execution_id,input.dedupe_key,timestamp],
    ).map_err(db)?;
    let stored_id: String = tx
        .query_row(
            "SELECT id FROM app_messages WHERE dedupe_key=?1",
            params![input.dedupe_key],
            |row| row.get(0),
        )
        .map_err(db)?;
    tx.execute(
        "INSERT OR IGNORE INTO message_deliveries(id,message_id,channel,status,attempted_at,created_at,updated_at)
         VALUES(?1,?2,'in_app','succeeded',?3,?3,?3)",
        params![new_id(),stored_id,timestamp],
    ).map_err(db)?;
    Ok(stored_id)
}

fn terminal_message(
    execution_id: &str,
    status: &str,
    snapshot: (String, String, i64),
) -> Result<NewMessage, String> {
    let (severity, title, label) = match status {
        "succeeded" => ("success", "流水线执行成功", "成功"),
        "failed" => ("error", "流水线执行失败", "失败"),
        "interrupted" => ("warning", "流水线执行中断", "中断"),
        _ => return Err(format!("不支持为执行状态 {status} 创建终态通知")),
    };
    Ok(NewMessage {
        message_kind: "workflow_execution".into(),
        severity: severity.into(),
        title: title.into(),
        content: format!("流程「{}」v{}执行{label}", snapshot.1, snapshot.2),
        workflow_id: Some(snapshot.0),
        execution_id: Some(execution_id.into()),
        dedupe_key: format!("workflow_execution:{execution_id}:{status}"),
    })
}

fn validate_message(input: &NewMessage) -> Result<(), String> {
    if !matches!(
        input.message_kind.as_str(),
        "workflow_execution" | "schedule" | "system"
    ) || !matches!(
        input.severity.as_str(),
        "info" | "success" | "warning" | "error"
    ) {
        return Err("通知类型或级别无效".into());
    }
    if input.title.trim().is_empty()
        || input.title.chars().count() > MAX_TITLE_CHARS
        || input.content.trim().is_empty()
        || input.content.chars().count() > MAX_CONTENT_CHARS
        || input.dedupe_key.trim().is_empty()
    {
        return Err("通知标题、内容或去重键无效".into());
    }
    Ok(())
}

fn map_message(row: &Row<'_>) -> rusqlite::Result<AppMessage> {
    Ok(AppMessage {
        id: row.get(0)?,
        message_kind: row.get(1)?,
        severity: row.get(2)?,
        title: row.get(3)?,
        content: row.get(4)?,
        workflow_id: row.get(5)?,
        execution_id: row.get(6)?,
        state: row.get(7)?,
        created_at: row.get(8)?,
        read_at: row.get(9)?,
    })
}

fn new_id() -> String {
    Uuid::new_v4().to_string()
}

fn now() -> String {
    Utc::now().to_rfc3339()
}

fn db(error: rusqlite::Error) -> String {
    format!("workflow.db 通知操作失败：{error}")
}

#[cfg(test)]
mod terminal_tests {
    use super::*;
    use crate::storage::WorkflowDb;

    fn database() -> (tempfile::TempDir, WorkflowDb) {
        let dir = tempfile::tempdir().unwrap();
        let db = WorkflowDb::initialize(dir.path().join("workflow.db")).unwrap();
        (dir, db)
    }

    fn sample_message() -> NewMessage {
        NewMessage {
            message_kind: "system".into(),
            severity: "warning".into(),
            title: "后台任务异常".into(),
            content: "后台任务已中断，请打开应用查看详情".into(),
            workflow_id: None,
            execution_id: None,
            dedupe_key: "system:test:warning".into(),
        }
    }

    #[test]
    fn deduplicates_messages_and_persists_unread_state() {
        let (_dir, db) = database();
        let first = create(&mut db.open_connection().unwrap(), &sample_message()).unwrap();
        let second = create(&mut db.open_connection().unwrap(), &sample_message()).unwrap();
        assert_eq!(first, second);
        assert_eq!(unread_count(&db.open_connection().unwrap()).unwrap(), 1);
        mark_read(&db.open_connection().unwrap(), &first).unwrap();
        assert_eq!(unread_count(&db.open_connection().unwrap()).unwrap(), 0);
        assert!(get(&db.open_connection().unwrap(), &first)
            .unwrap()
            .read_at
            .is_some());
    }

    #[test]
    fn message_content_is_immutable_and_preferences_are_explicit() {
        let (_dir, db) = database();
        let id = create(&mut db.open_connection().unwrap(), &sample_message()).unwrap();
        let connection = db.open_connection().unwrap();
        assert!(connection
            .execute(
                "UPDATE app_messages SET content='changed' WHERE id=?1",
                params![id],
            )
            .is_err());
        let defaults = preferences(&connection).unwrap();
        assert!(!defaults.native_success_enabled);
        assert!(defaults.native_failure_enabled);
        update_preferences(
            &connection,
            &UpdateMessagePreferences {
                native_success_enabled: true,
                native_failure_enabled: false,
            },
        )
        .unwrap();
        assert_eq!(
            preferences(&connection).unwrap(),
            MessagePreferences {
                native_success_enabled: true,
                native_failure_enabled: false,
            }
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::WorkflowDb;

    fn database() -> (tempfile::TempDir, WorkflowDb, String) {
        let dir = tempfile::tempdir().unwrap();
        let db = WorkflowDb::initialize(dir.path().join("workflow.db")).unwrap();
        let connection = db.open_connection().unwrap();
        connection.execute("INSERT INTO workflow_definitions(id,name,description,environment_id,instance_id,instance_name,database_name,database_type,draft_revision,enabled,created_at,updated_at) VALUES('w','日报','', 'env','1','db','app','mysql',1,1,'now','now')", []).unwrap();
        connection.execute("INSERT INTO workflow_versions(id,workflow_id,version_number,source_draft_revision,name,description,environment_id,instance_id,instance_name,database_name,database_type,published_at) VALUES('v','w',1,1,'日报','', 'env','1','db','app','mysql','now')", []).unwrap();
        connection.execute("INSERT INTO workflow_executions(id,workflow_id,workflow_version_id,workflow_name,version_number,trigger_type,status,environment_id,instance_id,instance_name,database_name,database_type,created_at) VALUES('e','w','v','日报',1,'manual','succeeded','env','1','db','app','mysql','now')", []).unwrap();
        (dir, db, "e".into())
    }

    #[test]
    fn persists_unread_message_and_deduplicates_terminal_event() {
        let (_dir, db, execution_id) = database();
        let first = create_execution_terminal_connection(
            &mut db.open_connection().unwrap(),
            &execution_id,
            "succeeded",
        )
        .unwrap();
        let second = create_execution_terminal_connection(
            &mut db.open_connection().unwrap(),
            &execution_id,
            "succeeded",
        )
        .unwrap();
        assert_eq!(first, second);
        assert_eq!(unread_count(&db.open_connection().unwrap()).unwrap(), 1);
        mark_read(&db.open_connection().unwrap(), &first).unwrap();
        assert_eq!(unread_count(&db.open_connection().unwrap()).unwrap(), 0);
    }
}
