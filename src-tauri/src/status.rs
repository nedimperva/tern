//! `tern --status` (idea 130): one line of JSON for a status bar such as Waybar, read from a small file the
//! running Tern keeps current. The command never opens the database or starts a second Tern; it only reads that
//! file, so a bar can ask every few seconds.

use std::path::PathBuf;

pub const ARG: &str = "--status";

/// Next to Tern's other cache files. Worked out from the environment rather than through Tauri, so the command can
/// find it without starting the app.
fn path() -> Option<PathBuf> {
    let base = if cfg!(windows) {
        std::env::var_os("LOCALAPPDATA").map(PathBuf::from)
    } else {
        std::env::var_os("XDG_CACHE_HOME")
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".cache")))
    };
    Some(base?.join("app.tern.mail").join("status.json"))
}

/// Waybar's custom module JSON: `text` is the count (empty at zero, so the module can hide), `class` says which.
pub fn line(unread: i64) -> String {
    let (text, tooltip, class) = match unread {
        0 => (String::new(), "Tern: inbox read".to_string(), "zero"),
        1 => ("1".into(), "Tern: 1 unread in the inbox".into(), "unread"),
        n => (n.to_string(), format!("Tern: {n} unread in the inbox"), "unread"),
    };
    serde_json::json!({ "text": text, "tooltip": tooltip, "class": class, "alt": class }).to_string()
}

/// Called with the inbox's unread count whenever it may have changed.
pub fn write(unread: i64) {
    let Some(path) = path() else { return };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    // Written beside and renamed, so a bar never reads half a line.
    let tmp = path.with_extension("tmp");
    if std::fs::write(&tmp, line(unread)).and_then(|_| std::fs::rename(&tmp, &path)).is_err() {
        log::warn!("status file: could not write {}", path.display());
    }
}

/// Tern is quitting: a bar should not keep showing a count nobody updates.
pub fn clear() {
    if let Some(path) = path() {
        let _ = std::fs::remove_file(path);
    }
}

/// What `tern --status` prints.
pub fn print() {
    let off =
        serde_json::json!({ "text": "", "tooltip": "Tern is not running", "class": "off", "alt": "off" });
    let line = path().and_then(|p| std::fs::read_to_string(p).ok()).unwrap_or_else(|| off.to_string());
    println!("{}", line.trim());
}

#[cfg(test)]
mod tests {
    use super::line;

    #[test]
    fn the_line_is_waybar_json() {
        let v: serde_json::Value = serde_json::from_str(&line(3)).unwrap();
        assert_eq!(v["text"], "3");
        assert_eq!(v["class"], "unread");
        let v: serde_json::Value = serde_json::from_str(&line(0)).unwrap();
        assert_eq!(v["text"], "");
        assert_eq!(v["class"], "zero");
    }
}
