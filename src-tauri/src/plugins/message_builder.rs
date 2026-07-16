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
    let workflow_rendered = template.replace("{{workflow.name}}", workflow_name);
    let table_rendered = workflow_rendered.replace("{{table}}", &render_markdown_table(input)?);
    let rows_rendered = render_row_blocks(&table_rendered, rows)?;
    let object = input.as_object().cloned().unwrap_or_default();
    let rendered = replace_fields(rows_rendered, "object.", &object)?;
    if rendered.contains("{{") || rendered.contains("}}") {
        return Err("消息模板包含未解析的变量或不完整标记".into());
    }
    Ok(rendered)
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

fn render_row_blocks(template: &str, rows: &[Map<String, Value>]) -> Result<String, String> {
    let mut output = template.to_string();
    loop {
        let Some(start) = output.find("{{#rows}}") else {
            break;
        };
        let content_start = start + "{{#rows}}".len();
        let relative_end = output[content_start..]
            .find("{{/rows}}")
            .ok_or_else(|| "消息模板缺少 {{/rows}}".to_string())?;
        let end = content_start + relative_end;
        let block = &output[content_start..end];
        let rendered = rows
            .iter()
            .map(|row| render_row(block, row))
            .collect::<Result<Vec<_>, _>>()?
            .join("");
        output.replace_range(start..end + "{{/rows}}".len(), &rendered);
    }
    Ok(output)
}

fn render_row(block: &str, row: &Map<String, Value>) -> Result<String, String> {
    let rendered = block.replace("{{row}}", &Value::Object(row.clone()).to_string());
    replace_fields(rendered, "row.", row)
}

fn replace_fields(
    mut template: String,
    prefix: &str,
    values: &Map<String, Value>,
) -> Result<String, String> {
    let marker = format!("{{{{{prefix}");
    while let Some(start) = template.find(&marker) {
        let key_start = start + marker.len();
        let relative_end = template[key_start..]
            .find("}}")
            .ok_or_else(|| "消息模板变量缺少结束标记".to_string())?;
        let end = key_start + relative_end;
        let key = &template[key_start..end];
        let value = values
            .get(key)
            .ok_or_else(|| format!("消息模板字段不存在：{prefix}{key}"))?;
        template.replace_range(start..end + 2, &value_text(value));
    }
    Ok(template)
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
}
