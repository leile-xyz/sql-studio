use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

const TEXT_FORMAT: &str = "text";
const MARKDOWN_FORMAT: &str = "markdown";
const EMPTY_SEND: &str = "send";
const EMPTY_SKIP: &str = "skip";

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MessageBuilderConfig {
    pub format: String,
    #[serde(default)]
    pub title: String,
    pub body_template: String,
    #[serde(default = "default_empty_behavior")]
    pub empty_behavior: String,
    #[serde(default)]
    pub at_all: bool,
    #[serde(default)]
    pub at_mobiles: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StandardMessage {
    pub format: String,
    pub title: String,
    pub body: String,
    pub at: MessageMentions,
    #[serde(default)]
    pub skip_delivery: bool,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MessageMentions {
    pub all: bool,
    pub mobiles: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct TableInput {
    columns: Vec<String>,
    rows: Vec<Vec<Value>>,
}

pub(crate) struct MessageBuildContext<'a> {
    pub workflow_name: &'a str,
    pub input_type: &'a str,
    pub input_cbor: &'a [u8],
}

pub(crate) fn build_message(
    config_value: &Value,
    context: MessageBuildContext<'_>,
) -> Result<StandardMessage, String> {
    let config: MessageBuilderConfig = serde_json::from_value(config_value.clone())
        .map_err(|error| format!("消息构建配置无效：{error}"))?;
    validate_config(&config)?;
    let input = decode_input(context.input_type, context.input_cbor)?;
    let rows = input_rows(&input)?;
    let title = render_template(&config.title, context.workflow_name, &input, &rows)?;
    let body = render_template(&config.body_template, context.workflow_name, &input, &rows)?;
    Ok(StandardMessage {
        format: config.format,
        title,
        body,
        at: MessageMentions {
            all: config.at_all,
            mobiles: config.at_mobiles,
        },
        skip_delivery: rows.is_empty() && config.empty_behavior == EMPTY_SKIP,
    })
}

fn validate_config(config: &MessageBuilderConfig) -> Result<(), String> {
    if !matches!(config.format.as_str(), TEXT_FORMAT | MARKDOWN_FORMAT) {
        return Err("消息格式必须是 text 或 markdown".into());
    }
    if !matches!(config.empty_behavior.as_str(), EMPTY_SEND | EMPTY_SKIP) {
        return Err("空结果行为必须是 send 或 skip".into());
    }
    if config.body_template.trim().is_empty() {
        return Err("消息正文模板不能为空".into());
    }
    if config
        .at_mobiles
        .iter()
        .any(|mobile| mobile.trim().is_empty() || mobile.chars().any(char::is_whitespace))
    {
        return Err("消息提及手机号不能为空或包含空白字符".into());
    }
    Ok(())
}

fn decode_input(input_type: &str, content: &[u8]) -> Result<Value, String> {
    match input_type {
        "table" => {
            let table: TableInput = ciborium::from_reader(content)
                .map_err(|error| format!("table 输入产物解码失败：{error}"))?;
            serde_json::to_value(table).map_err(|error| error.to_string())
        }
        "object" => ciborium::from_reader(content)
            .map_err(|error| format!("object 输入产物解码失败：{error}")),
        "text" => {
            let text: String = ciborium::from_reader(content)
                .map_err(|error| format!("text 输入产物解码失败：{error}"))?;
            Ok(Value::String(text))
        }
        other => Err(format!("消息构建插件不支持 {other} 输入产物")),
    }
}

fn input_rows(input: &Value) -> Result<Vec<Map<String, Value>>, String> {
    let Some(columns) = input.get("columns") else {
        return Ok(Vec::new());
    };
    let columns = columns
        .as_array()
        .ok_or_else(|| "table 输入列定义无效".to_string())?;
    let rows = input
        .get("rows")
        .and_then(Value::as_array)
        .ok_or_else(|| "table 输入行数据无效".to_string())?;
    rows.iter().map(|row| row_object(columns, row)).collect()
}

fn row_object(columns: &[Value], row: &Value) -> Result<Map<String, Value>, String> {
    let cells = row
        .as_array()
        .ok_or_else(|| "table 输入行必须是数组".to_string())?;
    if cells.len() != columns.len() {
        return Err("table 输入行与列数量不一致".into());
    }
    columns
        .iter()
        .zip(cells)
        .map(|(column, cell)| {
            column
                .as_str()
                .map(|name| (name.to_string(), cell.clone()))
                .ok_or_else(|| "table 输入列名必须是字符串".to_string())
        })
        .collect()
}

fn render_template(
    template: &str,
    workflow_name: &str,
    input: &Value,
    rows: &[Map<String, Value>],
) -> Result<String, String> {
    let object = input.as_object().cloned().unwrap_or_default();
    let table = render_markdown_table(input)?;
    render_template_segment(
        template,
        &TemplateRenderContext {
            workflow_name,
            table: &table,
            object: &object,
            rows,
            row: None,
            allow_row_blocks: true,
        },
    )
}

#[derive(Clone, Copy)]
struct TemplateRenderContext<'a> {
    workflow_name: &'a str,
    table: &'a str,
    object: &'a Map<String, Value>,
    rows: &'a [Map<String, Value>],
    row: Option<&'a Map<String, Value>>,
    allow_row_blocks: bool,
}

fn render_template_segment(
    template: &str,
    context: &TemplateRenderContext<'_>,
) -> Result<String, String> {
    let mut output = String::new();
    let mut cursor = 0;
    while let Some(relative_start) = template[cursor..].find("{{") {
        let start = cursor + relative_start;
        append_template_literal(&mut output, &template[cursor..start])?;
        let content_start = start + "{{".len();
        let relative_end = template[content_start..]
            .find("}}")
            .ok_or_else(|| "消息模板变量缺少结束标记".to_string())?;
        let end = content_start + relative_end;
        let marker = &template[content_start..end];
        let (next_cursor, rendered) = render_marker(
            template,
            TemplateMarker {
                content: marker,
                end: end + "}}".len(),
            },
            context,
        )?;
        output.push_str(&rendered);
        cursor = next_cursor;
    }
    append_template_literal(&mut output, &template[cursor..])?;
    Ok(output)
}

fn append_template_literal(output: &mut String, literal: &str) -> Result<(), String> {
    if literal.contains("}}") {
        return Err("消息模板包含未解析的变量或不完整标记".into());
    }
    output.push_str(literal);
    Ok(())
}

struct TemplateMarker<'a> {
    content: &'a str,
    end: usize,
}

fn render_marker(
    template: &str,
    marker: TemplateMarker<'_>,
    context: &TemplateRenderContext<'_>,
) -> Result<(usize, String), String> {
    if marker.content == "#rows" {
        return render_rows_block(template, marker.end, context);
    }
    if marker.content == "/rows" {
        return Err("消息模板包含多余的 {{/rows}}".into());
    }
    Ok((marker.end, render_variable(marker.content, context)?))
}

fn render_rows_block(
    template: &str,
    block_start: usize,
    context: &TemplateRenderContext<'_>,
) -> Result<(usize, String), String> {
    if !context.allow_row_blocks {
        return Err("消息模板不支持嵌套 {{#rows}}".into());
    }
    let relative_end = template[block_start..]
        .find("{{/rows}}")
        .ok_or_else(|| "消息模板缺少 {{/rows}}".to_string())?;
    let block_end = block_start + relative_end;
    let block = &template[block_start..block_end];
    if block.contains("{{#rows}}") {
        return Err("消息模板不支持嵌套 {{#rows}}".into());
    }
    let mut output = String::new();
    for row in context.rows {
        output.push_str(&render_template_segment(
            block,
            &TemplateRenderContext {
                row: Some(row),
                allow_row_blocks: false,
                ..*context
            },
        )?);
    }
    Ok((block_end + "{{/rows}}".len(), output))
}

fn render_variable(marker: &str, context: &TemplateRenderContext<'_>) -> Result<String, String> {
    match marker {
        "workflow.name" => Ok(context.workflow_name.to_string()),
        "table" => Ok(context.table.to_string()),
        "row" => context
            .row
            .map(|row| Value::Object(row.clone()).to_string())
            .ok_or_else(|| "消息模板变量 {{row}} 只能在 rows 区块内使用".to_string()),
        _ => render_field(marker, context),
    }
}

fn render_field(marker: &str, context: &TemplateRenderContext<'_>) -> Result<String, String> {
    if let Some(key) = marker.strip_prefix("object.") {
        return context
            .object
            .get(key)
            .map(value_text)
            .ok_or_else(|| format!("消息模板字段不存在：object.{key}"));
    }
    if let Some(key) = marker.strip_prefix("row.") {
        let row = context
            .row
            .ok_or_else(|| "消息模板 row 字段只能在 rows 区块内使用".to_string())?;
        return row
            .get(key)
            .map(value_text)
            .ok_or_else(|| format!("消息模板字段不存在：row.{key}"));
    }
    Err(format!("消息模板包含未解析的变量：{{{{{marker}}}}}"))
}

fn render_markdown_table(input: &Value) -> Result<String, String> {
    let Some(columns) = input.get("columns") else {
        return Ok(String::new());
    };
    let columns = columns
        .as_array()
        .ok_or_else(|| "table 输入列定义无效".to_string())?;
    let rows = input
        .get("rows")
        .and_then(Value::as_array)
        .ok_or_else(|| "table 输入行数据无效".to_string())?;
    let headers = columns.iter().map(value_text).collect::<Vec<_>>();
    let mut lines = vec![
        markdown_line(&headers),
        markdown_line(&vec!["---".into(); headers.len()]),
    ];
    for row in rows {
        let cells = row
            .as_array()
            .ok_or_else(|| "table 输入行必须是数组".to_string())?;
        lines.push(markdown_line(
            &cells.iter().map(value_text).collect::<Vec<_>>(),
        ));
    }
    Ok(lines.join("\n"))
}

fn markdown_line(cells: &[String]) -> String {
    format!(
        "| {} |",
        cells
            .iter()
            .map(|cell| cell.replace('|', "\\|").replace('\n', " "))
            .collect::<Vec<_>>()
            .join(" | ")
    )
}

fn value_text(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::String(text) => text.clone(),
        Value::Bool(value) => value.to_string(),
        Value::Number(value) => value.to_string(),
        Value::Array(_) | Value::Object(_) => value.to_string(),
    }
}

fn default_empty_behavior() -> String {
    EMPTY_SEND.into()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn table_cbor(rows: Value) -> Vec<u8> {
        let value = json!({
            "columns": ["name", "amount"],
            "rows": rows,
            "fullSql": "SELECT name, amount FROM sales LIMIT 100"
        });
        let mut bytes = Vec::new();
        ciborium::into_writer(&value, &mut bytes).unwrap();
        bytes
    }

    #[test]
    fn renders_table_rows_and_workflow_name() {
        let bytes = table_cbor(json!([["A", 10], ["B", 20]]));
        let message = build_message(
            &json!({
                "format": "markdown",
                "title": "{{workflow.name}}",
                "bodyTemplate": "{{#rows}}- {{row.name}}: {{row.amount}}\n{{/rows}}",
                "emptyBehavior": "send",
                "atAll": false,
                "atMobiles": ["13800138000"]
            }),
            MessageBuildContext {
                workflow_name: "销售日报",
                input_type: "table",
                input_cbor: &bytes,
            },
        )
        .unwrap();
        assert_eq!(message.title, "销售日报");
        assert_eq!(message.body, "- A: 10\n- B: 20\n");
        assert_eq!(message.at.mobiles, vec!["13800138000"]);
    }

    #[test]
    fn renders_complete_row_as_json() {
        let bytes = table_cbor(json!([["Alice", 12]]));
        let output = build_message(
            &json!({"format":"text","bodyTemplate":"{{#rows}}- {{row}}{{/rows}}"}),
            MessageBuildContext {
                workflow_name: "日报",
                input_type: "table",
                input_cbor: &bytes,
            },
        )
        .unwrap();
        assert_eq!(output.body, "- {\"amount\":12,\"name\":\"Alice\"}");
    }

    #[test]
    fn renders_query_result_as_markdown_table() {
        let bytes = table_cbor(json!([["Alice", 12]]));
        let output = build_message(
            &json!({"format":"markdown","bodyTemplate":"### {{workflow.name}}\n\n{{table}}"}),
            MessageBuildContext {
                workflow_name: "日报",
                input_type: "table",
                input_cbor: &bytes,
            },
        )
        .unwrap();
        assert!(output.body.contains("| name | amount |"));
        assert!(output.body.contains("| Alice | 12 |"));
    }

    #[test]
    fn renders_object_fields_and_marks_empty_table_for_skip() {
        let mut object_bytes = Vec::new();
        ciborium::into_writer(&json!({"affectedRows": 3}), &mut object_bytes).unwrap();
        let object = build_message(
            &json!({"format":"text","bodyTemplate":"影响 {{object.affectedRows}} 行"}),
            MessageBuildContext {
                workflow_name: "命令",
                input_type: "object",
                input_cbor: &object_bytes,
            },
        )
        .unwrap();
        assert_eq!(object.body, "影响 3 行");

        let empty = table_cbor(json!([]));
        let skipped = build_message(
            &json!({
                "format":"text",
                "bodyTemplate":"没有数据",
                "emptyBehavior":"skip"
            }),
            MessageBuildContext {
                workflow_name: "空结果",
                input_type: "table",
                input_cbor: &empty,
            },
        )
        .unwrap();
        assert!(skipped.skip_delivery);
    }

    #[test]
    fn rejects_unknown_template_fields_without_silent_fallback() {
        let bytes = table_cbor(json!([["A", 10]]));
        let error = build_message(
            &json!({"format":"text","bodyTemplate":"{{#rows}}{{row.missing}}{{/rows}}"}),
            MessageBuildContext {
                workflow_name: "日报",
                input_type: "table",
                input_cbor: &bytes,
            },
        )
        .unwrap_err();
        assert!(error.contains("字段不存在"));
    }

    #[test]
    fn treats_template_markers_from_row_values_as_plain_text() {
        let bytes = table_cbor(json!([["{{row.name}}", "{{#rows}}x{{/rows}}"]]));
        let output = build_message(
            &json!({
                "format":"text",
                "bodyTemplate":"{{#rows}}{{row.name}} | {{row.amount}}{{/rows}}"
            }),
            MessageBuildContext {
                workflow_name: "日报",
                input_type: "table",
                input_cbor: &bytes,
            },
        )
        .unwrap();
        assert_eq!(output.body, "{{row.name}} | {{#rows}}x{{/rows}}");
    }

    #[test]
    fn treats_template_markers_from_object_values_as_plain_text() {
        let mut bytes = Vec::new();
        ciborium::into_writer(
            &json!({"content": "{{object.content}} and {{unknown}}"}),
            &mut bytes,
        )
        .unwrap();
        let output = build_message(
            &json!({"format":"text","bodyTemplate":"{{object.content}}"}),
            MessageBuildContext {
                workflow_name: "命令",
                input_type: "object",
                input_cbor: &bytes,
            },
        )
        .unwrap();
        assert_eq!(output.body, "{{object.content}} and {{unknown}}");
    }

    #[test]
    fn rejects_unknown_variables_in_original_template() {
        let bytes = table_cbor(json!([["A", 10]]));
        let error = build_message(
            &json!({"format":"text","bodyTemplate":"{{unknown}}"}),
            MessageBuildContext {
                workflow_name: "日报",
                input_type: "table",
                input_cbor: &bytes,
            },
        )
        .unwrap_err();
        assert!(error.contains("未解析的变量"));
    }
}
