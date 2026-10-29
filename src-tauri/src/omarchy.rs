//! The Omarchy theme, for the "Follow Omarchy" mood. Omarchy writes the active theme's colours to
//! `~/.local/state/omarchy/current/theme/colors.toml` and bumps `theme.generation` on each switch; Tern reads the
//! one and watches the other, so nothing has to be installed on the Omarchy side.

use std::collections::HashMap;
use std::path::PathBuf;
use std::time::Duration;

use tauri::{AppHandle, Emitter};

/// How often the generation file is looked at. A theme switch takes a second or two anyway.
const LOOK: Duration = Duration::from_secs(2);

fn current() -> Option<PathBuf> {
    if !cfg!(target_os = "linux") {
        return None;
    }
    let home = std::env::var_os("HOME")?;
    Some(PathBuf::from(home).join(".local/state/omarchy/current"))
}

/// The colours as `name → #rrggbb`, plus `mode` (light or dark). None without Omarchy.
pub fn colors() -> Option<HashMap<String, String>> {
    parse(&std::fs::read_to_string(current()?.join("theme/colors.toml")).ok()?)
}

/// `key = "value"` lines. Values go into the window's CSS, so only plain hex colours and the mode get through.
fn parse(text: &str) -> Option<HashMap<String, String>> {
    let mut out = HashMap::new();
    for line in text.lines() {
        let Some((key, value)) = line.split_once('=') else { continue };
        let key = key.trim();
        let value = value.trim().trim_matches('"');
        if key.is_empty() || !key.bytes().all(|b| b.is_ascii_lowercase() || b == b'_') {
            continue;
        }
        let hex =
            value.len() == 7 && value.starts_with('#') && value[1..].bytes().all(|b| b.is_ascii_hexdigit());
        let mode = key == "mode" && (value == "light" || value == "dark");
        if hex || mode {
            out.insert(key.to_string(), value.to_ascii_lowercase());
        }
    }
    (out.contains_key("background") && out.contains_key("foreground")).then_some(out)
}

#[tauri::command]
pub fn omarchy_theme() -> Option<HashMap<String, String>> {
    colors()
}

/// Sends "omarchy-theme" with the new colours whenever the theme is switched.
pub fn watch(app: &AppHandle) {
    let Some(dir) = current() else { return };
    if !dir.exists() {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        let generation = dir.join("theme.generation");
        let mut seen = std::fs::read_to_string(&generation).ok();
        loop {
            std::thread::sleep(LOOK);
            let now = std::fs::read_to_string(&generation).ok();
            if now != seen {
                seen = now;
                if let Some(c) = colors() {
                    let _ = app.emit("omarchy-theme", c);
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::parse;

    #[test]
    fn keeps_colours_and_mode_only() {
        let c = parse(
            "mode = \"dark\"\n\naccent = \"#4A9A68\"\nbackground = \"#101913\"\nforeground = \"#a1af9c\"\n\
             evil = \"red; } body { display: none\"\nwide = \"#1234567\"\nBad-Key = \"#000000\"\n",
        )
        .unwrap();
        assert_eq!(c["mode"], "dark");
        assert_eq!(c["accent"], "#4a9a68");
        assert_eq!(c.len(), 4);
    }

    #[test]
    fn needs_a_background_and_a_foreground() {
        assert!(parse("accent = \"#4a9a68\"\n").is_none());
    }
}
