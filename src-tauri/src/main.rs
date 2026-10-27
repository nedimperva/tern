#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod cache;
mod commands;
mod desktop;
mod diagnostics;
mod update;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use tauri::{AppHandle, Emitter, Manager, WindowEvent};
use tern_core::sync::SyncState;
use tern_core::{secrets, sync, Account, Store};
use tokio::sync::Notify;

/// Seconds an action waits in the outbox before it goes to the server: the undo window.
pub const UNDO_SECONDS: i64 = 5;

pub struct AppState {
    pub store: Arc<Store>,
    /// One per account: notify to make its sync worker look at the outbox now.
    pub wakers: Mutex<HashMap<i64, Arc<Notify>>>,
    /// The last `SyncState` each account's worker reported, for a window that asks after the event went out.
    pub states: Arc<Mutex<HashMap<i64, SyncState>>>,
    /// Every account's sync worker waits while this is true (Pause sync). Not kept across restarts, so a
    /// forgotten pause can't stop mail for good.
    pub pause: tokio::sync::watch::Sender<bool>,
}

/// What the "sync-state" event carries.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct StateEvent {
    account_id: i64,
    state: SyncState,
}

impl AppState {
    pub fn wake(&self, account_id: i64) {
        if let Some(waker) = self.wakers.lock().unwrap().get(&account_id) {
            waker.notify_one();
        }
    }

    /// Every account looks now: the window got focus, so the person is about to look at their mail.
    pub fn wake_all(&self) {
        for waker in self.wakers.lock().unwrap().values() {
            waker.notify_one();
        }
    }
}

/// The Google client baked in at build time (see build.rs), or None: then Gmail takes an app password.
pub fn google() -> Option<tern_core::oauth::Provider> {
    let id = option_env!("TERN_GOOGLE_CLIENT_ID")?;
    let secret = option_env!("TERN_GOOGLE_CLIENT_SECRET").filter(|s| !s.is_empty());
    Some(tern_core::oauth::Provider::google(id, secret, tern_core::oauth::GOOGLE_MAIL_SCOPES))
}

/// How the account signs in, read from the keychain at each connect.
pub fn login(account: &Account) -> secrets::Login {
    secrets::Login::keychain(&account.config.email, google())
}

/// Starts the account's sync worker, which runs for the life of the app.
pub fn start_account(app: &AppHandle, state: &AppState, account: Account) {
    let email = &account.config.email;
    if secrets::password(email).is_err() && secrets::tokens(email).is_err() {
        log::error!("account {}: no saved password or Google sign-in", account.id);
        state.states.lock().unwrap().insert(account.id, SyncState::AuthFailed);
        return;
    }
    let password = login(&account);
    let wake = Arc::new(Notify::new());
    state.wakers.lock().unwrap().insert(account.id, wake.clone());
    let handle = app.clone();
    let on_change: Arc<dyn Fn() + Send + Sync> = Arc::new(move || {
        let _ = handle.emit("mail-changed", ());
        desktop::mail_changed(&handle);
    });
    let (handle, states, account_id) = (app.clone(), state.states.clone(), account.id);
    let on_state: Arc<dyn Fn(SyncState) + Send + Sync> = Arc::new(move |s| {
        states.lock().unwrap().insert(account_id, s);
        let _ = handle.emit("sync-state", StateEvent { account_id, state: s });
    });
    tauri::async_runtime::spawn(sync::run_account(
        state.store.clone(),
        account,
        password,
        wake,
        state.pause.subscribe(),
        on_change,
        on_state,
    ));
}

fn main() {
    // WebKitGTK's DMA-BUF renderer leaves the window blank or crashes on some Wayland setups (NVIDIA among them).
    // Set before any thread starts; someone who sets the variable themselves keeps their choice.
    #[cfg(target_os = "linux")]
    if std::env::var_os("WAYLAND_DISPLAY").is_some()
        && std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none()
    {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }
    tauri::Builder::default()
        // First, so a second start hands over its link (or just brings the window back) and exits.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            desktop::show(app);
            if argv.iter().any(|a| a == desktop::COMPOSE) {
                let _ = app.emit("compose", ());
            }
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![desktop::HIDDEN]),
        ))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(desktop::Desktop::new())
        .manage(update::Updates::default())
        .manage(commands::Offered::default())
        .setup(|app| {
            // First, so everything after it is in the log file too.
            diagnostics::start_logging(&diagnostics::log_dir(app.handle()));
            use tauri_plugin_deep_link::DeepLinkExt;
            let links = app.deep_link().get_current().ok().flatten().unwrap_or_default();
            let mut links: Vec<String> = links.iter().map(|u| u.to_string()).collect();
            // The launcher's Compose action: a new message, as an empty mailto: link would open.
            if std::env::args().any(|a| a == desktop::COMPOSE) {
                links.push("mailto:".into());
            }
            desktop::started_with(app.handle(), &links);
            let handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                desktop::open_links(&handle, &event.urls().iter().map(|u| u.to_string()).collect::<Vec<_>>())
            });
            // The window starts hidden (tauri.conf.json) so a login start can stay in the tray.
            if !std::env::args().any(|a| a == desktop::HIDDEN) {
                desktop::show(app.handle());
            }
            if let Err(e) = desktop::tray(app.handle()) {
                log::warn!("no tray: {e}");
            }
            // Debug builds (`tauri dev`) keep their own store in `dev/`: a newer schema migrates the database
            // forward only, and the installed Tern could not open its mail afterwards. TERN_DB opens another store,
            // such as one from `gen_mailbox`.
            let dir = app.path().app_data_dir()?;
            let dir = if cfg!(debug_assertions) { dir.join("dev") } else { dir };
            std::fs::create_dir_all(&dir)?;
            let db = std::env::var_os("TERN_DB").map(std::path::PathBuf::from).unwrap_or(dir.join("mail.db"));
            log::info!("mail database: {}", db.display());
            let state = AppState {
                store: Arc::new(Store::open(&db)?),
                wakers: Default::default(),
                states: Default::default(),
                pause: tokio::sync::watch::channel(false).0,
            };
            // Sends scheduled for a time that passed while Tern was closed wait to be confirmed.
            let held = state.store.hold_overdue(desktop::now())?;
            if held > 0 {
                log::info!("{held} scheduled send(s) came due while Tern was closed; holding them");
            }
            for account in state.store.accounts()? {
                start_account(app.handle(), &state, account);
            }
            app.manage(state);
            if held > 0 {
                desktop::notify_held(app.handle(), held);
            }
            // Sets the mark that later mail is measured against.
            desktop::mail_changed(app.handle());
            desktop::watch_snoozes(app.handle());
            update::watch(app.handle());
            let handle = app.handle().clone();
            tauri::async_runtime::spawn_blocking(move || cache::tidy(&handle));
            Ok(())
        })
        .on_window_event(|window, event| match event {
            WindowEvent::Focused(true) => window.state::<AppState>().wake_all(),
            WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) => {
                commands::files_dropped(window.app_handle(), paths)
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            commands::accounts,
            commands::set_account_name,
            commands::folders,
            commands::preset,
            commands::add_account,
            commands::set_password,
            commands::remove_account,
            commands::received_cache_size,
            commands::clear_received_cache,
            commands::google_available,
            commands::google_sign_in,
            commands::list_messages,
            commands::thread,
            commands::sender_logo,
            commands::day_start,
            commands::ai_has_key,
            commands::ai_set_key,
            commands::ai_forget_key,
            commands::ai_models,
            commands::ai_test,
            commands::ai_cached_summary,
            commands::ai_summarize,
            commands::ai_replies,
            commands::ai_write,
            commands::ai_clear_cache,
            commands::ai_stats,
            commands::ai_style,
            commands::ai_learn_style,
            commands::ai_set_style,
            commands::read_later,
            commands::marks,
            commands::add_mark,
            commands::set_mark_note,
            commands::delete_mark,
            commands::search,
            commands::apply,
            commands::undo,
            commands::send,
            commands::problems,
            commands::retry_problem,
            commands::discard_problem,
            commands::waiting,
            commands::discard_waiting,
            commands::network_back,
            commands::sync_states,
            commands::sync_progress,
            commands::check_folder,
            commands::list_threads,
            commands::apply_conversations,
            commands::label_conversations,
            commands::settings,
            commands::set_setting,
            commands::mute,
            commands::reply_init,
            commands::save_draft,
            commands::draft,
            commands::draft_for_message,
            commands::discard_draft,
            commands::undo_discard,
            commands::problem_to_draft,
            commands::add_attachments,
            commands::pick_files,
            commands::open_attachment,
            commands::inline_images,
            commands::save_attachment,
            commands::contacts,
            commands::contact_card,
            commands::muted,
            commands::take_mailto,
            commands::quit,
            commands::set_sync_paused,
            commands::about,
            commands::open_logs,
            commands::send_now,
            commands::update_ready,
            commands::restart_to_update,
            commands::autostart,
            commands::set_autostart,
            commands::default_mail_app,
            commands::make_default_mail_app,
            commands::set_split,
            commands::split_unread,
            commands::snooze,
            commands::unsnooze,
            commands::parse_when,
            commands::attachment_preview,
            commands::outgoing_preview,
            commands::attachment_bytes,
            commands::snippets,
            commands::save_snippet,
            commands::delete_snippet,
            commands::snippet_used,
            commands::signatures,
            commands::save_signature,
            commands::set_signature_default,
            commands::delete_signature,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Tern");
}
