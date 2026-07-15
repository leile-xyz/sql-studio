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

pub fn setup_tray(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let show_item = MenuItem::with_id(app, SHOW_MENU_ID, "显示主窗口", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, QUIT_MENU_ID, "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show_item, &quit_item])?;
    let icon = app
        .default_window_icon()
        .cloned()
        .ok_or("default window icon missing")?;
    TrayIconBuilder::with_id(TRAY_ICON_ID)
        .icon(icon)
        .tooltip("SQL Studio（后台运行中）")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(move |handle, event| {
            handle_tray_action(handle, action_from_menu_id(event.id().as_ref()));
        })
        .on_tray_icon_event(move |tray, event| {
            if is_restore_click(&event) {
                restore_main_window(tray.app_handle()).expect("从系统托盘恢复主窗口失败");
            }
        })
        .build(app)?;
    Ok(())
}

pub fn hide_main_window(window: &tauri::Window) -> tauri::Result<()> {
    window.hide()
}

fn action_from_menu_id(menu_id: &str) -> Option<TrayAction> {
    match menu_id {
        SHOW_MENU_ID => Some(TrayAction::ShowMainWindow),
        QUIT_MENU_ID => Some(TrayAction::Quit),
        _ => None,
    }
}

fn handle_tray_action(handle: &AppHandle, action: Option<TrayAction>) {
    match action {
        Some(TrayAction::ShowMainWindow) => {
            restore_main_window(handle).expect("从系统托盘恢复主窗口失败");
        }
        Some(TrayAction::Quit) => {
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

fn restore_main_window(handle: &AppHandle) -> tauri::Result<()> {
    let window = handle
        .get_webview_window(MAIN_WINDOW_LABEL)
        .expect("主窗口不存在，无法从系统托盘恢复");
    window.unminimize()?;
    window.show()?;
    window.set_focus()
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
