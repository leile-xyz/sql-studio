use tao::{
    event::Event,
    event_loop::{ControlFlow, EventLoopBuilder},
};
use tray_icon::{
    menu::{Menu, MenuEvent, MenuItem},
    Icon, MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent,
};

use crate::server::{RunningServer, ShutdownHandle};

const OPEN_MENU_ID: &str = "tray-open-sql-studio";
const QUIT_MENU_ID: &str = "tray-quit-sql-studio";

enum UserEvent {
    Tray(TrayIconEvent),
    Menu(MenuEvent),
    ServerStopped(Result<(), String>),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TrayAction {
    OpenPage,
    Quit,
}

pub fn run(runtime: &tokio::runtime::Runtime, server: RunningServer) -> Result<(), String> {
    let url = server.url.clone();
    let shutdown = server.shutdown_handle();
    let event_loop = EventLoopBuilder::<UserEvent>::with_user_event().build();
    register_event_handlers(&event_loop);
    let tray_icon = build_tray()?;
    spawn_server(runtime, server, event_loop.create_proxy());

    event_loop.run(move |event, _, control_flow| {
        *control_flow = ControlFlow::Wait;
        let _keep_tray_alive = &tray_icon;
        if let Event::UserEvent(event) = event {
            handle_event(event, &url, &shutdown, control_flow);
        }
    });
}

fn register_event_handlers(event_loop: &tao::event_loop::EventLoop<UserEvent>) {
    let tray_proxy = event_loop.create_proxy();
    TrayIconEvent::set_event_handler(Some(move |event| {
        let _ = tray_proxy.send_event(UserEvent::Tray(event));
    }));
    let menu_proxy = event_loop.create_proxy();
    MenuEvent::set_event_handler(Some(move |event| {
        let _ = menu_proxy.send_event(UserEvent::Menu(event));
    }));
}

fn build_tray() -> Result<tray_icon::TrayIcon, String> {
    let menu = Menu::new();
    let open_item = MenuItem::with_id(OPEN_MENU_ID, "打开 SQL Studio", true, None);
    let quit_item = MenuItem::with_id(QUIT_MENU_ID, "退出", true, None);
    menu.append_items(&[&open_item, &quit_item])
        .map_err(|error| format!("创建托盘菜单失败：{error}"))?;
    TrayIconBuilder::new()
        .with_icon(load_icon()?)
        .with_tooltip("SQL Studio（后台运行中）")
        .with_menu(Box::new(menu))
        .with_menu_on_left_click(false)
        .build()
        .map_err(|error| format!("创建系统托盘图标失败：{error}"))
}

fn load_icon() -> Result<Icon, String> {
    let image = image::load_from_memory(include_bytes!("../icons/32x32.png"))
        .map_err(|error| format!("读取托盘图标失败：{error}"))?
        .into_rgba8();
    let (width, height) = image.dimensions();
    Icon::from_rgba(image.into_raw(), width, height)
        .map_err(|error| format!("解析托盘图标失败：{error}"))
}

fn spawn_server(
    runtime: &tokio::runtime::Runtime,
    server: RunningServer,
    proxy: tao::event_loop::EventLoopProxy<UserEvent>,
) {
    runtime.spawn(async move {
        let result = server.serve().await;
        let _ = proxy.send_event(UserEvent::ServerStopped(result));
    });
}

fn handle_event(
    event: UserEvent,
    url: &str,
    shutdown: &ShutdownHandle,
    control_flow: &mut ControlFlow,
) {
    match event {
        UserEvent::Tray(event) if is_open_click(&event) => open_page(url),
        UserEvent::Menu(event) => match action_from_menu_id(event.id().as_ref()) {
            Some(TrayAction::OpenPage) => open_page(url),
            Some(TrayAction::Quit) => request_shutdown(shutdown),
            None => {}
        },
        UserEvent::ServerStopped(result) => {
            if let Err(error) = result {
                eprintln!("SQL Studio 本地服务异常退出：{error}");
            }
            *control_flow = ControlFlow::Exit;
        }
        UserEvent::Tray(_) => {}
    }
}

fn open_page(url: &str) {
    if let Err(error) = open::that(url) {
        eprintln!("打开 SQL Studio 页面失败：{error}");
    }
}

fn request_shutdown(shutdown: &ShutdownHandle) {
    if let Err(error) = shutdown.request() {
        eprintln!("退出 SQL Studio 失败：{error}");
    }
}

fn action_from_menu_id(menu_id: &str) -> Option<TrayAction> {
    match menu_id {
        OPEN_MENU_ID => Some(TrayAction::OpenPage),
        QUIT_MENU_ID => Some(TrayAction::Quit),
        _ => None,
    }
}

fn is_open_click(event: &TrayIconEvent) -> bool {
    matches!(
        event,
        TrayIconEvent::Click {
            button: MouseButton::Left,
            button_state: MouseButtonState::Up,
            ..
        }
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_tray_menu_actions() {
        assert_eq!(
            action_from_menu_id(OPEN_MENU_ID),
            Some(TrayAction::OpenPage)
        );
        assert_eq!(action_from_menu_id(QUIT_MENU_ID), Some(TrayAction::Quit));
        assert_eq!(action_from_menu_id("unknown"), None);
    }
}
