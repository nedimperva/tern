//! The folder of received attachments and inline images, downloaded on first open. It is only a cache: anything
//! in it comes down from the server again when needed, so it is kept under a cap and can be cleared.

use std::path::{Path, PathBuf};
use std::time::SystemTime;

use tauri::{AppHandle, Manager};

/// Most the folder keeps; what was downloaded longest ago goes first.
const LIMIT: u64 = 1_000_000_000;

pub fn received(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_cache_dir().map_err(|e| e.to_string())?.join("received"))
}

/// Run once at start, off the main thread. Folders named by row id (older builds) go: row ids are reused, so one
/// of them could belong to a different message now. Then the oldest messages' files go until the rest fit.
pub fn tidy(app: &AppHandle) {
    let Ok(base) = received(app) else { return };
    let Ok(entries) = std::fs::read_dir(&base) else { return };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !name.is_empty() && name.bytes().all(|b| b.is_ascii_digit()) {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
    let mut messages: Vec<(SystemTime, u64, PathBuf)> = Vec::new();
    for account in read_dirs(&base) {
        for message in read_dirs(&account) {
            let (size, used) = weigh(&message);
            messages.push((used, size, message));
        }
    }
    let mut total: u64 = messages.iter().map(|m| m.1).sum();
    messages.sort();
    for (_, size, path) in messages {
        if total <= LIMIT {
            break;
        }
        if std::fs::remove_dir_all(&path).is_ok() {
            total -= size;
        }
    }
}

/// How much the folder holds, in bytes.
pub fn size(app: &AppHandle) -> u64 {
    received(app).map(|base| weigh(&base).0).unwrap_or(0)
}

pub fn clear(app: &AppHandle) -> Result<(), String> {
    let base = received(app)?;
    match std::fs::remove_dir_all(&base) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(format!("{}: {e}", base.display())),
        _ => Ok(()),
    }
}

/// A removed account's files.
pub fn forget_account(app: &AppHandle, account_id: i64) {
    if let Ok(base) = received(app) {
        let _ = std::fs::remove_dir_all(base.join(format!("a{account_id}")));
    }
}

fn read_dirs(dir: &Path) -> Vec<PathBuf> {
    std::fs::read_dir(dir)
        .map(|entries| entries.flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect())
        .unwrap_or_default()
}

/// The bytes under `dir` and the newest time any of it was written.
fn weigh(dir: &Path) -> (u64, SystemTime) {
    let mut size = 0;
    let mut newest = SystemTime::UNIX_EPOCH;
    let Ok(entries) = std::fs::read_dir(dir) else { return (0, newest) };
    for entry in entries.flatten() {
        let Ok(meta) = entry.metadata() else { continue };
        let (s, t) = if meta.is_dir() {
            weigh(&entry.path())
        } else {
            (meta.len(), meta.modified().unwrap_or(SystemTime::UNIX_EPOCH))
        };
        size += s;
        newest = newest.max(t);
    }
    (size, newest)
}
