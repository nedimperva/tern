#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;

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

/// Starts the account's sync worker, which runs for the life of the app.
pub fn start_account(app: &AppHandle, state: &AppState, account: Account) {
    let password = match secrets::password(&account.config.email) {
        Ok(p) => p,
        Err(e) => {
            log::error!("{e:#}");
            state.states.lock().unwrap().insert(account.id, SyncState::AuthFailed);
            return;
        }
    };
    let wake = Arc::new(Notify::new());
    state.wakers.lock().unwrap().insert(account.id, wake.clone());
    let handle = app.clone();
    let on_change: Arc<dyn Fn() + Send + Sync> = Arc::new(move || {
        let _ = handle.emit("mail-changed", ());
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
    // Errors from the sync workers go to stderr; RUST_LOG=tern_core=debug shows each fetch as well.
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            let state = AppState {
                store: Arc::new(Store::open(&dir.join("mail.db"))?),
                wakers: Default::default(),
                states: Default::default(),
            };
            for account in state.store.accounts()? {
                start_account(app.handle(), &state, account);
            }
            app.manage(state);
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::Focused(true) = event {
                window.state::<AppState>().wake_all();
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::accounts,
            commands::folders,
            commands::preset,
            commands::add_account,
            commands::list_messages,
            commands::thread,
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
            commands::check_folder,
            commands::list_threads,
            commands::apply_conversations,
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
            commands::open_attachment,
            commands::save_attachment,
            commands::contacts,
            commands::muted,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Tern");
}
