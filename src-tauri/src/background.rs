use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle,
};

use crate::lifecycle;

const TRAY_ICON_ID: &str = "sql-studio-tray";
const SHOW_MENU_ID: &str = "tray-show-main";
const LIGHTWEIGHT_MENU_ID: &str = "tray-lightweight-mode";
const QUIT_MENU_ID: &str = "tray-quit";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TrayAction {
    ShowMainWindow,
    EnterLightweight,
    Quit,
}

pub fn setup_tray(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let show_item = MenuItem::with_id(app, SHOW_MENU_ID, "打开主界面", true, None::<&str>)?;
    let lightweight_item = MenuItem::with_id(
        app,
        LIGHTWEIGHT_MENU_ID,
        "进入轻量模式",
        true,
        None::<&str>,
    )?;
    let quit_item = MenuItem::with_id(app, QUIT_MENU_ID, "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show_item, &lightweight_item, &quit_item])?;
    let icon = app
        .default_window_icon()
        .cloned()
        .ok_or("default window icon missing")?;
    TrayIconBuilder::with_id(TRAY_ICON_ID)
        .icon(icon)
        .tooltip("SQL Studio（原生后台运行中）")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(move |handle, event| {
            let action = action_from_menu_id(event.id().as_ref());
            handle_tray_action(handle, action);
        })
        .on_tray_icon_event(move |tray, event| {
            if is_restore_click(&event) {
                restore_main_window(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

fn action_from_menu_id(menu_id: &str) -> Option<TrayAction> {
    match menu_id {
        SHOW_MENU_ID => Some(TrayAction::ShowMainWindow),
        LIGHTWEIGHT_MENU_ID => Some(TrayAction::EnterLightweight),
        QUIT_MENU_ID => Some(TrayAction::Quit),
        _ => None,
    }
}

fn handle_tray_action(handle: &AppHandle, action: Option<TrayAction>) {
    match action {
        Some(TrayAction::ShowMainWindow) => restore_main_window(handle),
        Some(TrayAction::EnterLightweight) => enter_lightweight_mode(handle),
        Some(TrayAction::Quit) => handle.exit(0),
        None => {}
    }
}

fn enter_lightweight_mode(handle: &AppHandle) {
    let handle = handle.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(error) = lifecycle::set_mode_from_handle(&handle, true).await {
            eprintln!("进入轻量模式失败：{error}");
        }
    });
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

pub fn restore_main_window(handle: &AppHandle) {
    let handle = handle.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(error) = lifecycle::show_or_create_main_window(&handle) {
            eprintln!("从系统托盘恢复主窗口失败：{error}");
        }
    });
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
        assert_eq!(
            action_from_menu_id(LIGHTWEIGHT_MENU_ID),
            Some(TrayAction::EnterLightweight)
        );
        assert_eq!(action_from_menu_id(QUIT_MENU_ID), Some(TrayAction::Quit));
        assert_eq!(action_from_menu_id("unknown"), None);
    }
}
