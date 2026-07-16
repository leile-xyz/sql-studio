use super::domain::{DataSource, WorkflowNodeInput};
use sqlparser::{
    ast::Statement,
    dialect::{Dialect, GenericDialect, MySqlDialect, PostgreSqlDialect},
    parser::Parser,
};

pub fn validate_data_source(source: &DataSource) -> Result<(), String> {
    for (label, value) in [
        ("环境", &source.environment_id),
        ("实例", &source.instance_id),
        ("数据库", &source.database_name),
    ] {
        if value.trim().is_empty() {
            return Err(format!("{label}不能为空"));
        }
    }
    if source.database_type.eq_ignore_ascii_case("postgresql")
        && source
            .schema_name
            .as_deref()
            .unwrap_or("")
            .trim()
            .is_empty()
    {
        return Err("PostgreSQL 必须选择模式".into());
    }
    Ok(())
}

pub fn validate_nodes(nodes: &[WorkflowNodeInput]) -> Result<(), String> {
    if nodes.is_empty() {
        return Err("流程至少需要 SQL 节点".into());
    }
    let mut ordered = nodes.to_vec();
    ordered.sort_by_key(|node| node.position);
    for (index, node) in ordered.iter().enumerate() {
        if node.position != index as i64 {
            return Err("节点顺序必须从 0 连续递增".into());
        }
        if index == 0
            && (node.node_kind != "sql"
                || node.category != "sql"
                || node.terminal
                || node.plugin_resource_id.is_some())
        {
            return Err("首个节点必须是 SQL 节点".into());
        }
        if index == 0 && node.sql.as_deref().unwrap_or("").trim().is_empty() {
            return Err("SQL 内容不能为空".into());
        }
        if index == 0 && node.sql_kind.as_deref().unwrap_or("").trim().is_empty() {
            return Err("SQL 类型不能为空".into());
        }
        if index == 0 {
            if node.sql_kind.as_deref() != Some("query") {
                return Err("SQL 节点仅允许查询类型".into());
            }
            if node.output_type != "table" {
                return Err("查询 SQL 的输出类型必须是 table".into());
            }
        }
        if index > 0 && (node.sql.is_some() || node.sql_kind.is_some()) {
            return Err("插件节点不能包含 SQL 配置".into());
        }
        if index > 0 && node.node_kind != "plugin" {
            return Err("SQL 只能作为首个节点".into());
        }
        if node.terminal && index != ordered.len() - 1 {
            return Err("终止插件必须位于最后".into());
        }
        if node.terminal && node.category != "sink" {
            return Err("终止节点必须是 sink".into());
        }
        if index > 0 && node.plugin_resource_id.is_none() {
            return Err("插件节点必须选择资源".into());
        }
        if index > 0
            && !compatible(
                ordered[index - 1].output_type.as_str(),
                node.input_type.as_deref(),
            )
        {
            return Err(format!("节点 {} 的输入类型不兼容", node.name));
        }
    }
    if ordered.iter().filter(|node| node.terminal).count() > 1 {
        return Err("只能配置一个终止插件".into());
    }
    Ok(())
}

pub fn validate_query_sql(database_type: &str, node: &WorkflowNodeInput) -> Result<(), String> {
    let sql = node.sql.as_deref().unwrap_or_default().trim();
    let dialect = sql_dialect(database_type);
    let statements = Parser::parse_sql(dialect.as_ref(), sql)
        .map_err(|error| format!("SQL 语法错误：{error}"))?;
    if statements.len() != 1 {
        return Err("SQL 节点只能输入一条查询语句".into());
    }
    if !matches!(statements.first(), Some(Statement::Query(_))) {
        return Err("SQL 节点仅允许 SELECT、WITH 等查询语句".into());
    }
    Ok(())
}

fn sql_dialect(database_type: &str) -> Box<dyn Dialect> {
    let normalized = database_type.to_ascii_lowercase();
    if normalized.contains("postgres") || normalized.contains("pgsql") {
        return Box::new(PostgreSqlDialect {});
    }
    if normalized.contains("mysql") || normalized.contains("mariadb") {
        return Box::new(MySqlDialect {});
    }
    Box::new(GenericDialect {})
}

fn compatible(output: &str, input: Option<&str>) -> bool {
    input
        .map(|value| value.split(',').any(|item| item.trim() == output))
        .unwrap_or(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sql_node(sql: &str) -> WorkflowNodeInput {
        WorkflowNodeInput {
            id: "sql-node".into(),
            position: 0,
            node_kind: "sql".into(),
            name: "SQL 执行".into(),
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

    #[test]
    fn accepts_one_valid_query() {
        assert!(validate_query_sql("mysql", &sql_node("SELECT id FROM users")).is_ok());
        assert!(validate_query_sql(
            "postgresql",
            &sql_node("WITH row AS (SELECT 1) SELECT * FROM row")
        )
        .is_ok());
    }

    #[test]
    fn rejects_invalid_or_multiple_queries() {
        assert!(validate_query_sql("mysql", &sql_node("SELECT FROM users"))
            .unwrap_err()
            .starts_with("SQL 语法错误："));
        assert_eq!(
            validate_query_sql("mysql", &sql_node("SELECT 1; SELECT 2")).unwrap_err(),
            "SQL 节点只能输入一条查询语句"
        );
    }

    #[test]
    fn rejects_non_query_statement() {
        assert_eq!(
            validate_query_sql("mysql", &sql_node("UPDATE users SET enabled=1")).unwrap_err(),
            "SQL 节点仅允许 SELECT、WITH 等查询语句"
        );
    }
}
