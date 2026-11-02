//! Updates for the builds that replace themselves: the AppImage and the Windows installers. A `.deb`, `.rpm` or
//! AUR install belongs to its package manager, so Tern never looks for updates there.
//!
//! An update is downloaded and its signature checked in the background; it is only installed when the person
//! picks "Restart to update", so nothing restarts under them.
//!
//! Two channels (Settings → About → Updates): Stable reads `latest.json` on the newest release, Beta reads
//! `latest-beta.json` on the rolling `beta` release, which `beta-feed.yml` points at the newest published release,
//! beta or stable. Either way only a newer version installs: going back to Stable keeps the beta until a stable
//! release passes it, as the mail database only migrates forward.

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, SystemTime};

use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::AppState;

/// Leaves the network to a login start and the first sync.
const FIRST_LOOK: Duration = Duration::from_secs(60);
/// Measured on the wall clock, waking hourly: a monotonic sleep stops while the laptop sleeps.
const DAILY: Duration = Duration::from_secs(24 * 3600);
const WAKE: Duration = Duration::from_secs(3600);

/// The beta channel's feed, signed like the stable one.
const BETA_FEED: &str = "https://github.com/nedimperva/tern/releases/download/beta/latest-beta.json";

/// A downloaded, verified update waiting for the restart, and the file it waits in: an installer is tens of MB,
/// too much to keep in memory for the days it may wait.
#[derive(Default)]
pub struct Updates(Mutex<Option<(Update, PathBuf)>>);

/// Whether this copy of Tern installs its own updates.
pub fn self_updating() -> bool {
    // A build handed out by hand (`TERN_NO_UPDATES=1 npm run tauri build`, say with its own Google client) stays as
    // it is: the releases would replace it with a build that lacks what it was made with.
    if cfg!(debug_assertions) || option_env!("TERN_NO_UPDATES").is_some() {
        return false;
    }
    // The AppImage runtime sets APPIMAGE to the file it started from; the updater replaces that file.
    cfg!(windows) || (cfg!(target_os = "linux") && std::env::var_os("APPIMAGE").is_some())
}

/// Looks for an update a minute after start and then once a day, until one is ready.
pub fn watch(app: &AppHandle) {
    if !self_updating() {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(FIRST_LOOK).await;
        let mut last: Option<SystemTime> = None;
        loop {
            if last.is_none_or(|t| t.elapsed().unwrap_or(DAILY) >= DAILY) {
                last = Some(SystemTime::now());
                match fetch(&app).await {
                    Ok(true) => return,
                    Ok(false) => {}
                    Err(e) => log::warn!("update check: {e}"),
                }
            }
            tokio::time::sleep(WAKE).await;
        }
    });
}

/// Whether the person picked the beta channel. Read at each look, so a change counts from the next one.
fn beta(app: &AppHandle) -> bool {
    let settings = app.try_state::<AppState>().and_then(|s| s.store.settings().ok()).unwrap_or_default();
    settings.get("updateChannel").and_then(|v| v.as_str()) == Some("beta")
}

/// Looks once now, when the person changes the channel: the daily look may be a day away. Nothing happens when an
/// update already waits or this copy does not update itself.
pub fn look_now(app: &AppHandle) {
    if !self_updating() || ready(app).is_some() {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = fetch(&app).await {
            log::warn!("update check: {e}");
        }
    });
}

/// Downloads a newer release if there is one; true once it is ready.
async fn fetch(app: &AppHandle) -> tauri_plugin_updater::Result<bool> {
    let updater = if beta(app) {
        let feed = BETA_FEED.parse().expect("the beta feed is a URL");
        app.updater_builder().endpoints(vec![feed])?.build()?
    } else {
        app.updater()?
    };
    let Some(update) = updater.check().await? else {
        return Ok(false);
    };
    // `download` checks the signature against the public key in tauri.conf.json.
    let bytes = update.download(|_, _| {}, || {}).await?;
    let version = update.version.clone();
    let dir = app.path().app_cache_dir()?.join("update");
    // One update waits at a time; an older one left from a run that never restarted goes.
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir)?;
    let file = dir.join(format!("tern-{version}.update"));
    std::fs::write(&file, &bytes)?;
    drop(bytes);
    log::info!("update {version} is ready");
    *app.state::<Updates>().0.lock().unwrap() = Some((update, file));
    let _ = app.emit("update-ready", version);
    Ok(true)
}

/// The version waiting for a restart, for a window that asks after the event went out.
pub fn ready(app: &AppHandle) -> Option<String> {
    app.state::<Updates>().0.lock().unwrap().as_ref().map(|(u, _)| u.version.clone())
}

/// Installs the waiting update and starts the new version. The window has saved what was being written.
pub fn install(app: &AppHandle) -> anyhow::Result<()> {
    let Some((update, file)) = app.state::<Updates>().0.lock().unwrap().take() else {
        anyhow::bail!("no update is waiting");
    };
    let bytes = std::fs::read(&file)?;
    let _ = std::fs::remove_file(&file);
    // On Windows this runs the installer and exits; the installer starts the new version.
    update.install(&bytes)?;
    app.restart()
}
