#![cfg_attr(windows, windows_subsystem = "windows")]

mod server;
mod services;

use std::{fs, path::PathBuf};

use server::RunningServer;
use services::AppServices;

fn config_dir() -> Result<PathBuf, String> {
    let base = dirs::config_dir().ok_or("无法定位当前用户配置目录")?;
    let directory = base.join("com.fanxiaofan.sql-studio");
    fs::create_dir_all(&directory).map_err(|error| format!("创建配置目录失败：{error}"))?;
    Ok(directory)
}

#[tokio::main]
async fn main() {
    if let Err(error) = run().await {
        eprintln!("SQL Studio 启动失败：{error}");
        std::process::exit(1);
    }
}

async fn run() -> Result<(), String> {
    let services = AppServices::load(config_dir()?.join("store.json"))?;
    let server = RunningServer::bind(services).await?;
    println!("SQL Studio browser mode: {}", server.url);
    open::that(&server.url).map_err(|error| format!("打开默认浏览器失败：{error}"))?;
    server.serve().await
}
