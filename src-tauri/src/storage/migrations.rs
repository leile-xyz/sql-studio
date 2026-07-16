use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};

pub struct Migration {
    pub version: i64,
    pub sql: &'static str,
}

const MIGRATIONS: &[Migration] = &[Migration {
    version: 1,
    sql: "CREATE TABLE workflow_storage_metadata (
            key TEXT PRIMARY KEY NOT NULL,
            value TEXT NOT NULL
          );",
}, Migration {
    version: 2,
    sql: "CREATE TABLE plugin_resources (
             id TEXT PRIMARY KEY NOT NULL,
             plugin_key TEXT NOT NULL,
             name TEXT NOT NULL,
             enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
             credential_ref TEXT,
             config_cbor BLOB NOT NULL,
             created_at TEXT NOT NULL,
             updated_at TEXT NOT NULL,
             deleted_at TEXT,
             UNIQUE(plugin_key, name)
           );
           CREATE TABLE workflow_versions (
             id TEXT PRIMARY KEY NOT NULL,
             workflow_id TEXT NOT NULL,
             version_number INTEGER NOT NULL CHECK(version_number > 0),
             source_draft_revision INTEGER NOT NULL,
             name TEXT NOT NULL,
             description TEXT NOT NULL,
             environment_id TEXT NOT NULL,
             instance_id TEXT NOT NULL,
             instance_name TEXT NOT NULL,
             database_name TEXT NOT NULL,
             database_type TEXT NOT NULL,
             schema_name TEXT,
             published_at TEXT NOT NULL,
             UNIQUE(workflow_id, version_number),
             FOREIGN KEY(workflow_id) REFERENCES workflow_definitions(id) ON DELETE RESTRICT
           );
           CREATE TABLE workflow_definitions (
             id TEXT PRIMARY KEY NOT NULL,
             name TEXT NOT NULL CHECK(length(trim(name)) > 0),
             description TEXT NOT NULL DEFAULT '',
             environment_id TEXT NOT NULL,
             instance_id TEXT NOT NULL,
             instance_name TEXT NOT NULL,
             database_name TEXT NOT NULL,
             database_type TEXT NOT NULL,
             schema_name TEXT,
             draft_revision INTEGER NOT NULL DEFAULT 1 CHECK(draft_revision > 0),
             active_version_id TEXT,
             enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
             created_at TEXT NOT NULL,
             updated_at TEXT NOT NULL,
             deleted_at TEXT,
             FOREIGN KEY(active_version_id) REFERENCES workflow_versions(id)
           );
           CREATE TABLE workflow_draft_nodes (
             id TEXT PRIMARY KEY NOT NULL,
             workflow_id TEXT NOT NULL,
             position INTEGER NOT NULL CHECK(position >= 0),
             node_kind TEXT NOT NULL CHECK(node_kind IN ('sql','plugin')),
             name TEXT NOT NULL,
             plugin_resource_id TEXT,
             plugin_key TEXT,
             category TEXT NOT NULL CHECK(category IN ('sql','transform','sink')),
             terminal INTEGER NOT NULL CHECK(terminal IN (0,1)),
             input_type TEXT,
             output_type TEXT NOT NULL,
             config_cbor BLOB NOT NULL,
             created_at TEXT NOT NULL,
             updated_at TEXT NOT NULL,
             UNIQUE(workflow_id, position),
             FOREIGN KEY(workflow_id) REFERENCES workflow_definitions(id) ON DELETE CASCADE,
             FOREIGN KEY(plugin_resource_id) REFERENCES plugin_resources(id),
             CHECK ((node_kind='sql' AND position=0 AND plugin_resource_id IS NULL AND plugin_key IS NULL AND category='sql' AND terminal=0)
                 OR (node_kind='plugin' AND position>0 AND plugin_resource_id IS NOT NULL AND plugin_key IS NOT NULL AND category IN ('transform','sink')))
           );
           CREATE TABLE workflow_version_nodes (
             id TEXT PRIMARY KEY NOT NULL,
             version_id TEXT NOT NULL,
             source_draft_node_id TEXT NOT NULL,
             position INTEGER NOT NULL CHECK(position >= 0),
             node_kind TEXT NOT NULL,
             name TEXT NOT NULL,
             plugin_resource_id TEXT,
             plugin_key TEXT,
             plugin_resource_name TEXT,
             category TEXT NOT NULL,
             terminal INTEGER NOT NULL CHECK(terminal IN (0,1)),
             input_type TEXT,
             output_type TEXT NOT NULL,
             config_cbor BLOB NOT NULL,
             UNIQUE(version_id, position),
             FOREIGN KEY(version_id) REFERENCES workflow_versions(id) ON DELETE RESTRICT,
             FOREIGN KEY(plugin_resource_id) REFERENCES plugin_resources(id) ON DELETE RESTRICT
           );
           CREATE TRIGGER immutable_workflow_versions_update BEFORE UPDATE ON workflow_versions BEGIN SELECT RAISE(ABORT, 'published workflow version is immutable'); END;
           CREATE TRIGGER immutable_workflow_versions_delete BEFORE DELETE ON workflow_versions BEGIN SELECT RAISE(ABORT, 'published workflow version is immutable'); END;
           CREATE TRIGGER immutable_workflow_version_nodes_update BEFORE UPDATE ON workflow_version_nodes BEGIN SELECT RAISE(ABORT, 'published workflow version node is immutable'); END;
           CREATE TRIGGER immutable_workflow_version_nodes_delete BEFORE DELETE ON workflow_version_nodes BEGIN SELECT RAISE(ABORT, 'published workflow version node is immutable'); END;",
}, Migration {
    version: 3,
    sql: "INSERT OR IGNORE INTO plugin_resources(id,plugin_key,name,enabled,credential_ref,config_cbor,created_at,updated_at)
          VALUES ('dingtalk:default','dingtalk','默认钉钉机器人',1,'plugin:dingtalk:default',X'F6',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);",
}, Migration {
    version: 4,
    sql: "CREATE TABLE workflow_executions (
             id TEXT PRIMARY KEY NOT NULL,
             workflow_id TEXT NOT NULL,
             workflow_version_id TEXT NOT NULL,
             workflow_name TEXT NOT NULL,
             version_number INTEGER NOT NULL CHECK(version_number > 0),
             trigger_type TEXT NOT NULL CHECK(trigger_type IN ('manual','schedule')),
             schedule_id TEXT,
             scheduled_for TEXT,
             status TEXT NOT NULL CHECK(status IN ('pending','running','succeeded','failed','cancelled','interrupted')),
             environment_id TEXT NOT NULL,
             instance_id TEXT NOT NULL,
             instance_name TEXT NOT NULL,
             database_name TEXT NOT NULL,
             database_type TEXT NOT NULL,
             schema_name TEXT,
             created_at TEXT NOT NULL,
             started_at TEXT,
             finished_at TEXT,
             duration_ms INTEGER CHECK(duration_ms IS NULL OR duration_ms >= 0),
             error_code TEXT,
             error_message TEXT,
             UNIQUE(schedule_id, scheduled_for),
             FOREIGN KEY(workflow_id) REFERENCES workflow_definitions(id) ON DELETE RESTRICT,
             FOREIGN KEY(workflow_version_id) REFERENCES workflow_versions(id) ON DELETE RESTRICT,
             CHECK ((trigger_type='manual' AND schedule_id IS NULL AND scheduled_for IS NULL)
                 OR (trigger_type='schedule' AND schedule_id IS NOT NULL AND scheduled_for IS NOT NULL))
           );
           CREATE TABLE node_executions (
             id TEXT PRIMARY KEY NOT NULL,
             execution_id TEXT NOT NULL,
             version_node_id TEXT NOT NULL,
             position INTEGER NOT NULL CHECK(position >= 0),
             node_kind TEXT NOT NULL CHECK(node_kind IN ('sql','plugin')),
             name TEXT NOT NULL,
             status TEXT NOT NULL CHECK(status IN ('pending','running','dispatching','succeeded','failed','skipped_due_to_failure','interrupted')),
             input_artifact_id TEXT,
             output_artifact_id TEXT,
             started_at TEXT,
             finished_at TEXT,
             duration_ms INTEGER CHECK(duration_ms IS NULL OR duration_ms >= 0),
             summary TEXT,
             error_code TEXT,
             error_message TEXT,
             created_at TEXT NOT NULL,
             updated_at TEXT NOT NULL,
             UNIQUE(execution_id, position),
             UNIQUE(execution_id, version_node_id),
             UNIQUE(id, execution_id),
             FOREIGN KEY(execution_id) REFERENCES workflow_executions(id) ON DELETE CASCADE,
             FOREIGN KEY(version_node_id) REFERENCES workflow_version_nodes(id) ON DELETE RESTRICT,
             FOREIGN KEY(input_artifact_id, execution_id) REFERENCES execution_artifacts(id, execution_id) ON DELETE RESTRICT,
             FOREIGN KEY(output_artifact_id, execution_id) REFERENCES execution_artifacts(id, execution_id) ON DELETE RESTRICT
           );
           CREATE TABLE execution_artifacts (
             id TEXT PRIMARY KEY NOT NULL,
             execution_id TEXT NOT NULL,
             producer_node_execution_id TEXT NOT NULL,
             artifact_type TEXT NOT NULL CHECK(artifact_type IN ('table','object','text','message','files','none')),
             encoding TEXT NOT NULL CHECK(encoding IN ('cbor','utf8','binary','file')),
             content_blob BLOB,
             file_reference TEXT,
             row_count INTEGER CHECK(row_count IS NULL OR row_count >= 0),
             byte_size INTEGER NOT NULL CHECK(byte_size >= 0),
             sha256 TEXT NOT NULL,
             summary TEXT NOT NULL,
             contains_sensitive_data INTEGER NOT NULL DEFAULT 0 CHECK(contains_sensitive_data IN (0,1)),
             created_at TEXT NOT NULL,
             UNIQUE(id, execution_id),
             UNIQUE(producer_node_execution_id),
             FOREIGN KEY(execution_id) REFERENCES workflow_executions(id) ON DELETE CASCADE,
             FOREIGN KEY(producer_node_execution_id, execution_id) REFERENCES node_executions(id, execution_id) ON DELETE RESTRICT,
             CHECK ((encoding='file' AND file_reference IS NOT NULL AND content_blob IS NULL)
                 OR (encoding<>'file' AND file_reference IS NULL AND content_blob IS NOT NULL))
           );
           CREATE TRIGGER node_output_must_be_own_artifact
           BEFORE UPDATE OF output_artifact_id ON node_executions
           WHEN NEW.output_artifact_id IS NOT NULL
             AND NOT EXISTS (
               SELECT 1 FROM execution_artifacts
               WHERE id=NEW.output_artifact_id
                 AND producer_node_execution_id=NEW.id
                 AND execution_id=NEW.execution_id
             )
           BEGIN SELECT RAISE(ABORT, 'node output artifact must be produced by the same node'); END;
           CREATE INDEX workflow_executions_workflow_created_idx ON workflow_executions(workflow_id, created_at DESC);
           CREATE INDEX workflow_executions_status_created_idx ON workflow_executions(status, created_at DESC);
           CREATE INDEX node_executions_execution_position_idx ON node_executions(execution_id, position);
           CREATE INDEX execution_artifacts_execution_idx ON execution_artifacts(execution_id);",
}, Migration {
    version: 5,
    sql: "INSERT OR IGNORE INTO plugin_resources(id,plugin_key,name,enabled,credential_ref,config_cbor,created_at,updated_at)
          VALUES ('message-builder:default','message_builder','默认消息构建器',1,NULL,
            X'A6656174416C6CF46961744D6F62696C6573806C626F647954656D706C617465717B7B776F726B666C6F772E6E616D657D7D6D656D7074794265686176696F726473656E6466666F726D61746474657874657469746C6560',
             CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);",
}, Migration {
    version: 6,
    sql: "CREATE TABLE app_messages (
             id TEXT PRIMARY KEY NOT NULL,
             message_kind TEXT NOT NULL CHECK(message_kind IN ('workflow_execution','schedule','system')),
             severity TEXT NOT NULL CHECK(severity IN ('info','success','warning','error')),
             title TEXT NOT NULL,
             content TEXT NOT NULL,
             workflow_id TEXT,
             execution_id TEXT,
             dedupe_key TEXT NOT NULL UNIQUE,
             state TEXT NOT NULL DEFAULT 'unread' CHECK(state IN ('unread','read','archived')),
             created_at TEXT NOT NULL,
             read_at TEXT,
             archived_at TEXT,
             FOREIGN KEY(workflow_id) REFERENCES workflow_definitions(id) ON DELETE RESTRICT,
             FOREIGN KEY(execution_id) REFERENCES workflow_executions(id) ON DELETE RESTRICT,
             CHECK ((state='unread' AND read_at IS NULL AND archived_at IS NULL)
                 OR (state='read' AND read_at IS NOT NULL AND archived_at IS NULL)
                 OR (state='archived' AND archived_at IS NOT NULL))
           );
           CREATE TABLE message_deliveries (
             id TEXT PRIMARY KEY NOT NULL,
             message_id TEXT NOT NULL,
             channel TEXT NOT NULL CHECK(channel IN ('in_app','windows')),
             status TEXT NOT NULL CHECK(status IN ('pending','succeeded','failed')),
             attempted_at TEXT,
             error_code TEXT,
             error_message TEXT,
             created_at TEXT NOT NULL,
             updated_at TEXT NOT NULL,
             UNIQUE(message_id,channel),
             FOREIGN KEY(message_id) REFERENCES app_messages(id) ON DELETE CASCADE
           );
           CREATE TABLE message_preferences (
             id TEXT PRIMARY KEY NOT NULL CHECK(id='default'),
             native_success_enabled INTEGER NOT NULL CHECK(native_success_enabled IN (0,1)),
             native_failure_enabled INTEGER NOT NULL CHECK(native_failure_enabled IN (0,1)),
             updated_at TEXT NOT NULL
           );
           INSERT INTO message_preferences(id,native_success_enabled,native_failure_enabled,updated_at)
           VALUES('default',0,1,CURRENT_TIMESTAMP);
           CREATE TRIGGER app_message_content_immutable BEFORE UPDATE ON app_messages
           WHEN OLD.message_kind IS NOT NEW.message_kind OR OLD.severity IS NOT NEW.severity
             OR OLD.title IS NOT NEW.title OR OLD.content IS NOT NEW.content
             OR OLD.workflow_id IS NOT NEW.workflow_id OR OLD.execution_id IS NOT NEW.execution_id
             OR OLD.dedupe_key IS NOT NEW.dedupe_key OR OLD.created_at IS NOT NEW.created_at
           BEGIN SELECT RAISE(ABORT, 'app message content is immutable'); END;
           CREATE INDEX app_messages_state_created_idx ON app_messages(state,created_at DESC);
           CREATE INDEX app_messages_execution_idx ON app_messages(execution_id);
           CREATE INDEX message_deliveries_status_idx ON message_deliveries(status,updated_at);",
}, Migration {
    version: 7,
    sql: "CREATE TABLE workflow_schedules (
             id TEXT PRIMARY KEY NOT NULL,
             workflow_id TEXT NOT NULL UNIQUE,
             workflow_version_id TEXT NOT NULL,
             cron_expression TEXT NOT NULL CHECK(length(trim(cron_expression)) > 0),
             timezone TEXT NOT NULL CHECK(length(trim(timezone)) > 0),
             enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
             next_run_at TEXT,
             last_scheduled_at TEXT,
             last_missed_at TEXT,
             created_at TEXT NOT NULL,
             updated_at TEXT NOT NULL,
             FOREIGN KEY(workflow_id) REFERENCES workflow_definitions(id) ON DELETE RESTRICT,
             FOREIGN KEY(workflow_version_id) REFERENCES workflow_versions(id) ON DELETE RESTRICT,
             CHECK ((enabled=1 AND next_run_at IS NOT NULL)
                 OR (enabled=0 AND next_run_at IS NULL))
           );
           CREATE INDEX workflow_schedules_due_idx
             ON workflow_schedules(enabled,next_run_at);
           CREATE TRIGGER workflow_schedule_version_matches_insert
           BEFORE INSERT ON workflow_schedules
           WHEN NOT EXISTS (
             SELECT 1 FROM workflow_versions
             WHERE id=NEW.workflow_version_id AND workflow_id=NEW.workflow_id
           )
           BEGIN SELECT RAISE(ABORT, 'schedule version must belong to workflow'); END;
           CREATE TRIGGER workflow_schedule_version_matches_update
           BEFORE UPDATE OF workflow_id,workflow_version_id ON workflow_schedules
           WHEN NOT EXISTS (
             SELECT 1 FROM workflow_versions
             WHERE id=NEW.workflow_version_id AND workflow_id=NEW.workflow_id
           )
           BEGIN SELECT RAISE(ABORT, 'schedule version must belong to workflow'); END;
           CREATE TRIGGER scheduled_execution_requires_schedule
           BEFORE INSERT ON workflow_executions
           WHEN NEW.trigger_type='schedule'
             AND NOT EXISTS (SELECT 1 FROM workflow_schedules WHERE id=NEW.schedule_id)
           BEGIN SELECT RAISE(ABORT, 'scheduled execution requires schedule'); END;",
}];

pub fn migrate(connection: &mut Connection) -> Result<(), String> {
    migrate_with(connection, MIGRATIONS)
}

fn migrate_with(connection: &mut Connection, migrations: &[Migration]) -> Result<(), String> {
    validate_migration_order(migrations)?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| format!("开始 workflow.db 迁移事务失败：{error}"))?;
    create_migration_table(&transaction)?;
    let current = current_version(&transaction)?;
    let supported = migrations.last().map_or(0, |migration| migration.version);
    if current > supported {
        return Err(format!(
            "workflow.db 版本 {current} 高于当前程序支持版本 {supported}"
        ));
    }
    for migration in migrations.iter().filter(|item| item.version > current) {
        transaction.execute_batch(migration.sql).map_err(|error| {
            format!("应用 workflow.db 迁移 {} 失败：{error}", migration.version)
        })?;
        transaction
            .execute(
                "INSERT INTO schema_migrations(version, applied_at) VALUES (?1, CURRENT_TIMESTAMP)",
                params![migration.version],
            )
            .map_err(|error| format!("记录 workflow.db 迁移版本失败：{error}"))?;
    }
    transaction
        .commit()
        .map_err(|error| format!("提交 workflow.db 迁移失败：{error}"))
}

fn create_migration_table(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS schema_migrations (
               version INTEGER PRIMARY KEY NOT NULL,
               applied_at TEXT NOT NULL
             );",
        )
        .map_err(|error| format!("创建 workflow.db 迁移表失败：{error}"))
}

fn current_version(connection: &Connection) -> Result<i64, String> {
    connection
        .query_row("SELECT MAX(version) FROM schema_migrations", [], |row| {
            row.get(0)
        })
        .optional()
        .map(|value| value.flatten().unwrap_or(0))
        .map_err(|error| format!("读取 workflow.db 迁移版本失败：{error}"))
}

fn validate_migration_order(migrations: &[Migration]) -> Result<(), String> {
    for (index, migration) in migrations.iter().enumerate() {
        let expected = index as i64 + 1;
        if migration.version != expected {
            return Err(format!(
                "workflow.db 迁移版本不连续：期望 {expected}，实际 {}",
                migration.version
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rolls_back_failed_migration_batch() {
        let mut connection = Connection::open_in_memory().unwrap();
        let migrations = [
            Migration {
                version: 1,
                sql: "CREATE TABLE first_table(id INTEGER PRIMARY KEY);",
            },
            Migration {
                version: 2,
                sql: "INVALID SQL",
            },
        ];
        assert!(migrate_with(&mut connection, &migrations).is_err());
        let count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE name = 'first_table'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn rejects_non_contiguous_versions() {
        let migrations = [Migration {
            version: 2,
            sql: "SELECT 1;",
        }];
        assert!(validate_migration_order(&migrations).is_err());
    }
}
