//! What the UI can ask for. Reads answer from the store and never touch the network.

use tauri::{AppHandle, Emitter, State};
use tern_core::presets::{self, Preset};
use tern_core::{
    secrets, sync, Account, AccountConfig, Action, Applied, Cursor, Draft, DraftRecord, Folder, ListTarget,
    MessageRow, OutboxProblem, ReplyInit, ReplyKind, ThreadMessage, ThreadRow,
};

use std::collections::HashMap;

use tern_core::sync::SyncState;

use crate::{start_account, AppState, UNDO_SECONDS};

type Reply<T> = Result<T, String>;

fn text(e: anyhow::Error) -> String {
    format!("{e:#}")
}

#[tauri::command]
pub async fn accounts(state: State<'_, AppState>) -> Reply<Vec<Account>> {
    state.store.accounts().map_err(text)
}

#[tauri::command]
pub async fn folders(state: State<'_, AppState>) -> Reply<Vec<Folder>> {
    state.store.folders().map_err(text)
}

#[tauri::command]
pub async fn preset(email: String) -> Reply<Option<Preset>> {
    Ok(presets::for_email(&email))
}

/// Checks the settings against the server, then saves the account and starts syncing it.
#[tauri::command]
pub async fn add_account(
    app: AppHandle,
    state: State<'_, AppState>,
    config: AccountConfig,
    password: String,
) -> Reply<Account> {
    sync::check_login(&config, &password).await.map_err(text)?;
    secrets::set_password(&config.email, &password).map_err(text)?;
    let account = state.store.add_account(&config).map_err(text)?;
    start_account(&app, &state, account.clone());
    Ok(account)
}

#[tauri::command]
pub async fn list_messages(
    state: State<'_, AppState>,
    target: ListTarget,
    before: Option<Cursor>,
    limit: i64,
) -> Reply<Vec<MessageRow>> {
    state.store.list(&target, before, limit).map_err(text)
}

#[tauri::command]
pub async fn thread(state: State<'_, AppState>, id: i64) -> Reply<Vec<ThreadMessage>> {
    let thread = state.store.thread(id).map_err(text)?;
    // Opened before its body came: ask the sync worker for it next. The view reloads on "mail-changed".
    let missing: Vec<i64> = thread.iter().filter(|m| !m.body_loaded).map(|m| m.row.id).collect();
    if !missing.is_empty() {
        for account in state.store.want_bodies(&missing).map_err(text)? {
            state.wake(account);
        }
    }
    Ok(thread)
}

#[tauri::command]
pub async fn search(state: State<'_, AppState>, query: String, limit: i64) -> Reply<Vec<MessageRow>> {
    state.store.search(&query, limit).map_err(text)
}

/// Applies at once; the server hears about it after the undo window.
#[tauri::command]
pub async fn list_threads(
    state: State<'_, AppState>,
    target: ListTarget,
    before: Option<Cursor>,
    limit: usize,
) -> Reply<Vec<ThreadRow>> {
    state.store.list_threads(&target, before, limit).map_err(text)
}

/// An action on whole conversations (each id stands for its conversation); see `Store::conversation_ids`.
#[tauri::command]
pub async fn apply_conversations(
    app: AppHandle,
    state: State<'_, AppState>,
    ids: Vec<i64>,
    action: Action,
    target: ListTarget,
) -> Reply<Applied> {
    let ids = state.store.conversation_ids(&ids, action, &target).map_err(text)?;
    apply(app, state, ids, action).await
}

#[tauri::command]
pub async fn apply(
    app: AppHandle,
    state: State<'_, AppState>,
    ids: Vec<i64>,
    action: Action,
) -> Reply<Applied> {
    let applied = state.store.apply(&ids, action, UNDO_SECONDS).map_err(text)?;
    for account in &applied.accounts {
        state.wake(*account);
    }
    let _ = app.emit("mail-changed", ());
    Ok(applied)
}

#[tauri::command]
pub async fn undo(app: AppHandle, state: State<'_, AppState>, token: Vec<i64>) -> Reply<bool> {
    let undone = state.store.undo(&token).map_err(text)?;
    let _ = app.emit("mail-changed", ());
    Ok(undone)
}

/// Work Tern stopped retrying, for the person to retry or discard.
#[tauri::command]
pub async fn problems(state: State<'_, AppState>) -> Reply<Vec<OutboxProblem>> {
    state.store.outbox_problems().map_err(text)
}

#[tauri::command]
pub async fn retry_problem(app: AppHandle, state: State<'_, AppState>, id: i64) -> Reply<()> {
    let account =
        state.store.outbox_problems().map_err(text)?.into_iter().find(|p| p.id == id).map(|p| p.account_id);
    state.store.retry_outbox(id).map_err(text)?;
    if let Some(account) = account {
        state.wake(account);
    }
    let _ = app.emit("mail-changed", ());
    Ok(())
}

/// Drops the work and puts the mailbox back as it was before it, as undo would.
#[tauri::command]
pub async fn discard_problem(app: AppHandle, state: State<'_, AppState>, id: i64) -> Reply<()> {
    state.store.discard_outbox(id).map_err(text)?;
    let _ = app.emit("mail-changed", ());
    Ok(())
}

/// Queues the message; it leaves after the undo window. Returns the undo token.
#[tauri::command]
pub async fn send(
    state: State<'_, AppState>,
    account_id: i64,
    mut draft: Draft,
    delay: Option<i64>,
    draft_id: Option<i64>,
) -> Reply<Vec<i64>> {
    // The undo window for sending is a setting (0 to 20 s); other actions keep UNDO_SECONDS.
    let delay = delay.unwrap_or(UNDO_SECONDS).clamp(0, 60);
    // Sent from a saved draft: the message keeps the draft's Message-ID, and the draft leaves Drafts.
    if let Some(saved) = draft_id.map(|id| state.store.draft(id)).transpose().map_err(text)?.flatten() {
        draft.message_id = saved.draft.message_id;
    }
    let id = state.store.queue_send(account_id, draft, delay).map_err(text)?;
    if let Some(draft_id) = draft_id {
        state.store.draft_sent(draft_id).map_err(text)?;
    }
    state.wake(account_id);
    Ok(vec![id])
}

/// Saves what compose holds; returns the draft's id (new on the first save). `upload_now` when compose closes.
#[tauri::command]
pub async fn save_draft(
    state: State<'_, AppState>,
    id: Option<i64>,
    account_id: i64,
    draft: Draft,
    upload_now: bool,
) -> Reply<i64> {
    let id = state.store.save_draft(id, account_id, draft, upload_now).map_err(text)?;
    if upload_now {
        state.wake(account_id);
    }
    Ok(id)
}

#[tauri::command]
pub async fn draft_for_message(state: State<'_, AppState>, id: i64) -> Reply<Option<DraftRecord>> {
    state.store.draft_for_message(id).map_err(text)
}

#[tauri::command]
pub async fn draft(state: State<'_, AppState>, id: i64) -> Reply<Option<DraftRecord>> {
    state.store.draft(id).map_err(text)
}

#[tauri::command]
pub async fn discard_draft(state: State<'_, AppState>, id: i64) -> Reply<()> {
    state.store.discard_draft(id).map_err(text)
}

#[tauri::command]
pub async fn undo_discard(state: State<'_, AppState>, id: i64) -> Reply<bool> {
    state.store.undo_discard(id).map_err(text)
}

/// A refused send back as a draft, to fix and send again.
#[tauri::command]
pub async fn problem_to_draft(state: State<'_, AppState>, id: i64) -> Reply<DraftRecord> {
    state.store.problem_to_draft(id).map_err(text)
}

/// How a reply, reply-all or forward to this message starts.
#[tauri::command]
pub async fn reply_init(state: State<'_, AppState>, id: i64, kind: ReplyKind) -> Reply<ReplyInit> {
    state.store.reply_init(id, kind).map_err(text)
}

/// The person opened a folder: check it now rather than on its five-minute round.
#[tauri::command]
pub async fn check_folder(state: State<'_, AppState>, id: i64) -> Reply<()> {
    sync::want_folder(id);
    state.wake_all();
    Ok(())
}

/// Each account's sync state as last reported; "sync-state" events follow.
#[tauri::command]
pub async fn sync_states(state: State<'_, AppState>) -> Reply<HashMap<i64, SyncState>> {
    Ok(state.states.lock().unwrap().clone())
}

#[tauri::command]
pub async fn settings(state: State<'_, AppState>) -> Reply<HashMap<String, serde_json::Value>> {
    state.store.settings().map_err(text)
}

#[tauri::command]
pub async fn set_setting(state: State<'_, AppState>, key: String, value: serde_json::Value) -> Reply<()> {
    state.store.set_setting(&key, &value).map_err(text)
}

/// Mutes or unmutes the conversations of these messages (muting does not archive; the UI does that too).
#[tauri::command]
pub async fn mute(state: State<'_, AppState>, ids: Vec<i64>, mute: bool) -> Reply<()> {
    state.store.mute(&ids, mute).map_err(text)
}

#[tauri::command]
pub async fn muted(state: State<'_, AppState>, id: i64) -> Reply<bool> {
    state.store.muted(id).map_err(text)
}
