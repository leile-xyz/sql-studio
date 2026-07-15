use std::path::Path;

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager,
};

const MAIN_WINDOW_LABEL: &str = "main";
const TRAY_ICON_ID: &str = "sql-studio-tray";
const SHOW_MENU_ID: &str = "tray-show-main";
const QUIT_MENU_ID: &str = "tray-quit";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TrayAction {
    ShowMainWindow,
    Quit,
}

pub fn setup_tray(app: &tauri::App, log_path: &Path) -> Result<(), Box<dyn std::error::Error>> {
    let show_item = MenuItem::with_id(app, SHOW_MENU_ID, "显示主窗口", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, QUIT_MENU_ID, "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show_item, &quit_item])?;
    let icon = app
        .default_window_icon()
        .cloned()
        .ok_or("default window icon missing")?;
    let menu_log_path = log_path.to_path_buf();
    let click_log_path = log_path.to_path_buf();

    TrayIconBuilder::with_id(TRAY_ICON_ID)
        .icon(icon)
        .tooltip("SQL Studio（后台运行中）")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(move |handle, event| {
            handle_tray_action(
                handle,
                action_from_menu_id(event.id().as_ref()),
                &menu_log_path,
            );
        })
        .on_tray_icon_event(move |tray, event| {
            if is_restore_click(&event) {
                restore_main_window(tray.app_handle(), &click_log_path);
            }
        })
        .build(app)?;
    Ok(())
}

pub fn hide_main_window(window: &tauri::Window, log_path: &Path) {
    if let Err(error) = window.hide() {
        log_error(log_path, &format!("main window hide failed: {error}"));
        return;
    }
    let _ = crate::startup_log::write_log(
        log_path,
        "INFO",
        "main window hidden; application continues in system tray",
    );
}

fn action_from_menu_id(menu_id: &str) -> Option<TrayAction> {
    match menu_id {
        SHOW_MENU_ID => Some(TrayAction::ShowMainWindow),
        QUIT_MENU_ID => Some(TrayAction::Quit),
        _ => None,
    }
}

fn handle_tray_action(handle: &AppHandle, action: Option<TrayAction>, log_path: &Path) {
    match action {
        Some(TrayAction::ShowMainWindow) => restore_main_window(handle, log_path),
        Some(TrayAction::Quit) => {
            let _ = crate::startup_log::write_log(log_path, "INFO", "tray exit selected");
            handle.exit(0);
        }
        None => {}
    }
}

fn is_restore_click(event: &TrayIconEvent) -> bool {
    matches!(
        event,
        TrayIconEvent::Click {
            button: MouseButton::Left,
            button_state: MouseButtonState::Up,
            ..
        }
    )
}

fn restore_main_window(handle: &AppHandle, log_path: &Path) {
    let Some(window) = handle.get_webview_window(MAIN_WINDOW_LABEL) else {
        log_error(log_path, "main window missing while restoring from tray");
        return;
    };
    if let Err(error) = window
        .unminimize()
        .and_then(|_| window.show())
        .and_then(|_| window.set_focus())
    {
        log_error(log_path, &format!("main window restore failed: {error}"));
        return;
    }
    let _ = crate::startup_log::write_log(log_path, "INFO", "main window restored from tray");
}

fn log_error(log_path: &Path, message: &str) {
    let _ = crate::startup_log::write_log(log_path, "ERROR", message);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_known_tray_menu_actions() {
        assert_eq!(
            action_from_menu_id(SHOW_MENU_ID),
            Some(TrayAction::ShowMainWindow)
        );
        assert_eq!(action_from_menu_id(QUIT_MENU_ID), Some(TrayAction::Quit));
        assert_eq!(action_from_menu_id("unknown"), None);
    }
}
