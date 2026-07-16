use std::{path::PathBuf, time::Duration};

use rusqlite::Connection;

use super::migrations;

const BUSY_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Clone)]
pub struct WorkflowDb {
    path: PathBuf,
}

impl WorkflowDb {
    pub fn initialize(path: PathBuf) -> Result<Self, String> {
        let database = Self { path };
        let mut connection = database.open_connection()?;
        migrations::migrate(&mut connection)?;
        Ok(database)
    }

    pub fn open_connection(&self) -> Result<Connection, String> {
        let connection = Connection::open(&self.path)
            .map_err(|error| format!("打开 workflow.db 失败：{error}"))?;
        configure_connection(&connection)?;
        Ok(connection)
    }
}

fn configure_connection(connection: &Connection) -> Result<(), String> {
    connection
        .busy_timeout(BUSY_TIMEOUT)
        .map_err(|error| format!("配置 workflow.db busy timeout 失败：{error}"))?;
    connection
        .execute_batch(
            "PRAGMA foreign_keys = ON;
             PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;",
        )
        .map_err(|error| format!("配置 workflow.db 连接失败：{error}"))?;
    verify_connection(connection)
}

fn verify_connection(connection: &Connection) -> Result<(), String> {
    let foreign_keys: i64 = connection
        .query_row("PRAGMA foreign_keys", [], |row| row.get(0))
        .map_err(|error| format!("检查 workflow.db 外键配置失败：{error}"))?;
    if foreign_keys != 1 {
        return Err("workflow.db 外键未启用".into());
    }
    let journal_mode: String = connection
        .query_row("PRAGMA journal_mode", [], |row| row.get(0))
        .map_err(|error| format!("检查 workflow.db WAL 配置失败：{error}"))?;
    if !journal_mode.eq_ignore_ascii_case("wal") {
        return Err(format!("workflow.db WAL 未启用，当前模式：{journal_mode}"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn initializes_idempotently_with_required_pragmas() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("workflow.db");
        let database = WorkflowDb::initialize(path.clone()).unwrap();
        WorkflowDb::initialize(path).unwrap();
        let connection = database.open_connection().unwrap();
        let version: i64 = connection
            .query_row("SELECT MAX(version) FROM schema_migrations", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(version, 7);
    }

    #[test]
    fn reports_invalid_database_path() {
        let directory = tempdir().unwrap();
        assert!(WorkflowDb::initialize(directory.path().to_path_buf()).is_err());
    }
}
