use std::{
    fs::{self, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

use tauri::State;

const LOG_FILE_NAME: &str = "sql-studio-startup.log";

pub struct StartupLog {
    path: PathBuf,
    write_lock: Mutex<()>,
}

impl StartupLog {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
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
    log.write(&level, &message)
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
}
