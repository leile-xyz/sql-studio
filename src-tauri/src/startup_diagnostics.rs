use std::{
    env, fs,
    path::{Path, PathBuf},
};

use tauri::{plugin::TauriPlugin, Wry};

#[cfg(windows)]
use winreg::{enums::*, RegKey};

/// 与 tauri.conf.json 的 identifier 保持一致；用于在拿到 AppHandle 之前定位
/// WebView2 用户数据目录（%LOCALAPPDATA%\{identifier}\EBWebView）。
const APP_IDENTIFIER: &str = "com.fanxiaofan.sql-studio";

/// 启动未完成标记文件名，位于应用本地数据目录
const PENDING_MARKER_FILE: &str = "startup-pending.flag";

pub fn local_app_data_dir() -> Option<PathBuf> {
    env::var_os("LOCALAPPDATA").map(|base| PathBuf::from(base).join(APP_IDENTIFIER))
}

/// Fixed Version 运行时支持：exe 同目录存在 WebView2Runtime\msedgewebview2.exe 时，
/// 通过 WEBVIEW2_BROWSER_EXECUTABLE_FOLDER 优先使用该固定版本运行时，
/// 不再依赖机器上自动升级的常青运行时。用户已显式设置该环境变量时不覆盖。
/// 必须在创建 WebView2 环境之前调用（main 最早期）。
pub fn apply_fixed_runtime() -> Vec<String> {
    if env::var_os("WEBVIEW2_BROWSER_EXECUTABLE_FOLDER").is_some() {
        return vec![
            "WEBVIEW2_BROWSER_EXECUTABLE_FOLDER already set, fixed runtime detection skipped"
                .to_string(),
        ];
    }
    let Some(runtime_dir) = env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|dir| dir.join("WebView2Runtime")))
    else {
        return vec!["current exe path unresolved, fixed runtime detection skipped".to_string()];
    };
    if !runtime_dir.join("msedgewebview2.exe").exists() {
        return vec![format!(
            "no fixed webview2 runtime at {}, using evergreen runtime",
            runtime_dir.display()
        )];
    }
    env::set_var("WEBVIEW2_BROWSER_EXECUTABLE_FOLDER", &runtime_dir);
    vec![format!(
        "fixed webview2 runtime enabled: {}",
        runtime_dir.display()
    )]
}

pub fn pending_marker_path(local_data_dir: &Path) -> PathBuf {
    local_data_dir.join(PENDING_MARKER_FILE)
}

/// 读取连续失败次数并在需要时重置 WebView2 用户数据。
/// 返回 (日志行, 此前连续未完成的启动次数)：标记不存在为 0；
/// 标记内容为上次启动写入的失败计数，解析失败按 1 处理。
/// 用户数据损坏是 WebView2 控制器创建挂死的常见原因；业务数据在 store.json，不受影响。
pub fn recover_webview_data(local_data_dir: &Path) -> (Vec<String>, u32) {
    let marker = pending_marker_path(local_data_dir);
    let failed_startups = match fs::read_to_string(&marker) {
        Err(_) => {
            return (
                vec!["previous startup completed normally, keeping webview data".to_string()],
                0,
            )
        }
        Ok(content) => content.trim().parse::<u32>().unwrap_or(1).max(1),
    };
    let mut lines = vec![format!(
        "previous startup did not complete (consecutive failures={failed_startups}), resetting webview data"
    )];
    let data_dir = local_data_dir.join("EBWebView");
    if !data_dir.exists() {
        lines.push("webview data directory does not exist, nothing to reset".to_string());
        return (lines, failed_startups);
    }
    let backup = local_data_dir.join("EBWebView.broken");
    if backup.exists() {
        match fs::remove_dir_all(&backup) {
            Ok(()) => lines.push("stale webview data backup removed".to_string()),
            Err(error) => {
                lines.push(format!("stale webview data backup remove failed: {error}"));
            }
        }
    }
    match fs::rename(&data_dir, &backup) {
        Ok(()) => lines.push(format!(
            "webview data moved to {} for a clean restart",
            backup.display()
        )),
        Err(error) => lines.push(format!(
            "webview data rename failed (possibly locked by a leftover msedgewebview2.exe): {error}"
        )),
    }
    (lines, failed_startups)
}

/// 写入未完成标记，内容为「若本次也失败，下次启动应读到的连续失败次数」
pub fn write_pending_marker(local_data_dir: &Path, failed_startups: u32) -> Vec<String> {
    let marker = pending_marker_path(local_data_dir);
    match fs::write(&marker, (failed_startups + 1).to_string()) {
        Ok(()) => vec![format!(
            "startup pending marker written: {}",
            marker.display()
        )],
        Err(error) => vec![format!("startup pending marker write failed: {error}")],
    }
}

/// 看门狗判定疑似卡死时输出的运行期健康信息：
/// WebView2 子进程是否存在、Crashpad 是否有崩溃报告。
pub fn runtime_health_lines() -> Vec<String> {
    let mut lines = webview2_process_lines();
    match local_app_data_dir() {
        Some(dir) => lines.extend(crashpad_report_lines(&dir)),
        None => lines.push("LOCALAPPDATA unset, cannot inspect webview data".to_string()),
    }
    lines
}

#[cfg(windows)]
fn webview2_process_lines() -> Vec<String> {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };

    let snapshot = match unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) } {
        Ok(handle) => handle,
        Err(error) => return vec![format!("process snapshot failed: {error}")],
    };
    let mut entry = PROCESSENTRY32W {
        dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
        ..Default::default()
    };
    let mut lines = Vec::new();
    if unsafe { Process32FirstW(snapshot, &mut entry) }.is_ok() {
        loop {
            let name_len = entry
                .szExeFile
                .iter()
                .position(|c| *c == 0)
                .unwrap_or(entry.szExeFile.len());
            let name = String::from_utf16_lossy(&entry.szExeFile[..name_len]);
            if name.eq_ignore_ascii_case("msedgewebview2.exe") {
                lines.push(format!(
                    "webview2 process pid={} ppid={}",
                    entry.th32ProcessID, entry.th32ParentProcessID
                ));
            }
            if unsafe { Process32NextW(snapshot, &mut entry) }.is_err() {
                break;
            }
        }
    }
    unsafe {
        let _ = CloseHandle(snapshot);
    }
    if lines.is_empty() {
        // 环境创建阶段就失败/被拦截：浏览器进程从未启动
        lines.push(
            "no msedgewebview2.exe process found (browser process never started or keeps crashing)"
                .to_string(),
        );
    } else {
        lines.insert(0, format!("host process pid={}", std::process::id()));
    }
    lines
}

#[cfg(not(windows))]
fn webview2_process_lines() -> Vec<String> {
    Vec::new()
}

fn crashpad_report_lines(local_data_dir: &Path) -> Vec<String> {
    let reports = local_data_dir
        .join("EBWebView")
        .join("Crashpad")
        .join("reports");
    let entries = match fs::read_dir(&reports) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return vec!["no webview2 crashpad reports directory".to_string()];
        }
        Err(error) => return vec![format!("crashpad reports read failed: {error}")],
    };
    let mut lines = Vec::new();
    for entry in entries.flatten().take(10) {
        let metadata = entry.metadata();
        lines.push(format!(
            "webview2 crash report: {} bytes={} modified={:?}",
            entry.file_name().to_string_lossy(),
            metadata.as_ref().map(|m| m.len()).unwrap_or(0),
            metadata.and_then(|m| m.modified())
        ));
    }
    if lines.is_empty() {
        lines.push("webview2 crashpad reports directory is empty".to_string());
    }
    lines
}

pub fn environment_lines(log_path: &Path) -> Vec<String> {
    let mut lines = vec![
        format!("application version={}", env!("CARGO_PKG_VERSION")),
        format!("process id={}", std::process::id()),
        format!("process architecture={}", env::consts::ARCH),
        format!("debug build={}", cfg!(debug_assertions)),
        format!("startup log path={}", log_path.display()),
        format!("current executable={}", display_current_exe()),
        format!("current directory={}", display_current_dir()),
        format!("remote session={}", env_value("SESSIONNAME")),
        format!("APPDATA={}", env_value("APPDATA")),
        format!("LOCALAPPDATA={}", env_value("LOCALAPPDATA")),
        format!("TEMP={}", env_value("TEMP")),
        format!(
            "WEBVIEW2_BROWSER_EXECUTABLE_FOLDER={}",
            env_value("WEBVIEW2_BROWSER_EXECUTABLE_FOLDER")
        ),
        format!(
            "WEBVIEW2_USER_DATA_FOLDER={}",
            env_value("WEBVIEW2_USER_DATA_FOLDER")
        ),
        format!(
            "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS={}",
            env_value("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS")
        ),
        format!(
            "WEBVIEW2_RELEASE_CHANNEL_PREFERENCE={}",
            env_value("WEBVIEW2_RELEASE_CHANNEL_PREFERENCE")
        ),
    ];
    append_windows_lines(&mut lines);
    match local_app_data_dir() {
        Some(dir) => {
            lines.push(format!(
                "webview user data dir={} exists={} pendingMarker={}",
                dir.join("EBWebView").display(),
                dir.join("EBWebView").exists(),
                pending_marker_path(&dir).exists()
            ));
        }
        None => lines.push("webview user data dir unresolved: LOCALAPPDATA unset".to_string()),
    }
    lines
}

pub fn window_state_lines(config_dir: &Path) -> Vec<String> {
    let path = config_dir.join(".window-state.json");
    let mut lines = vec![format!("window state path={}", path.display())];
    match fs::metadata(&path) {
        Ok(metadata) => {
            lines.push(format!("window state bytes={}", metadata.len()));
            lines.push(format!("window state modified={:?}", metadata.modified()));
            let parse_result = fs::read_to_string(&path)
                .map_err(|error| error.to_string())
                .and_then(|text| {
                    serde_json::from_str::<serde_json::Value>(&text)
                        .map_err(|error| error.to_string())
                });
            lines.push(format!("window state JSON valid={}", parse_result.is_ok()));
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            lines.push("window state file does not exist".to_string());
        }
        Err(error) => lines.push(format!("window state metadata error={error}")),
    }
    lines
}

pub fn diagnostic_plugin(log_path: PathBuf) -> TauriPlugin<Wry> {
    let setup_path = log_path.clone();
    let window_path = log_path.clone();
    let webview_path = log_path.clone();
    let navigation_path = log_path.clone();
    tauri::plugin::Builder::new("startup-diagnostics")
        .setup(move |_app, _api| {
            let _ = crate::startup_log::write_log(
                &setup_path,
                "INFO",
                "diagnostic plugin setup entered",
            );
            Ok(())
        })
        .on_window_ready(move |window| {
            let message = format!("window ready: label={}", window.label());
            let _ = crate::startup_log::write_log(&window_path, "INFO", &message);
        })
        .on_webview_ready(move |webview| {
            let message = format!("webview ready: label={}", webview.label());
            let _ = crate::startup_log::write_log(&webview_path, "INFO", &message);
        })
        .on_navigation(move |webview, url| {
            let message = format!("webview navigation: label={} url={url}", webview.label());
            let _ = crate::startup_log::write_log(&navigation_path, "INFO", &message);
            true
        })
        .on_page_load(move |webview, payload| {
            let message = format!(
                "page load: label={} event={:?} url={}",
                webview.label(),
                payload.event(),
                payload.url()
            );
            let _ = crate::startup_log::write_log(&log_path, "INFO", &message);
        })
        .build()
}

fn env_value(name: &str) -> String {
    env::var(name).unwrap_or_else(|_| "<unset>".to_string())
}

fn display_current_exe() -> String {
    env::current_exe()
        .map(|path| path.display().to_string())
        .unwrap_or_else(|error| format!("<error: {error}>"))
}

fn display_current_dir() -> String {
    env::current_dir()
        .map(|path| path.display().to_string())
        .unwrap_or_else(|error| format!("<error: {error}>"))
}

#[cfg(windows)]
fn append_windows_lines(lines: &mut Vec<String>) {
    let version = windows_version::OsVersion::current();
    lines.push(format!(
        "windows version={}.{}.{} UBR={}",
        version.major,
        version.minor,
        version.build,
        windows_version::revision()
    ));
    lines.extend(read_windows_product());
    lines.extend(read_display_adapters());
    lines.extend(read_webview2_runtimes());
    lines.extend(read_webview2_policies());
}

#[cfg(windows)]
fn read_display_adapters() -> Vec<String> {
    let path = "SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}";
    let Ok(class) = RegKey::predef(HKEY_LOCAL_MACHINE).open_subkey(path) else {
        return vec!["display adapter registry class not found".to_string()];
    };
    let mut lines = Vec::new();
    for key_name in class.enum_keys().flatten() {
        let Ok(adapter) = class.open_subkey(&key_name) else {
            continue;
        };
        let description = registry_string(&adapter, "DriverDesc");
        if description == "<unset>" {
            continue;
        }
        lines.push(format!(
            "display adapter key={key_name} name={description} driverVersion={} driverDate={} provider={} deviceId={}",
            registry_string(&adapter, "DriverVersion"),
            registry_string(&adapter, "DriverDate"),
            registry_string(&adapter, "ProviderName"),
            registry_string(&adapter, "MatchingDeviceId")
        ));
    }
    if lines.is_empty() {
        lines.push("display adapter registry entries not found".to_string());
    }
    lines
}

#[cfg(not(windows))]
fn append_windows_lines(_lines: &mut Vec<String>) {}

#[cfg(windows)]
fn read_windows_product() -> Vec<String> {
    let key = RegKey::predef(HKEY_LOCAL_MACHINE)
        .open_subkey("SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion");
    match key {
        Ok(key) => [
            "ProductName",
            "DisplayVersion",
            "EditionID",
            "InstallationType",
        ]
        .into_iter()
        .map(|name| format!("windows {name}={}", registry_string(&key, name)))
        .collect(),
        Err(error) => vec![format!("windows product registry error={error}")],
    }
}

#[cfg(windows)]
fn read_webview2_runtimes() -> Vec<String> {
    let roots = [
        (
            HKEY_LOCAL_MACHINE,
            "HKLM",
            "SOFTWARE\\Microsoft\\EdgeUpdate\\Clients",
        ),
        (
            HKEY_LOCAL_MACHINE,
            "HKLM32",
            "SOFTWARE\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients",
        ),
        (
            HKEY_CURRENT_USER,
            "HKCU",
            "SOFTWARE\\Microsoft\\EdgeUpdate\\Clients",
        ),
    ];
    let mut lines = Vec::new();
    for (hive, label, path) in roots {
        let Ok(clients) = RegKey::predef(hive).open_subkey(path) else {
            continue;
        };
        for key_name in clients.enum_keys().flatten() {
            let Ok(client) = clients.open_subkey(&key_name) else {
                continue;
            };
            let name = registry_string(&client, "name");
            if name.to_lowercase().contains("webview2") {
                lines.push(format!(
                    "webview2 runtime source={label} key={key_name} name={name} version={} location={}",
                    registry_string(&client, "pv"),
                    registry_string(&client, "location")
                ));
            }
        }
    }
    if lines.is_empty() {
        lines.push("webview2 runtime registry entry not found".to_string());
    }
    lines
}

#[cfg(windows)]
fn read_webview2_policies() -> Vec<String> {
    let roots = [
        (
            HKEY_LOCAL_MACHINE,
            "HKLM",
            "SOFTWARE\\Policies\\Microsoft\\Edge\\WebView2",
        ),
        (
            HKEY_CURRENT_USER,
            "HKCU",
            "SOFTWARE\\Policies\\Microsoft\\Edge\\WebView2",
        ),
    ];
    let mut lines = Vec::new();
    for (hive, label, path) in roots {
        let Ok(key) = RegKey::predef(hive).open_subkey(path) else {
            continue;
        };
        for value in key.enum_values().flatten() {
            lines.push(format!(
                "webview2 policy source={label} name={} value={:?}",
                value.0, value.1
            ));
        }
    }
    if lines.is_empty() {
        lines.push("webview2 policy registry entries not found".to_string());
    }
    lines
}

#[cfg(windows)]
fn registry_string(key: &RegKey, name: &str) -> String {
    key.get_value::<String, _>(name)
        .unwrap_or_else(|_| "<unset>".to_string())
}
