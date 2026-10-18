//! Updates for the builds that replace themselves: the AppImage and the Windows installers. A `.deb`, `.rpm` or
//! AUR install belongs to its package manager, so Tern never looks for updates there.
//!
//! An update is downloaded and its signature checked in the background; it is only installed when the person
//! picks "Restart to update", so nothing restarts under them.

use std::sync::Mutex;
use std::time::{Duration, SystemTime};

use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

/// Leaves the network to a login start and the first sync.
const FIRST_LOOK: Duration = Duration::from_secs(60);
/// Measured on the wall clock, waking hourly: a monotonic sleep stops while the laptop sleeps.
const DAILY: Duration = Duration::from_secs(24 * 3600);
const WAKE: Duration = Duration::from_secs(3600);

/// A downloaded, verified update waiting for the restart.
#[derive(Default)]
pub struct Updates(Mutex<Option<(Update, Vec<u8>)>>);

/// Whether this copy of Tern installs its own updates.
fn self_updating() -> bool {
    if cfg!(debug_assertions) {
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

/// Downloads a newer release if there is one; true once it is ready.
async fn fetch(app: &AppHandle) -> tauri_plugin_updater::Result<bool> {
    let Some(update) = app.updater()?.check().await? else {
        return Ok(false);
    };
    // `download` checks the signature against the public key in tauri.conf.json.
    let bytes = update.download(|_, _| {}, || {}).await?;
    let version = update.version.clone();
    log::info!("update {version} is ready");
    *app.state::<Updates>().0.lock().unwrap() = Some((update, bytes));
    let _ = app.emit("update-ready", version);
    Ok(true)
}

/// The version waiting for a restart, for a window that asks after the event went out.
pub fn ready(app: &AppHandle) -> Option<String> {
    app.state::<Updates>().0.lock().unwrap().as_ref().map(|(u, _)| u.version.clone())
}

/// Installs the waiting update and starts the new version. The window has saved what was being written.
pub fn install(app: &AppHandle) -> anyhow::Result<()> {
    let Some((update, bytes)) = app.state::<Updates>().0.lock().unwrap().take() else {
        anyhow::bail!("no update is waiting");
    };
    // On Windows this runs the installer and exits; the installer starts the new version.
    update.install(&bytes)?;
    app.restart()
}
