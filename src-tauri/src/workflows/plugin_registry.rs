#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PluginDefinition {
    pub key: &'static str,
    pub category: &'static str,
    pub terminal: bool,
    pub input_type: Option<&'static str>,
    pub output_type: &'static str,
    pub requires_credential: bool,
}

const DEFINITIONS: &[PluginDefinition] = &[
    PluginDefinition {
        key: "message_builder",
        category: "transform",
        terminal: false,
        input_type: Some("table,object,text"),
        output_type: "message",
        requires_credential: false,
    },
    PluginDefinition {
        key: "dingtalk",
        category: "sink",
        terminal: true,
        input_type: Some("message,text"),
        output_type: "none",
        requires_credential: true,
    },
];

pub fn get(key: &str) -> Result<&'static PluginDefinition, String> {
    DEFINITIONS
        .iter()
        .find(|definition| definition.key == key)
        .ok_or_else(|| format!("PLUGIN_UNKNOWN：未注册的插件类型 {key}"))
}

#[allow(dead_code)]
pub fn all() -> &'static [PluginDefinition] {
    DEFINITIONS
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exposes_message_builder_and_dingtalk_contracts() {
        let builder = get("message_builder").unwrap();
        assert_eq!(builder.category, "transform");
        assert!(!builder.terminal);
        assert_eq!(builder.input_type, Some("table,object,text"));
        assert_eq!(builder.output_type, "message");
        assert!(!builder.requires_credential);

        let dingtalk = get("dingtalk").unwrap();
        assert_eq!(dingtalk.category, "sink");
        assert!(dingtalk.terminal);
        assert_eq!(dingtalk.input_type, Some("message,text"));
        assert_eq!(dingtalk.output_type, "none");
        assert!(dingtalk.requires_credential);
    }

    #[test]
    fn rejects_unknown_plugin_key() {
        assert!(get("python").unwrap_err().contains("PLUGIN_UNKNOWN"));
    }
}
