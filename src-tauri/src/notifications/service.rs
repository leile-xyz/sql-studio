use tauri::{AppHandle, Manager};
use tauri_plugin_notification::NotificationExt;

use super::{domain::AppMessage, repository};
use crate::storage::WorkflowDb;

pub fn deliver_if_needed(
    app: &AppHandle,
    db: &WorkflowDb,
    message_id: &str,
) -> Result<bool, String> {
    let connection = db.open_connection()?;
    let message = repository::get(&connection, message_id)?;
    let preferences = repository::preferences(&connection)?;
    if !should_deliver(app, &message, &preferences)? {
        return Ok(false);
    }
    repository::record_windows_delivery(
        &connection,
        &repository::DeliveryUpdate {
            message_id,
            status: "pending",
            error_code: None,
            error_message: None,
        },
    )?;
    let result = app
        .notification()
        .builder()
        .title(&message.title)
        .body(&message.content)
        .show();
    match result {
        Ok(()) => {
            repository::record_windows_delivery(
                &connection,
                &repository::DeliveryUpdate {
                    message_id,
                    status: "succeeded",
                    error_code: None,
                    error_message: None,
                },
            )?;
            Ok(true)
        }
        Err(_) => {
            repository::record_windows_delivery(
                &connection,
                &repository::DeliveryUpdate {
                    message_id,
                    status: "failed",
                    error_code: Some("WINDOWS_NOTIFICATION_FAILED"),
                    error_message: Some("Windows 原生通知投递失败"),
                },
            )?;
            Ok(false)
        }
    }
}

fn should_deliver(
    app: &AppHandle,
    message: &AppMessage,
    preferences: &super::domain::MessagePreferences,
) -> Result<bool, String> {
    let severity_enabled = match message.severity.as_str() {
        "success" => preferences.native_success_enabled,
        "warning" | "error" => preferences.native_failure_enabled,
        _ => false,
    };
    if !severity_enabled {
        return Ok(false);
    }
    let Some(window) = app.get_webview_window("main") else {
        return Ok(true);
    };
    let visible = window.is_visible().map_err(|error| error.to_string())?;
    let focused = window.is_focused().map_err(|error| error.to_string())?;
    Ok(!visible || !focused)
}
