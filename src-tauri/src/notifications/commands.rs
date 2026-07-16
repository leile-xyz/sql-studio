use tauri::{AppHandle, State};

use super::{
    domain::{AppMessage, MessagePreferences, UnreadCount, UpdateMessagePreferences},
    repository, service,
};
use crate::storage::WorkflowDb;

#[tauri::command]
pub fn message_list(db: State<'_, WorkflowDb>) -> Result<Vec<AppMessage>, String> {
    repository::list(&db.open_connection()?)
}

#[tauri::command]
pub fn message_unread_count(db: State<'_, WorkflowDb>) -> Result<UnreadCount, String> {
    Ok(UnreadCount {
        count: repository::unread_count(&db.open_connection()?)?,
    })
}

#[tauri::command]
pub fn message_mark_read(db: State<'_, WorkflowDb>, message_id: String) -> Result<(), String> {
    repository::mark_read(&db.open_connection()?, &message_id)
}

#[tauri::command]
pub fn message_mark_all_read(db: State<'_, WorkflowDb>) -> Result<usize, String> {
    repository::mark_all_read(&db.open_connection()?)
}

#[tauri::command]
pub fn message_preferences_get(db: State<'_, WorkflowDb>) -> Result<MessagePreferences, String> {
    repository::preferences(&db.open_connection()?)
}

#[tauri::command]
pub fn message_preferences_update(
    db: State<'_, WorkflowDb>,
    input: UpdateMessagePreferences,
) -> Result<(), String> {
    repository::update_preferences(&db.open_connection()?, &input)
}

#[tauri::command]
pub fn message_deliver_native(
    app: AppHandle,
    db: State<'_, WorkflowDb>,
    message_id: String,
) -> Result<bool, String> {
    service::deliver_if_needed(&app, &db, &message_id)
}
