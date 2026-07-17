use super::{
    domain::{
        CreateWorkflow, DataSource, PluginResourceInput, PluginResourceSummary,
        PublishWorkflowInput, SetWorkflowEnabledInput, UpdateWorkflow, WorkflowDetail,
        WorkflowNodeInput, WorkflowSummary, WorkflowVersionDetail,
    },
    plugin_registry, validation,
};
use rusqlite::{params, Connection, OptionalExtension, Row, Transaction, TransactionBehavior};
use serde::{de::DeserializeOwned, Serialize};
use serde_json::Value;

pub fn create_workflow(
    connection: &mut Connection,
    input: &CreateWorkflow,
) -> Result<String, String> {
    validate_draft(&input.name, &input.data_source, &input.nodes)?;
    let id = new_id();
    let timestamp = now();
    let tx = connection.transaction().map_err(db)?;
    tx.execute(
        "INSERT INTO workflow_definitions(id,name,description,environment_id,instance_id,instance_name,database_name,database_type,schema_name,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?10)",
        params![id,input.name.trim(),input.description,input.data_source.environment_id,input.data_source.instance_id,input.data_source.instance_name,input.data_source.database_name,input.data_source.database_type,input.data_source.schema_name,timestamp],
    ).map_err(db)?;
    insert_nodes(&tx, &id, &input.nodes, &timestamp)?;
    tx.commit().map_err(db)?;
    Ok(id)
}

pub fn list_workflows(
    connection: &Connection,
    environment_id: &str,
) -> Result<Vec<WorkflowSummary>, String> {
    if environment_id.trim().is_empty() {
        return Err("环境标识不能为空".into());
    }
    let mut statement = connection.prepare("SELECT w.id,w.name,w.description,w.draft_revision,w.active_version_id,w.enabled,s.next_run_at,s.timezone,w.updated_at FROM workflow_definitions w LEFT JOIN workflow_schedules s ON s.workflow_id=w.id WHERE w.environment_id=?1 AND w.deleted_at IS NULL ORDER BY w.updated_at DESC").map_err(db)?;
    let rows = statement
        .query_map(params![environment_id], |row| {
            Ok(WorkflowSummary {
                id: row.get(0)?,
                name: row.get(1)?,
                description: row.get(2)?,
                draft_revision: row.get(3)?,
                active_version_id: row.get(4)?,
                enabled: row.get::<_, i64>(5)? != 0,
                next_run_at: row.get(6)?,
                schedule_timezone: row.get(7)?,
                updated_at: row.get(8)?,
            })
        })
        .map_err(db)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(db)
}

pub fn get_workflow(connection: &Connection, id: &str) -> Result<WorkflowDetail, String> {
    let mut detail = connection.query_row("SELECT id,name,description,environment_id,instance_id,instance_name,database_name,database_type,schema_name,draft_revision,active_version_id,enabled FROM workflow_definitions WHERE id=?1 AND deleted_at IS NULL", params![id], map_detail).optional().map_err(db)?.ok_or_else(|| "流程不存在或已删除".to_string())?;
    detail.nodes = load_nodes(connection, "workflow_draft_nodes", "workflow_id", id)?;
    Ok(detail)
}

pub fn update_workflow(connection: &mut Connection, input: &UpdateWorkflow) -> Result<i64, String> {
    validate_draft(&input.name, &input.data_source, &input.nodes)?;
    let tx = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(db)?;
    let timestamp = now();
    let changed = tx.execute("UPDATE workflow_definitions SET name=?1,description=?2,environment_id=?3,instance_id=?4,instance_name=?5,database_name=?6,database_type=?7,schema_name=?8,draft_revision=draft_revision+1,updated_at=?9 WHERE id=?10 AND draft_revision=?11 AND deleted_at IS NULL", params![input.name.trim(),input.description,input.data_source.environment_id,input.data_source.instance_id,input.data_source.instance_name,input.data_source.database_name,input.data_source.database_type,input.data_source.schema_name,timestamp,input.workflow_id,input.expected_draft_revision]).map_err(db)?;
    if changed == 0 {
        return revision_or_missing(&tx, &input.workflow_id);
    }
    tx.execute(
        "DELETE FROM workflow_draft_nodes WHERE workflow_id=?1",
        params![input.workflow_id],
    )
    .map_err(db)?;
    insert_nodes(&tx, &input.workflow_id, &input.nodes, &timestamp)?;
    tx.commit().map_err(db)?;
    Ok(input.expected_draft_revision + 1)
}

pub fn copy_workflow(connection: &mut Connection, id: &str) -> Result<String, String> {
    let source = get_workflow(connection, id)?;
    create_workflow(
        connection,
        &CreateWorkflow {
            name: format!("{} - 副本", source.name),
            description: source.description,
            data_source: source.data_source,
            nodes: source
                .nodes
                .into_iter()
                .map(|mut node| {
                    node.id = new_id();
                    node
                })
                .collect(),
        },
    )
}

pub fn archive_workflow(connection: &Connection, id: &str) -> Result<(), String> {
    let changed = connection.execute("UPDATE workflow_definitions SET enabled=0,deleted_at=?1,updated_at=?1 WHERE id=?2 AND deleted_at IS NULL", params![now(), id]).map_err(db)?;
    affected(changed, "流程不存在或已删除")?;
    connection
        .execute(
            "DELETE FROM workflow_schedules WHERE workflow_id=?1",
            params![id],
        )
        .map_err(db)?;
    Ok(())
}

pub fn set_workflow_enabled(
    connection: &Connection,
    input: &SetWorkflowEnabledInput,
) -> Result<(), String> {
    if input.enabled {
        let active: Option<String> = connection.query_row("SELECT active_version_id FROM workflow_definitions WHERE id=?1 AND deleted_at IS NULL", params![input.workflow_id], |row| row.get(0)).optional().map_err(db)?.flatten();
        if active.is_none() {
            return Err("流程发布后才能启用".into());
        }
    }
    let changed = connection.execute("UPDATE workflow_definitions SET enabled=?1,updated_at=?2 WHERE id=?3 AND deleted_at IS NULL", params![input.enabled as i64, now(), input.workflow_id]).map_err(db)?;
    affected(changed, "流程不存在或已删除")
}

pub fn register_plugin_resource(
    connection: &Connection,
    input: &PluginResourceInput,
) -> Result<(), String> {
    let definition = plugin_registry::get(&input.plugin_key)?;
    if definition.requires_credential && input.credential_ref.is_none() {
        return Err(format!(
            "PLUGIN_CREDENTIAL_MISSING：插件资源需要凭据：{}",
            input.name
        ));
    }
    let config = encode(&input.config)?;
    connection.execute("INSERT INTO plugin_resources(id,plugin_key,name,enabled,credential_ref,config_cbor,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?7) ON CONFLICT(id) DO UPDATE SET plugin_key=excluded.plugin_key,name=excluded.name,enabled=excluded.enabled,credential_ref=excluded.credential_ref,config_cbor=excluded.config_cbor,updated_at=excluded.updated_at", params![input.id,input.plugin_key,input.name,input.enabled as i64,input.credential_ref,config,now()]).map_err(db)?;
    Ok(())
}

pub fn list_plugin_resources(
    connection: &Connection,
) -> Result<Vec<PluginResourceSummary>, String> {
    let mut statement = connection.prepare("SELECT id,plugin_key,name,enabled,credential_ref,config_cbor FROM plugin_resources WHERE deleted_at IS NULL ORDER BY plugin_key,name").map_err(db)?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)? != 0,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, Vec<u8>>(5)?,
            ))
        })
        .map_err(db)?;
    rows.map(|result| {
        let (id, plugin_key, name, enabled, credential_ref, bytes) = result.map_err(db)?;
        let definition = plugin_registry::get(&plugin_key)?;
        Ok(PluginResourceSummary {
            id,
            plugin_key,
            name,
            enabled,
            configured: !definition.requires_credential || credential_ref.is_some(),
            config: decode(&bytes)?,
            category: definition.category.into(),
            terminal: definition.terminal,
            input_type: definition.input_type.map(str::to_string),
            output_type: definition.output_type.into(),
        })
    })
    .collect()
}

pub fn publish_workflow(
    connection: &mut Connection,
    input: &PublishWorkflowInput,
) -> Result<String, String> {
    let tx = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(db)?;
    let draft = load_draft(&tx, &input.workflow_id, input.expected_draft_revision)?;
    validate_draft(&draft.name, &draft.data_source, &draft.nodes)?;
    validate_resources(&tx, &draft.nodes)?;
    let version_id = new_id();
    let published_at = now();
    let version: i64 = tx
        .query_row(
            "SELECT COALESCE(MAX(version_number),0)+1 FROM workflow_versions WHERE workflow_id=?1",
            params![input.workflow_id],
            |row| row.get(0),
        )
        .map_err(db)?;
    tx.execute("INSERT INTO workflow_versions(id,workflow_id,version_number,source_draft_revision,name,description,environment_id,instance_id,instance_name,database_name,database_type,schema_name,published_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)", params![version_id,input.workflow_id,version,draft.draft_revision,draft.name,draft.description,draft.data_source.environment_id,draft.data_source.instance_id,draft.data_source.instance_name,draft.data_source.database_name,draft.data_source.database_type,draft.data_source.schema_name,published_at]).map_err(db)?;
    copy_version_nodes(&tx, &version_id, &draft.nodes)?;
    tx.execute(
        "UPDATE workflow_definitions
         SET active_version_id=?1,
             enabled=CASE WHEN active_version_id IS NULL THEN 1 ELSE enabled END,
             updated_at=?2
         WHERE id=?3",
        params![version_id, published_at, input.workflow_id],
    )
    .map_err(db)?;
    tx.execute(
        "UPDATE workflow_schedules SET workflow_version_id=?1,updated_at=?2 WHERE workflow_id=?3",
        params![version_id, published_at, input.workflow_id],
    )
    .map_err(db)?;
    tx.commit().map_err(db)?;
    Ok(version_id)
}

pub fn get_version(connection: &Connection, id: &str) -> Result<WorkflowVersionDetail, String> {
    let mut version = connection.query_row("SELECT id,version_number,source_draft_revision,name,description,environment_id,instance_id,instance_name,database_name,database_type,schema_name FROM workflow_versions WHERE id=?1", params![id], |row| Ok(WorkflowVersionDetail { id: row.get(0)?, version_number: row.get(1)?, source_draft_revision: row.get(2)?, name: row.get(3)?, description: row.get(4)?, data_source: map_source(row, 5)?, nodes: Vec::new() })).optional().map_err(db)?.ok_or_else(|| "流程版本不存在".to_string())?;
    version.nodes = load_nodes(connection, "workflow_version_nodes", "version_id", id)?;
    Ok(version)
}

fn validate_draft(
    name: &str,
    source: &DataSource,
    nodes: &[WorkflowNodeInput],
) -> Result<(), String> {
    if name.trim().is_empty() {
        return Err("流程名称不能为空".into());
    }
    validation::validate_data_source(source)?;
    validation::validate_nodes(nodes)?;
    validation::validate_query_sql(&source.database_type, &nodes[0])
}

fn load_draft(tx: &Transaction<'_>, id: &str, revision: i64) -> Result<WorkflowDetail, String> {
    let detail = get_workflow(tx, id)?;
    if detail.draft_revision != revision {
        return Err("REVISION_CONFLICT:流程草稿已被其他操作修改，请重新加载".into());
    }
    Ok(detail)
}

fn validate_resources(tx: &Transaction<'_>, nodes: &[WorkflowNodeInput]) -> Result<(), String> {
    for node in nodes
        .iter()
        .filter(|node| node.plugin_resource_id.is_some())
    {
        let resource_id = node.plugin_resource_id.as_deref().unwrap_or_default();
        let resource: Option<(i64, String)> = tx.query_row("SELECT enabled,plugin_key FROM plugin_resources WHERE id=?1 AND deleted_at IS NULL", params![resource_id], |row| Ok((row.get(0)?,row.get(1)?))).optional().map_err(db)?;
        let (enabled, key) = resource
            .ok_or_else(|| format!("PLUGIN_RESOURCE_MISSING:插件资源不存在：{}", node.name))?;
        if enabled == 0 {
            return Err(format!(
                "PLUGIN_RESOURCE_DISABLED:插件资源已停用：{}",
                node.name
            ));
        }
        if node.plugin_key.as_deref() != Some(key.as_str()) {
            return Err(format!(
                "PLUGIN_RESOURCE_MISMATCH:插件资源类型不匹配：{}",
                node.name
            ));
        }
        let definition = plugin_registry::get(&key)?;
        if node.category != definition.category
            || node.terminal != definition.terminal
            || node.input_type.as_deref() != definition.input_type
            || node.output_type != definition.output_type
        {
            return Err(format!(
                "PLUGIN_DEFINITION_MISMATCH:插件能力声明不匹配：{}",
                node.name
            ));
        }
    }
    Ok(())
}

fn insert_nodes(
    tx: &Transaction<'_>,
    workflow_id: &str,
    nodes: &[WorkflowNodeInput],
    timestamp: &str,
) -> Result<(), String> {
    for node in nodes {
        let config = encode_node_config(node)?;
        tx.execute("INSERT INTO workflow_draft_nodes(id,workflow_id,position,node_kind,name,plugin_resource_id,plugin_key,category,terminal,input_type,output_type,config_cbor,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?13)", params![node.id,workflow_id,node.position,node.node_kind,node.name,node.plugin_resource_id,node.plugin_key,node.category,node.terminal as i64,node.input_type,node.output_type,config,timestamp]).map_err(db)?;
    }
    Ok(())
}

fn copy_version_nodes(
    tx: &Transaction<'_>,
    version_id: &str,
    nodes: &[WorkflowNodeInput],
) -> Result<(), String> {
    for node in nodes {
        let resource_name: Option<String> = node.plugin_resource_id.as_ref().and_then(|id| {
            tx.query_row(
                "SELECT name FROM plugin_resources WHERE id=?1",
                params![id],
                |row| row.get(0),
            )
            .ok()
        });
        tx.execute("INSERT INTO workflow_version_nodes(id,version_id,source_draft_node_id,position,node_kind,name,plugin_resource_id,plugin_key,plugin_resource_name,category,terminal,input_type,output_type,config_cbor) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)", params![new_id(),version_id,node.id,node.position,node.node_kind,node.name,node.plugin_resource_id,node.plugin_key,resource_name,node.category,node.terminal as i64,node.input_type,node.output_type,encode_node_config(node)?]).map_err(db)?;
    }
    Ok(())
}

fn load_nodes(
    connection: &Connection,
    table: &str,
    owner_column: &str,
    owner_id: &str,
) -> Result<Vec<WorkflowNodeInput>, String> {
    let sql = format!("SELECT source_draft_node_id,position,node_kind,name,plugin_resource_id,plugin_key,category,terminal,input_type,output_type,config_cbor FROM {table} WHERE {owner_column}=?1 ORDER BY position");
    let draft_sql = sql.replace("source_draft_node_id", "id");
    let query = if table == "workflow_draft_nodes" {
        &draft_sql
    } else {
        &sql
    };
    let mut statement = connection.prepare(query).map_err(db)?;
    let rows = statement
        .query_map(params![owner_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, Option<String>>(5)?,
                row.get::<_, String>(6)?,
                row.get::<_, i64>(7)? != 0,
                row.get::<_, Option<String>>(8)?,
                row.get::<_, String>(9)?,
                row.get::<_, Vec<u8>>(10)?,
            ))
        })
        .map_err(db)?;
    rows.map(|result| {
        let (
            id,
            position,
            node_kind,
            name,
            plugin_resource_id,
            plugin_key,
            category,
            terminal,
            input_type,
            output_type,
            config,
        ) = result.map_err(db)?;
        let (sql, sql_kind, plugin_config) = decode_node_config(&node_kind, &config)?;
        Ok(WorkflowNodeInput {
            id,
            position,
            node_kind,
            name,
            plugin_resource_id,
            plugin_key,
            category,
            terminal,
            input_type,
            output_type,
            sql,
            sql_kind,
            plugin_config,
        })
    })
    .collect()
}

fn map_detail(row: &Row<'_>) -> rusqlite::Result<WorkflowDetail> {
    Ok(WorkflowDetail {
        id: row.get(0)?,
        name: row.get(1)?,
        description: row.get(2)?,
        data_source: map_source(row, 3)?,
        nodes: Vec::new(),
        draft_revision: row.get(9)?,
        active_version_id: row.get(10)?,
        enabled: row.get::<_, i64>(11)? != 0,
    })
}

fn map_source(row: &Row<'_>, offset: usize) -> rusqlite::Result<DataSource> {
    Ok(DataSource {
        environment_id: row.get(offset)?,
        instance_id: row.get(offset + 1)?,
        instance_name: row.get(offset + 2)?,
        database_name: row.get(offset + 3)?,
        database_type: row.get(offset + 4)?,
        schema_name: row.get(offset + 5)?,
    })
}

fn encode_node_config(node: &WorkflowNodeInput) -> Result<Vec<u8>, String> {
    if node.node_kind == "sql" {
        encode(&(
            node.sql.as_deref().unwrap_or_default(),
            node.sql_kind.as_deref().unwrap_or_default(),
        ))
    } else {
        encode(&node.plugin_config.clone().unwrap_or(Value::Null))
    }
}

fn decode_node_config(
    kind: &str,
    bytes: &[u8],
) -> Result<(Option<String>, Option<String>, Option<Value>), String> {
    if kind == "sql" {
        let (sql, sql_kind): (String, String) = decode(bytes)?;
        return Ok((Some(sql), Some(sql_kind), None));
    }
    Ok((None, None, Some(decode(bytes)?)))
}

fn encode<T: Serialize>(value: &T) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    ciborium::into_writer(value, &mut bytes).map_err(|error| format!("CBOR 编码失败：{error}"))?;
    Ok(bytes)
}

fn decode<T: DeserializeOwned>(bytes: &[u8]) -> Result<T, String> {
    ciborium::from_reader(bytes).map_err(|error| format!("CBOR 解码失败：{error}"))
}

fn revision_or_missing(tx: &Transaction<'_>, id: &str) -> Result<i64, String> {
    let exists: bool = tx
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM workflow_definitions WHERE id=?1 AND deleted_at IS NULL)",
            params![id],
            |row| row.get(0),
        )
        .map_err(db)?;
    if exists {
        Err("REVISION_CONFLICT:流程草稿已被其他操作修改，请重新加载".into())
    } else {
        Err("流程不存在或已删除".into())
    }
}

fn affected(changed: usize, message: &str) -> Result<(), String> {
    if changed == 0 {
        Err(message.into())
    } else {
        Ok(())
    }
}
fn db(error: rusqlite::Error) -> String {
    format!("workflow.db 操作失败：{error}")
}
fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}
fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::migrations;
    use serde_json::json;

    fn connection() -> Connection {
        let mut connection = Connection::open_in_memory().unwrap();
        connection.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
        migrations::migrate(&mut connection).unwrap();
        connection
    }

    fn sql_node(sql: &str) -> WorkflowNodeInput {
        WorkflowNodeInput {
            id: new_id(),
            position: 0,
            node_kind: "sql".into(),
            name: "查询".into(),
            plugin_resource_id: None,
            plugin_key: None,
            category: "sql".into(),
            terminal: false,
            input_type: None,
            output_type: "table".into(),
            sql: Some(sql.into()),
            sql_kind: Some("query".into()),
            plugin_config: None,
        }
    }

    fn create_input(database_type: &str, schema_name: Option<&str>) -> CreateWorkflow {
        CreateWorkflow {
            name: "日报".into(),
            description: "测试".into(),
            data_source: DataSource {
                environment_id: "env".into(),
                instance_id: "instance".into(),
                instance_name: "实例".into(),
                database_name: "database".into(),
                database_type: database_type.into(),
                schema_name: schema_name.map(str::to_string),
            },
            nodes: vec![sql_node("SELECT 1")],
        }
    }

    #[test]
    fn supports_crud_copy_archive_and_revision_conflict() {
        let mut connection = connection();
        let id = create_workflow(&mut connection, &create_input("mysql", None)).unwrap();
        let detail = get_workflow(&connection, &id).unwrap();
        assert_eq!(detail.nodes[0].sql.as_deref(), Some("SELECT 1"));
        let update = UpdateWorkflow {
            workflow_id: id.clone(),
            expected_draft_revision: 1,
            name: "新日报".into(),
            description: String::new(),
            data_source: detail.data_source,
            nodes: vec![sql_node("SELECT 2")],
        };
        assert_eq!(update_workflow(&mut connection, &update).unwrap(), 2);
        assert!(update_workflow(&mut connection, &update)
            .unwrap_err()
            .starts_with("REVISION_CONFLICT:"));
        let copied = copy_workflow(&mut connection, &id).unwrap();
        assert_eq!(list_workflows(&connection, "env").unwrap().len(), 2);
        archive_workflow(&connection, &copied).unwrap();
        assert_eq!(list_workflows(&connection, "env").unwrap().len(), 1);
    }

    #[test]
    fn requires_postgresql_schema() {
        let mut connection = connection();
        assert_eq!(
            create_workflow(&mut connection, &create_input("postgresql", None)).unwrap_err(),
            "PostgreSQL 必须选择模式"
        );
    }

    #[test]
    fn published_version_is_immutable_and_draft_changes_do_not_affect_it() {
        let mut connection = connection();
        let id = create_workflow(&mut connection, &create_input("mysql", None)).unwrap();
        let version_id = publish_workflow(
            &mut connection,
            &PublishWorkflowInput {
                workflow_id: id.clone(),
                expected_draft_revision: 1,
            },
        )
        .unwrap();
        set_workflow_enabled(
            &connection,
            &SetWorkflowEnabledInput {
                workflow_id: id.clone(),
                enabled: true,
            },
        )
        .unwrap();
        assert!(get_workflow(&connection, &id).unwrap().enabled);
        let original = get_version(&connection, &version_id).unwrap();
        let detail = get_workflow(&connection, &id).unwrap();
        update_workflow(
            &mut connection,
            &UpdateWorkflow {
                workflow_id: id,
                expected_draft_revision: 1,
                name: "已修改".into(),
                description: String::new(),
                data_source: detail.data_source,
                nodes: vec![sql_node("SELECT 2")],
            },
        )
        .unwrap();
        assert_eq!(
            get_version(&connection, &version_id).unwrap().nodes[0].sql,
            original.nodes[0].sql
        );
        assert!(connection
            .execute(
                "UPDATE workflow_versions SET name='非法修改' WHERE id=?1",
                params![version_id]
            )
            .is_err());
    }

    #[test]
    fn republishing_updates_the_schedule_version() {
        let mut connection = connection();
        let id = create_workflow(&mut connection, &create_input("mysql", None)).unwrap();
        let first_version = publish_workflow(
            &mut connection,
            &PublishWorkflowInput {
                workflow_id: id.clone(),
                expected_draft_revision: 1,
            },
        )
        .unwrap();
        connection
            .execute(
                "INSERT INTO workflow_schedules(id,workflow_id,workflow_version_id,
                 cron_expression,timezone,enabled,created_at,updated_at)
                 VALUES('schedule',?1,?2,'0 9 * * *','UTC',0,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)",
                params![id, first_version],
            )
            .unwrap();
        let detail = get_workflow(&connection, &id).unwrap();
        update_workflow(
            &mut connection,
            &UpdateWorkflow {
                workflow_id: id.clone(),
                expected_draft_revision: 1,
                name: detail.name,
                description: detail.description,
                data_source: detail.data_source,
                nodes: vec![sql_node("SELECT 2")],
            },
        )
        .unwrap();
        let second_version = publish_workflow(
            &mut connection,
            &PublishWorkflowInput {
                workflow_id: id,
                expected_draft_revision: 2,
            },
        )
        .unwrap();
        let scheduled_version: String = connection
            .query_row(
                "SELECT workflow_version_id FROM workflow_schedules WHERE id='schedule'",
                [],
                |row| row.get(0),
            )
            .unwrap();

        assert_ne!(first_version, second_version);
        assert_eq!(scheduled_version, second_version);
    }

    #[test]
    fn plugin_resource_output_hides_credential_reference() {
        let connection = connection();
        register_plugin_resource(
            &connection,
            &PluginResourceInput {
                id: "dingtalk:test".into(),
                plugin_key: "dingtalk".into(),
                name: "测试机器人".into(),
                enabled: true,
                credential_ref: Some("secret-reference".into()),
                config: json!({"timeout": 30}),
            },
        )
        .unwrap();
        let resources = list_plugin_resources(&connection).unwrap();
        let resource = resources
            .iter()
            .find(|item| item.id == "dingtalk:test")
            .unwrap();
        assert!(resource.configured);
        assert_eq!(resource.config, json!({"timeout": 30}));
        assert!(!serde_json::to_string(resource)
            .unwrap()
            .contains("secret-reference"));
    }

    #[test]
    fn lists_message_builder_resource_as_configured_without_credentials() {
        let connection = connection();
        let resource = list_plugin_resources(&connection)
            .unwrap()
            .into_iter()
            .find(|item| item.id == "message-builder:default")
            .unwrap();
        assert_eq!(resource.plugin_key, "message_builder");
        assert!(resource.configured);
        assert_eq!(resource.config["format"], "text");
        assert_eq!(resource.config["bodyTemplate"], "{{workflow.name}}");
        assert_eq!(resource.config["emptyBehavior"], "send");
        assert_eq!(resource.category, "transform");
        assert!(!resource.terminal);
        assert_eq!(resource.input_type.as_deref(), Some("table,object,text"));
        assert_eq!(resource.output_type, "message");
    }

    #[test]
    fn publishes_message_builder_to_dingtalk_chain_from_registry() {
        let mut connection = connection();
        let mut input = create_input("mysql", None);
        input.nodes.extend([
            WorkflowNodeInput {
                id: new_id(),
                position: 1,
                node_kind: "plugin".into(),
                name: "消息构建".into(),
                plugin_resource_id: Some("message-builder:default".into()),
                plugin_key: Some("message_builder".into()),
                category: "transform".into(),
                terminal: false,
                input_type: Some("table,object,text".into()),
                output_type: "message".into(),
                sql: None,
                sql_kind: None,
                plugin_config: Some(json!({"format": "markdown"})),
            },
            WorkflowNodeInput {
                id: new_id(),
                position: 2,
                node_kind: "plugin".into(),
                name: "钉钉".into(),
                plugin_resource_id: Some("dingtalk:default".into()),
                plugin_key: Some("dingtalk".into()),
                category: "sink".into(),
                terminal: true,
                input_type: Some("message,text".into()),
                output_type: "none".into(),
                sql: None,
                sql_kind: None,
                plugin_config: None,
            },
        ]);
        let workflow_id = create_workflow(&mut connection, &input).unwrap();
        assert!(publish_workflow(
            &mut connection,
            &PublishWorkflowInput {
                workflow_id,
                expected_draft_revision: 1,
            }
        )
        .is_ok());
    }

    #[test]
    fn rejects_resource_for_unregistered_plugin() {
        let connection = connection();
        let error = register_plugin_resource(
            &connection,
            &PluginResourceInput {
                id: "unknown:default".into(),
                plugin_key: "python".into(),
                name: "未知插件".into(),
                enabled: true,
                credential_ref: None,
                config: Value::Null,
            },
        )
        .unwrap_err();
        assert!(error.starts_with("PLUGIN_UNKNOWN："));
    }

    #[test]
    fn cannot_enable_unpublished_workflow() {
        let mut connection = connection();
        let id = create_workflow(&mut connection, &create_input("mysql", None)).unwrap();
        assert_eq!(
            set_workflow_enabled(
                &connection,
                &SetWorkflowEnabledInput {
                    workflow_id: id,
                    enabled: true
                }
            )
            .unwrap_err(),
            "流程发布后才能启用"
        );
    }
}
