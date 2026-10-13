#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use tauri::{AppHandle, Emitter, Manager};
use tern_core::{secrets, sync, Account, Store};
use tokio::sync::Notify;

/// Seconds an action waits in the outbox before it goes to the server: the undo window.
pub const UNDO_SECONDS: i64 = 5;

pub struct AppState {
    pub store: Arc<Store>,
    /// One per account: notify to make its sync worker look at the outbox now.
    pub wakers: Mutex<HashMap<i64, Arc<Notify>>>,
}

impl AppState {
    pub fn wake(&self, account_id: i64) {
        if let Some(waker) = self.wakers.lock().unwrap().get(&account_id) {
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
            return;
        }
    };
    let wake = Arc::new(Notify::new());
    state.wakers.lock().unwrap().insert(account.id, wake.clone());
    let handle = app.clone();
    let on_change: Arc<dyn Fn() + Send + Sync> = Arc::new(move || {
        let _ = handle.emit("mail-changed", ());
    });
    tauri::async_runtime::spawn(sync::run_account(state.store.clone(), account, password, wake, on_change));
}

fn main() {
    // Errors from the sync workers go to stderr; RUST_LOG=tern_core=debug shows each fetch as well.
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            let state =
                AppState { store: Arc::new(Store::open(&dir.join("mail.db"))?), wakers: Default::default() };
            for account in state.store.accounts()? {
                start_account(app.handle(), &state, account);
            }
            app.manage(state);
            Ok(())
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running Tern");
}
