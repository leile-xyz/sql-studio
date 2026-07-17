#![cfg_attr(windows, windows_subsystem = "windows")]

mod server;
mod services;
#[cfg(windows)]
mod tray;

use std::{fs, path::PathBuf};

use server::RunningServer;
use services::AppServices;

fn config_dir() -> Result<PathBuf, String> {
    let base = dirs::config_dir().ok_or("无法定位当前用户配置目录")?;
    let directory = base.join("com.fanxiaofan.sql-studio");
    fs::create_dir_all(&directory).map_err(|error| format!("创建配置目录失败：{error}"))?;
    Ok(directory)
}

fn main() {
    if let Err(error) = run() {
        eprintln!("SQL Studio 启动失败：{error}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let runtime =
        tokio::runtime::Runtime::new().map_err(|error| format!("创建异步运行时失败：{error}"))?;
    let services = AppServices::load(config_dir()?.join("store.json"))?;
    let server = runtime.block_on(RunningServer::bind(services))?;
    println!("SQL Studio browser mode: {}", server.url);
    open::that(&server.url).map_err(|error| format!("打开默认浏览器失败：{error}"))?;
    #[cfg(windows)]
    {
        tray::run(&runtime, server)
    }
    #[cfg(not(windows))]
    {
        runtime.block_on(server.serve())
    }
}
