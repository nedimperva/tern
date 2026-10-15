//! What the UI can ask for. Reads answer from the store and never touch the network, except signing in to a new
//! account and the first open of a received attachment.

use tauri::{AppHandle, Emitter, Manager, State};
use tern_core::presets::{self, Preset};
use tern_core::{
    mime, secrets, sync, Account, AccountConfig, Action, Applied, Contact, Cursor, Draft, DraftRecord,
    Folder, ListTarget, MessageRow, OutboxProblem, OutboxWaiting, OutgoingAttachment, ReplyInit, ReplyKind,
    SearchResult, ThreadMessage, ThreadRow,
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
pub async fn search(state: State<'_, AppState>, query: String, limit: i64) -> Reply<SearchResult> {
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

/// Work still on its way to the server, for the "changes waiting" list.
#[tauri::command]
pub async fn waiting(state: State<'_, AppState>) -> Reply<Vec<OutboxWaiting>> {
    state.store.outbox_waiting().map_err(text)
}

/// Takes back waiting work, as undo would. False when it was being sent meanwhile, or later work depends on it.
#[tauri::command]
pub async fn discard_waiting(app: AppHandle, state: State<'_, AppState>, id: i64) -> Reply<bool> {
    let done = state.store.discard_waiting(id).map_err(text)?;
    let _ = app.emit("mail-changed", ());
    Ok(done)
}

/// The window saw the network come back: reconnect every account now instead of after its backoff.
#[tauri::command]
pub async fn network_back() -> Reply<()> {
    sync::network_back();
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

/// Copies files into Tern's own folder for attachments, so a draft keeps them whatever happens to the
/// originals (moved, deleted, on a drive that is gone). Each file gets a folder of its own, so names never clash.
#[tauri::command]
pub async fn add_attachments(app: AppHandle, paths: Vec<String>) -> Reply<Vec<OutgoingAttachment>> {
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let base = app.path().app_data_dir().map_err(|e| e.to_string())?.join("attachments");
    let mut added = Vec::new();
    for path in paths {
        let source = std::path::PathBuf::from(&path);
        let name = source.file_name().map(|n| n.to_string_lossy().into_owned()).ok_or("Not a file")?;
        let stamp =
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos();
        let folder = base.join(format!("{stamp}-{}", NEXT.fetch_add(1, Ordering::Relaxed)));
        std::fs::create_dir_all(&folder).map_err(|e| format!("{name}: {e}"))?;
        let copy = folder.join(&name);
        let size = std::fs::copy(&source, &copy).map_err(|e| format!("{name}: {e}"))?;
        added.push(OutgoingAttachment {
            path: copy.display().to_string(),
            mime: mime_for(&name).into(),
            name,
            size,
        });
    }
    Ok(added)
}

/// A file's type from its extension: the common ones, else a plain stream of bytes.
fn mime_for(name: &str) -> &'static str {
    let ext = name.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase()).unwrap_or_default();
    match ext.as_str() {
        "pdf" => "application/pdf",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "txt" | "md" | "log" => "text/plain",
        "csv" => "text/csv",
        "html" | "htm" => "text/html",
        "ics" => "text/calendar",
        "zip" => "application/zip",
        "json" => "application/json",
        "doc" => "application/msword",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xls" => "application/vnd.ms-excel",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "ppt" => "application/vnd.ms-powerpoint",
        "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "odt" => "application/vnd.oasis.opendocument.text",
        "ods" => "application/vnd.oasis.opendocument.spreadsheet",
        "mp3" => "audio/mpeg",
        "mp4" => "video/mp4",
        _ => "application/octet-stream",
    }
}

/// Recipients to suggest for what is typed in a To, Cc or Bcc field.
#[tauri::command]
pub async fn contacts(state: State<'_, AppState>, query: String) -> Reply<Vec<Contact>> {
    state.store.contacts(&query, 5).map_err(text)
}

/// The `index`-th attachment of a message as a file on disk. The first time, the message comes down from the server
/// on a connection of its own (the one read the UI waits on the network for: Tern keeps no attachment bytes in the
/// store); its attachments are then kept in the cache folder, so opening one again is instant and works offline.
async fn received_file(
    app: &AppHandle,
    state: &State<'_, AppState>,
    id: i64,
    index: usize,
) -> Reply<std::path::PathBuf> {
    let (account_id, at, listed) = state
        .store
        .attachment_source(id)
        .map_err(text)?
        .ok_or("This message is not on the server yet; try again once it has synced")?;
    let name = listed.get(index).ok_or("That attachment is not in this message")?;
    let base = app.path().app_cache_dir().map_err(|e| e.to_string())?.join("received").join(id.to_string());
    let place = |i: usize| base.join(i.to_string()).join(mime::safe_file_name(&listed[i]));
    if place(index).is_file() {
        return Ok(place(index));
    }
    let account = state
        .store
        .accounts()
        .map_err(text)?
        .into_iter()
        .find(|a| a.id == account_id)
        .ok_or("The account of this message is gone")?;
    let password = secrets::password(&account.config.email).map_err(text)?;
    let raw = sync::download(&account.config, &password, &at).await.map_err(text)?;
    let files = mime::attachment_files(&raw);
    for i in 0..listed.len() {
        let Some(found) = mime::pick_attachment(&files, &listed, i) else { continue };
        let path = place(i);
        let folder = path.parent().expect("a file in a folder");
        std::fs::create_dir_all(folder).map_err(|e| format!("{name}: {e}"))?;
        // Written whole, then renamed: a half-written file must never pass for the cached one.
        let partial = folder.join(".partial");
        std::fs::write(&partial, &files[found].2).map_err(|e| format!("{name}: {e}"))?;
        std::fs::rename(&partial, &path).map_err(|e| format!("{name}: {e}"))?;
    }
    if place(index).is_file() {
        Ok(place(index))
    } else {
        Err(format!("{name} was not found in the message on the server"))
    }
}

/// Most an inline-image cache holds for one message.
const INLINE_LIMIT: usize = 20_000_000;

/// The images a message's HTML shows from its own parts (`cid:`), as Content-ID → data: URI. Like an attachment,
/// the first look downloads the message on a connection of its own; the result is cached for later opens.
#[tauri::command]
pub async fn inline_images(
    app: AppHandle,
    state: State<'_, AppState>,
    id: i64,
) -> Reply<HashMap<String, String>> {
    let cache = app.path().app_cache_dir().map_err(|e| e.to_string())?.join("received").join(id.to_string());
    let file = cache.join("inline.json");
    if let Ok(saved) = std::fs::read(&file) {
        if let Ok(images) = serde_json::from_slice(&saved) {
            return Ok(images);
        }
    }
    let Some((account_id, at, _)) = state.store.attachment_source(id).map_err(text)? else {
        return Ok(HashMap::new());
    };
    let account = state
        .store
        .accounts()
        .map_err(text)?
        .into_iter()
        .find(|a| a.id == account_id)
        .ok_or("The account of this message is gone")?;
    let password = secrets::password(&account.config.email).map_err(text)?;
    let raw = sync::download(&account.config, &password, &at).await.map_err(text)?;
    let images: HashMap<String, String> = mime::inline_images(&raw, INLINE_LIMIT).into_iter().collect();
    // Cached whole or not at all, as attachments are.
    std::fs::create_dir_all(&cache).map_err(|e| e.to_string())?;
    let partial = cache.join(".inline.partial");
    std::fs::write(&partial, serde_json::to_vec(&images).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    std::fs::rename(&partial, &file).map_err(|e| e.to_string())?;
    Ok(images)
}

/// Opens an attachment in the program the system uses for its type. Programs and disk images are not opened
/// (the UI offers Save for them instead).
#[tauri::command]
pub async fn open_attachment(app: AppHandle, state: State<'_, AppState>, id: i64, index: usize) -> Reply<()> {
    use tauri_plugin_opener::OpenerExt;
    let path = received_file(&app, &state, id, index).await?;
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    if mime::runs_as_program(&name) {
        return Err(format!(
            "{name} could run as a program, so Tern does not open it. Save it if you trust it."
        ));
    }
    app.opener().open_path(path.display().to_string(), None::<&str>).map_err(|e| format!("{name}: {e}"))
}

/// Saves an attachment where the person chose in the save dialog.
#[tauri::command]
pub async fn save_attachment(
    app: AppHandle,
    state: State<'_, AppState>,
    id: i64,
    index: usize,
    path: String,
) -> Reply<()> {
    let file = received_file(&app, &state, id, index).await?;
    std::fs::copy(&file, &path).map_err(|e| format!("{path}: {e}"))?;
    Ok(())
}
