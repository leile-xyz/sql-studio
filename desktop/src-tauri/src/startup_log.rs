use std::{
    fs::{self, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU8, Ordering},
        Arc, Mutex,
    },
    thread,
    time::Duration,
    time::{SystemTime, UNIX_EPOCH},
};

use tauri::State;

const LOG_FILE_NAME: &str = "sql-studio-startup.log";

pub struct StartupLog {
    path: PathBuf,
    tracker: StartupTracker,
    /// 启动未完成标记：前端确认加载后删除；残留说明上次启动卡死
    pending_marker: Option<PathBuf>,
    write_lock: Mutex<()>,
}

impl StartupLog {
    pub fn new(path: PathBuf, tracker: StartupTracker, pending_marker: Option<PathBuf>) -> Self {
        Self {
            path,
            tracker,
            pending_marker,
            write_lock: Mutex::new(()),
        }
    }

    fn write(&self, level: &str, message: &str) -> Result<(), String> {
        let _guard = self
            .write_lock
            .lock()
            .map_err(|_| "启动日志写锁已损坏".to_string())?;
        write_log(&self.path, level, message).map_err(|error| error.to_string())
    }
}

#[derive(Clone)]
pub struct StartupTracker {
    path: PathBuf,
    phase: Arc<AtomicU8>,
}

impl StartupTracker {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            phase: Arc::new(AtomicU8::new(0)),
        }
    }

    pub fn mark(&self, phase: StartupPhase, message: &str) {
        self.phase.store(phase as u8, Ordering::Release);
        let _ = write_log(&self.path, "INFO", message);
    }

    pub fn start_watchdog(&self) {
        let tracker = self.clone();
        thread::spawn(move || {
            let mut previous_seconds = 0;
            for seconds in [5, 15, 30, 60, 120] {
                thread::sleep(Duration::from_secs(seconds - previous_seconds));
                previous_seconds = seconds;
                let phase = tracker.phase.load(Ordering::Acquire);
                let message = format!(
                    "startup watchdog: elapsed={}s, phase={} ({})",
                    seconds,
                    phase,
                    phase_name(phase)
                );
                let _ = write_log(&tracker.path, "WARN", &message);
                // 前端尚未确认加载即视为疑似卡死，输出 WebView2 进程与崩溃报告健康信息
                if seconds >= 15 && phase < StartupPhase::FrontendLoaded as u8 {
                    for line in crate::startup_diagnostics::runtime_health_lines() {
                        let _ = write_log(&tracker.path, "WARN", &line);
                    }
                }
            }
        });
    }
}

#[derive(Clone, Copy)]
#[repr(u8)]
pub enum StartupPhase {
    NativeEntered = 1,
    EnvironmentLogged = 2,
    PluginsRegistered = 3,
    ContextCreated = 4,
    BuildingApplication = 5,
    ApplicationBuilt = 6,
    EventLoopStarting = 7,
    SetupEntered = 8,
    CreatingMainWindow = 9,
    MainWindowCreated = 10,
    SetupCompleted = 11,
    EventLoopReady = 12,
    FrontendLoaded = 13,
    Exiting = 14,
}

fn phase_name(phase: u8) -> &'static str {
    match phase {
        1 => "native-entered",
        2 => "environment-logged",
        3 => "plugins-registered",
        4 => "context-created",
        5 => "building-application",
        6 => "application-built",
        7 => "event-loop-starting",
        8 => "setup-entered",
        9 => "creating-main-window",
        10 => "main-window-created",
        11 => "setup-completed",
        12 => "event-loop-ready",
        13 => "frontend-loaded",
        14 => "exiting",
        _ => "unknown",
    }
}

pub fn default_log_path() -> PathBuf {
    std::env::temp_dir().join(LOG_FILE_NAME)
}

pub fn reset_log(path: &Path) -> io::Result<()> {
    fs::write(path, b"")
}

pub fn write_log(path: &Path, level: &str, message: &str) -> io::Result<()> {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let normalized = message.replace('\r', "\\r").replace('\n', "\\n");
    let mut file = OpenOptions::new().create(true).append(true).open(path)?;
    writeln!(
        file,
        "[{timestamp}] [{}] {normalized}",
        level.to_uppercase()
    )
}

pub fn install_panic_hook(path: PathBuf) {
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let _ = write_log(&path, "PANIC", &info.to_string());
        default_hook(info);
    }));
}

#[tauri::command]
pub fn frontend_log(
    log: State<'_, StartupLog>,
    level: String,
    message: String,
) -> Result<(), String> {
    log.write(&level, &message)?;
    if message == "frontend window load" {
        log.tracker.mark(
            StartupPhase::FrontendLoaded,
            "frontend load checkpoint confirmed",
        );
        // 启动已确认成功，清除未完成标记，避免下次启动误触发 WebView2 数据重置
        if let Some(marker) = &log.pending_marker {
            match fs::remove_file(marker) {
                Ok(()) => {
                    let _ = log.write("INFO", "startup pending marker cleared");
                }
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => {
                    let _ = log.write(
                        "WARN",
                        &format!("startup pending marker remove failed: {error}"),
                    );
                }
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resets_and_appends_log_lines() {
        let path = std::env::temp_dir().join(format!(
            "sql-studio-startup-log-test-{}.log",
            std::process::id()
        ));
        fs::write(&path, "old content").unwrap();
        reset_log(&path).unwrap();
        write_log(&path, "info", "first\nsecond").unwrap();
        let content = fs::read_to_string(&path).unwrap();
        assert!(content.contains("[INFO] first\\nsecond"));
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn exposes_stable_phase_names() {
        assert_eq!(
            phase_name(StartupPhase::NativeEntered as u8),
            "native-entered"
        );
        assert_eq!(phase_name(255), "unknown");
    }
}
