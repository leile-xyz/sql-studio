use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppMessage {
    pub id: String,
    pub message_kind: String,
    pub severity: String,
    pub title: String,
    pub content: String,
    pub workflow_id: Option<String>,
    pub execution_id: Option<String>,
    pub state: String,
    pub created_at: String,
    pub read_at: Option<String>,
}

#[derive(Clone, Debug)]
pub struct NewMessage {
    pub message_kind: String,
    pub severity: String,
    pub title: String,
    pub content: String,
    pub workflow_id: Option<String>,
    pub execution_id: Option<String>,
    pub dedupe_key: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessagePreferences {
    pub native_success_enabled: bool,
    pub native_failure_enabled: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateMessagePreferences {
    pub native_success_enabled: bool,
    pub native_failure_enabled: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnreadCount {
    pub count: i64,
}
