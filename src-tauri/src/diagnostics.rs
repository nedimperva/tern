//! What a tester needs to report a problem: a log file (as well as the terminal), and a few lines about this copy
//! of Tern that say nothing personal.

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};
use tern_core::sync::SyncState;

use crate::AppState;

/// Past this size the log starts over; the previous one is kept as `.old`.
const LOG_LIMIT: u64 = 5 * 1024 * 1024;

/// Debug builds write their own log, beside their own database (see main.rs).
pub fn log_name() -> &'static str {
    if cfg!(debug_assertions) {
        "tern-dev.log"
    } else {
        "tern.log"
    }
}

/// Logs to stderr and to `<log dir>/tern.log`. Without a writable folder it logs to stderr only.
pub fn start_logging(dir: &Path) {
    let path = dir.join(log_name());
    let file = std::fs::create_dir_all(dir).ok().and_then(|_| {
        if std::fs::metadata(&path).is_ok_and(|m| m.len() > LOG_LIMIT) {
            let _ = std::fs::rename(&path, path.with_extension("log.old"));
        }
        OpenOptions::new().create(true).append(true).open(&path).ok()
    });
    // Errors from the sync workers; RUST_LOG=tern_core=debug shows each fetch as well. imap-codec warns about every
    // server answer it tidies up ("Rectified missing text"), which would bury what matters.
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info,imap_codec=error"))
        .target(env_logger::Target::Pipe(Box::new(Tee(file))))
        .init();
}

/// Each log line to stderr and to the file.
struct Tee(Option<File>);

impl Write for Tee {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        let _ = std::io::stderr().write_all(buf);
        if let Some(file) = &mut self.0 {
            let _ = file.write_all(buf);
        }
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        if let Some(file) = &mut self.0 {
            let _ = file.flush();
        }
        Ok(())
    }
}

pub fn log_dir(app: &AppHandle) -> PathBuf {
    app.path().app_log_dir().unwrap_or_else(|_| std::env::temp_dir())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct About {
    pub version: String,
    pub log_file: String,
    /// For a bug report: the version, the system, and each account's provider and state. No addresses, no hosts
    /// of one's own server.
    pub details: String,
}

pub fn about(app: &AppHandle) -> anyhow::Result<About> {
    let version = app.package_info().version.to_string();
    let log_file = log_dir(app).join(log_name()).display().to_string();
    let mut lines = vec![format!(
        "Tern {version} ({} build, {})",
        if cfg!(debug_assertions) { "debug" } else { "release" },
        install_kind()
    )];
    lines.push(format!("System: {}", system()));
    if let Some(state) = app.try_state::<AppState>() {
        let states = state.states.lock().unwrap().clone();
        for (i, account) in state.store.accounts()?.iter().enumerate() {
            let sync = match states.get(&account.id) {
                Some(SyncState::Idle) | None => "up to date",
                Some(SyncState::Syncing) => "syncing",
                Some(SyncState::Connecting) => "connecting",
                Some(SyncState::Offline) => "offline",
                Some(SyncState::AuthFailed) => "sign-in refused",
                Some(SyncState::Paused) => "paused",
            };
            let auth = match account.config.auth {
                tern_core::Auth::Password => "password",
                tern_core::Auth::Google => "Google",
            };
            lines.push(format!(
                "Account {}: {}, {auth} sign-in, {sync}",
                i + 1,
                provider(&account.config.imap_host)
            ));
        }
        let progress = state.store.sync_progress()?;
        let messages: i64 = progress.iter().map(|p| p.messages).sum();
        let text: i64 = progress.iter().map(|p| p.with_text).sum();
        lines.push(format!("Mail here: {messages} messages, {text} with their text"));
    }
    Ok(About { version, log_file, details: lines.join("\n") })
}

/// Which provider a server belongs to, by name for the big ones; one's own server stays unnamed.
fn provider(host: &str) -> &'static str {
    match host {
        "imap.gmail.com" => "Gmail",
        "imap.fastmail.com" => "Fastmail",
        "outlook.office365.com" | "imap-mail.outlook.com" => "Outlook",
        "imap.mail.yahoo.com" => "Yahoo",
        "imap.mail.me.com" => "iCloud",
        "localhost" | "127.0.0.1" => "local test server",
        _ => "another IMAP server",
    }
}

fn install_kind() -> &'static str {
    if std::env::var_os("APPIMAGE").is_some() {
        "AppImage"
    } else if cfg!(windows) {
        "Windows installer"
    } else {
        "package or local build"
    }
}

fn system() -> String {
    let mut parts = vec![format!("{} {}", std::env::consts::OS, std::env::consts::ARCH)];
    #[cfg(target_os = "linux")]
    {
        let release = std::fs::read_to_string("/etc/os-release").unwrap_or_default();
        if let Some(name) = release.lines().find_map(|l| l.strip_prefix("PRETTY_NAME=")) {
            parts.push(name.trim_matches('"').to_string());
        }
        if let Ok(desktop) = std::env::var("XDG_CURRENT_DESKTOP") {
            parts.push(desktop);
        }
        parts.push(if std::env::var_os("WAYLAND_DISPLAY").is_some() { "Wayland" } else { "X11" }.into());
    }
    parts.join(", ")
}
