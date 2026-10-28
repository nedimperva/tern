//! What the UI can ask for. Reads answer from the store and never touch the network, except signing in to a new
//! account, the first open of a received attachment, (opt-in) a sender's logo, fetched in the background, and
//! (opt-in, on request) AI.

use tauri::{AppHandle, Emitter, Manager, State};
use tern_core::ai::{self, providers, Provider};
use tern_core::presets::{self, Preset};
use tern_core::{
    logo, mime, secrets, sync, Account, AccountConfig, Action, AiStyle, Applied, Auth, Contact, ContactCard,
    Cursor, Draft, DraftRecord, Folder, ListTarget, Mark, MessageRow, OutboxProblem, OutboxWaiting,
    OutgoingAttachment, ReplyInit, ReplyKind, SearchResult, ThreadMessage, ThreadRow,
};

use std::collections::{HashMap, HashSet};
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

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

/// The name on mail sent from the account; the sync worker picks it up on its next pass.
#[tauri::command]
pub async fn set_account_name(state: State<'_, AppState>, id: i64, name: String) -> Reply<()> {
    state.store.set_display_name(id, &name).map_err(text)
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
    sync::check_login(&config, &secrets::Credential::Password(password.clone())).await.map_err(text)?;
    secrets::set_password(&config.email, &password).map_err(text)?;
    let account = state.store.add_account(&config).map_err(text)?;
    start_account(&app, &state, account.clone());
    Ok(account)
}

/// A new password for an account, when the old one changed and the server refuses it. Checked against the server
/// before it replaces the one in the keychain; the worker reads the keychain at each connect, so waking it is
/// enough.
#[tauri::command]
pub async fn set_password(
    app: AppHandle,
    state: State<'_, AppState>,
    id: i64,
    password: String,
) -> Reply<()> {
    let account = state.store.account(id).map_err(text)?.ok_or("That account is gone")?;
    if account.config.auth == Auth::Google {
        return Err("This account signs in with Google; sign in again instead".into());
    }
    sync::check_login(&account.config, &secrets::Credential::Password(password.clone()))
        .await
        .map_err(text)?;
    secrets::set_password(&account.config.email, &password).map_err(text)?;
    if state.wakers.lock().unwrap().contains_key(&id) {
        state.wake(id);
    } else {
        // Started without a password (it was missing from the keychain): start now.
        start_account(&app, &state, account);
    }
    Ok(())
}

/// Removes an account from Tern: its mail, folders, drafts and queued changes here, its saved password or Google
/// sign-in, and its downloaded files. Nothing on the server changes.
#[tauri::command]
pub async fn remove_account(app: AppHandle, state: State<'_, AppState>, id: i64) -> Reply<()> {
    let account = state.store.account(id).map_err(text)?.ok_or("That account is gone")?;
    let store = state.store.clone();
    blocking(move || store.remove_account(id)).await?;
    // Its worker wakes, finds the account gone and stops.
    if let Some(waker) = state.wakers.lock().unwrap().remove(&id) {
        waker.notify_one();
    }
    state.states.lock().unwrap().remove(&id);
    let _ = secrets::delete_password(&account.config.email);
    let _ = secrets::delete_tokens(&account.config.email);
    crate::cache::forget_account(&app, id);
    let _ = app.emit("mail-changed", ());
    Ok(())
}

/// How much the downloaded attachments and inline images take on disk, in bytes.
#[tauri::command]
pub async fn received_cache_size(app: AppHandle) -> Reply<u64> {
    blocking(move || Ok(crate::cache::size(&app))).await
}

/// Deletes the downloaded attachments and inline images; they come down again when next opened.
#[tauri::command]
pub async fn clear_received_cache(app: AppHandle) -> Reply<()> {
    blocking(move || crate::cache::clear(&app).map_err(anyhow::Error::msg)).await
}

/// Whether this build can sign in with Google (it has a Google client; see build.rs).
#[tauri::command]
pub fn google_available() -> bool {
    crate::google().is_some()
}

/// Signs in with Google in the browser. A new address becomes a new account; an account already here (signed in
/// with Google before, or with an app password) switches to the new sign-in, and its app password is forgotten.
/// `hint` is the address expected, when signing an existing account in again.
#[tauri::command]
pub async fn google_sign_in(
    app: AppHandle,
    state: State<'_, AppState>,
    name: String,
    hint: Option<String>,
) -> Reply<Account> {
    use tauri_plugin_opener::OpenerExt;
    let google = crate::google().ok_or("This build of Tern has no Google sign-in")?;
    let open = |url: &str| app.opener().open_url(url, None::<&str>).map_err(anyhow::Error::from);
    let tokens = tern_core::oauth::sign_in(&google, hint.as_deref(), open, Duration::from_secs(5 * 60))
        .await
        .map_err(text)?;
    let email = tokens.email.clone().ok_or("Google did not say which account signed in")?;
    if let Some(hint) = hint.filter(|h| !h.eq_ignore_ascii_case(&email)) {
        return Err(format!("You signed in as {email}, not {hint}. Try again and pick {hint}."));
    }
    let existing = state
        .store
        .accounts()
        .map_err(text)?
        .into_iter()
        .find(|a| a.config.email.eq_ignore_ascii_case(&email));
    let preset = presets::for_email(&email).ok_or("Not an email address")?;
    let config = match &existing {
        Some(a) => AccountConfig { auth: Auth::Google, ..a.config.clone() },
        None => AccountConfig {
            email: email.clone(),
            display_name: name.trim().to_string(),
            username: email.clone(),
            imap_host: preset.imap_host,
            imap_port: preset.imap_port,
            imap_security: preset.imap_security,
            smtp_host: preset.smtp_host,
            smtp_port: preset.smtp_port,
            smtp_security: preset.smtp_security,
            auth: Auth::Google,
        },
    };
    let token = secrets::Credential::Token(tokens.access_token.clone());
    sync::check_login(&config, &token).await.map_err(|e| {
        if tern_core::imap::sign_in_refused(&e) {
            format!("Gmail refused the sign-in. Check that IMAP is on in Gmail's settings. ({e:#})")
        } else {
            text(e)
        }
    })?;
    secrets::set_tokens(&config.email, &tokens).map_err(text)?;
    match existing {
        Some(account) => {
            state.store.set_auth(account.id, Auth::Google).map_err(text)?;
            // Only Tern's copy: the app password itself stays valid until it is removed in the Google account.
            let _ = secrets::delete_password(&config.email);
            if state.wakers.lock().unwrap().contains_key(&account.id) {
                // The worker reads the keychain at each connect, so waking it is enough.
                state.wake(account.id);
            } else {
                start_account(&app, &state, account.clone());
            }
            Ok(Account { config, ..account })
        }
        None => {
            let account = state.store.add_account(&config).map_err(text)?;
            start_account(&app, &state, account.clone());
            Ok(account)
        }
    }
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
    let mut thread = state.store.thread(id).map_err(text)?;
    // HTML was cleaned when it was stored, by the ammonia of that day. Cleaned again on the way out, a fix in a
    // newer ammonia (or a tighter policy) covers mail stored before it too.
    for m in &mut thread {
        if let Some(html) = &m.body_html {
            m.body_html = Some(mime::sanitize_html(html));
        }
    }
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

/// Puts a Gmail label on these conversations, or takes it off (`label` is the label's folder id).
#[tauri::command]
pub async fn label_conversations(
    app: AppHandle,
    state: State<'_, AppState>,
    ids: Vec<i64>,
    label: i64,
    add: bool,
) -> Reply<Applied> {
    let applied = state.store.label(&ids, label, add, UNDO_SECONDS).map_err(text)?;
    for account in &applied.accounts {
        state.wake(*account);
    }
    let _ = app.emit("mail-changed", ());
    Ok(applied)
}

/// Every unread message in a list marked read, loaded or not; one undo brings them all back.
#[tauri::command]
pub async fn mark_all_read(app: AppHandle, state: State<'_, AppState>, target: ListTarget) -> Reply<Applied> {
    let ids = state.store.unread_ids(&target).map_err(text)?;
    apply(app, state, ids, Action::MarkRead).await
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
    // Done on a follow-up that came due dismisses it; its messages are in Sent, so nothing else moves.
    if action.moves() {
        state.store.dismiss_follow_ups(&ids).map_err(text)?;
    }
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
    app: AppHandle,
    account_id: i64,
    mut draft: Draft,
    delay: Option<i64>,
    draft_id: Option<i64>,
    at: Option<i64>,
    follow_up: Option<i64>,
) -> Reply<Vec<i64>> {
    own_attachments(&app, &draft)?;
    let state = app.state::<AppState>();
    // The undo window for sending is a setting (0 to 20 s, capped at 60 here); other actions keep UNDO_SECONDS.
    let delay = delay.unwrap_or(UNDO_SECONDS).clamp(0, 60);
    // Sent from a saved draft: the message keeps the draft's Message-ID, and the draft leaves Drafts.
    if let Some(saved) = draft_id.map(|id| state.store.draft(id)).transpose().map_err(text)?.flatten() {
        draft.message_id = saved.draft.message_id;
    }
    // Send later (`at`) goes at the picked time; only while Tern runs, which compose says.
    let id = state.store.queue_send_at(account_id, draft, delay, at, follow_up).map_err(text)?;
    if let Some(draft_id) = draft_id {
        state.store.draft_sent(draft_id).map_err(text)?;
    }
    state.wake(account_id);
    Ok(vec![id])
}

/// Saves what compose holds; returns the draft's id (new on the first save). `upload_now` when compose closes.
#[tauri::command]
pub async fn save_draft(
    app: AppHandle,
    state: State<'_, AppState>,
    id: Option<i64>,
    account_id: i64,
    draft: Draft,
    upload_now: bool,
) -> Reply<i64> {
    own_attachments(&app, &draft)?;
    let id = state.store.save_draft(id, account_id, draft, upload_now).map_err(text)?;
    if upload_now {
        state.wake(account_id);
    }
    Ok(id)
}

#[tauri::command]
pub async fn draft_for_message(state: State<'_, AppState>, id: i64) -> Reply<Option<DraftRecord>> {
    match state.store.draft_for_message(id).map_err(text)? {
        Some(record) => Ok(Some(record)),
        // A draft another app saved opens in compose as well.
        None => state.store.adopt_draft(id).map_err(text),
    }
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

/// How far each account's download has come, for the status strip and the search note.
#[tauri::command]
pub async fn sync_progress(state: State<'_, AppState>) -> Reply<Vec<tern_core::SyncProgress>> {
    state.store.sync_progress().map_err(text)
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

/// Files the person handed over, in the file picker or by dropping them on the window: the only paths
/// `add_attachments` takes. The window never names a file on disk by itself, so a script that got into it could
/// not attach (and send) any other file.
#[derive(Default)]
pub struct Offered(Mutex<HashSet<std::path::PathBuf>>);

impl Offered {
    pub fn offer(&self, paths: impl IntoIterator<Item = std::path::PathBuf>) {
        self.0.lock().unwrap().extend(paths);
    }
}

/// Files dropped on the window: offered, then told to the window, which attaches them while compose is open.
pub fn files_dropped(app: &AppHandle, paths: &[std::path::PathBuf], at: tauri::PhysicalPosition<f64>) {
    app.state::<Offered>().offer(paths.iter().cloned());
    let shown: Vec<String> = paths.iter().map(|p| p.display().to_string()).collect();
    // Where they were dropped, in the window's pixels: pictures dropped on compose's text go in it.
    let _ = app.emit("files-dropped", serde_json::json!({ "paths": shown, "x": at.x, "y": at.y }));
}

/// The system's file picker, for attaching. The paths picked are offered for `add_attachments`.
#[tauri::command]
pub async fn pick_files(app: AppHandle) -> Reply<Vec<String>> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = tokio::sync::oneshot::channel();
    let mut dialog = app.dialog().file().set_title("Attach files");
    if let Some(window) = app.get_webview_window("main") {
        dialog = dialog.set_parent(&window);
    }
    dialog.pick_files(move |picked| {
        let _ = tx.send(picked);
    });
    let picked = rx.await.ok().flatten().unwrap_or_default();
    let paths: Vec<std::path::PathBuf> = picked.into_iter().filter_map(|p| p.into_path().ok()).collect();
    app.state::<Offered>().offer(paths.iter().cloned());
    Ok(paths.iter().map(|p| p.display().to_string()).collect())
}

/// Tern's own folder for files being attached.
fn attachments_dir(app: &AppHandle) -> Reply<std::path::PathBuf> {
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join("attachments"))
}

/// Refuses a draft that names a file outside Tern's folder for attachments: every attachment is a copy made
/// there by `add_attachments`, so anything else did not come from the person.
fn own_attachments(app: &AppHandle, draft: &Draft) -> Reply<()> {
    if draft.attachments.is_empty() {
        return Ok(());
    }
    let base = attachments_dir(app)?.canonicalize().map_err(|e| e.to_string())?;
    for file in &draft.attachments {
        let inside = std::path::Path::new(&file.path).canonicalize().is_ok_and(|p| p.starts_with(&base));
        if !inside {
            return Err(format!("{} is not a file Tern attached; attach it again", file.name));
        }
    }
    Ok(())
}

/// Copies files into Tern's own folder for attachments, so a draft keeps them whatever happens to the
/// originals (moved, deleted, on a drive that is gone). Each file gets a folder of its own, so names never clash.
/// Only files the person picked or dropped (`Offered`), each once.
#[tauri::command]
pub async fn add_attachments(
    app: AppHandle,
    offered: State<'_, Offered>,
    paths: Vec<String>,
) -> Reply<Vec<OutgoingAttachment>> {
    let base = attachments_dir(&app)?;
    let mut added = Vec::new();
    for path in paths {
        let source = std::path::PathBuf::from(&path);
        if !offered.0.lock().unwrap().remove(&source) {
            return Err(format!("{path}: pick the file or drop it on the window to attach it"));
        }
        let name = source.file_name().map(|n| n.to_string_lossy().into_owned()).ok_or("Not a file")?;
        let copy = new_folder(&base).map_err(|e| format!("{name}: {e}"))?.join(&name);
        let size = std::fs::copy(&source, &copy).map_err(|e| format!("{name}: {e}"))?;
        added.push(OutgoingAttachment {
            path: copy.display().to_string(),
            mime: mime_for(&name).into(),
            name,
            size,
            cid: None,
        });
    }
    Ok(added)
}

/// A folder of its own under `base` for one file being attached, so names never clash.
fn new_folder(base: &std::path::Path) -> std::io::Result<std::path::PathBuf> {
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let stamp =
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos();
    let folder = base.join(format!("{stamp}-{}", NEXT.fetch_add(1, Ordering::Relaxed)));
    std::fs::create_dir_all(&folder)?;
    Ok(folder)
}

/// A picture pasted into compose's text, kept like an attached file. The window hands over the bytes (from the
/// clipboard), never a path, and only a picture of a size the preview can show.
#[tauri::command]
pub async fn add_image(app: AppHandle, request: tauri::ipc::Request<'_>) -> Reply<OutgoingAttachment> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else { return Err("No picture came".into()) };
    let mime = request.headers().get("x-mime").and_then(|v| v.to_str().ok()).unwrap_or("");
    let ext = match mime {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        _ => return Err("Only PNG, JPEG, GIF and WebP pictures go in the text".into()),
    };
    if bytes.len() as u64 > PREVIEW_LIMIT {
        return Err("That picture is too big to put in the text; attach it instead".into());
    }
    let name = format!("image.{ext}");
    let path = new_folder(&attachments_dir(&app)?).map_err(|e| e.to_string())?.join(&name);
    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    Ok(OutgoingAttachment {
        path: path.display().to_string(),
        name,
        mime: mime.into(),
        size: bytes.len() as u64,
        cid: None,
    })
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

/// The card for a person's name in a conversation: who they are and your latest conversations with them.
#[tauri::command]
pub async fn contact_card(state: State<'_, AppState>, email: String) -> Reply<ContactCard> {
    state.store.contact_card(&email, 5).map_err(text)
}

/// Where a received message's downloaded files are kept: per account, under a name only that message gets.
fn received_dir(app: &AppHandle, account_id: i64, at: &tern_core::ForwardOf) -> Reply<std::path::PathBuf> {
    Ok(crate::cache::received(app)?.join(format!("a{account_id}")).join(at.cache_key(account_id)))
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
    let base = received_dir(app, account_id, &at)?;
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
    let raw = sync::download(&account.config, &crate::login(&account), &at).await.map_err(text)?;
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

/// Most of a message's source "Show original" shows; past it a big attachment's base64 only makes the view slow.
const SOURCE_LIMIT: usize = 4_000_000;

/// A message's source as the server holds it, for "Show original": every header, then the body as it was sent. It
/// comes down on a connection of its own, like an attachment's first open, and is not kept.
#[tauri::command]
pub async fn message_source(state: State<'_, AppState>, id: i64) -> Reply<String> {
    let (account_id, at, _) = state
        .store
        .attachment_source(id)
        .map_err(text)?
        .ok_or("This message is not on the server yet; try again once it has synced")?;
    let account = state
        .store
        .accounts()
        .map_err(text)?
        .into_iter()
        .find(|a| a.id == account_id)
        .ok_or("The account of this message is gone")?;
    let raw = sync::download(&account.config, &crate::login(&account), &at).await.map_err(text)?;
    Ok(source_text(&raw))
}

fn source_text(raw: &[u8]) -> String {
    if raw.len() <= SOURCE_LIMIT {
        return String::from_utf8_lossy(raw).into_owned();
    }
    let mut shown = String::from_utf8_lossy(&raw[..SOURCE_LIMIT]).into_owned();
    shown.push_str(&format!("\n\n[{} more bytes not shown]\n", raw.len() - SOURCE_LIMIT));
    shown
}

/// Most a picture attachment may weigh to be shown on its card.
const PREVIEW_LIMIT: u64 = 8_000_000;

/// A picture attachment as a data: URI for its card, when it was already downloaded (opened or saved before). It
/// never downloads: expanding a message must not fetch every file it carries.
#[tauri::command]
pub async fn attachment_preview(
    app: AppHandle,
    state: State<'_, AppState>,
    id: i64,
    index: usize,
) -> Reply<Option<String>> {
    let Some((account_id, at, listed)) = state.store.attachment_source(id).map_err(text)? else {
        return Ok(None);
    };
    let Some(name) = listed.get(index) else { return Ok(None) };
    let mime = match name.rsplit('.').next().map(str::to_ascii_lowercase).as_deref() {
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        _ => return Ok(None),
    };
    let path = received_dir(&app, account_id, &at)?.join(index.to_string()).join(mime::safe_file_name(name));
    match std::fs::metadata(&path) {
        Ok(meta) if meta.is_file() && meta.len() <= PREVIEW_LIMIT => {
            let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
            Ok(Some(format!("data:{mime};base64,{}", mime::base64(&bytes))))
        }
        _ => Ok(None),
    }
}

/// A picture being attached (in compose) as a data: URI for its card. Only files Tern copied in to attach, so the
/// window can't read anything else on disk this way.
#[tauri::command]
pub async fn outgoing_preview(app: AppHandle, path: String) -> Reply<Option<String>> {
    let base = app.path().app_data_dir().map_err(|e| e.to_string())?.join("attachments");
    let file = std::path::PathBuf::from(&path);
    let (Ok(base), Ok(file)) = (base.canonicalize(), file.canonicalize()) else { return Ok(None) };
    if !file.starts_with(&base) {
        return Ok(None);
    }
    let mime = match file.extension().map(|e| e.to_string_lossy().to_ascii_lowercase()).as_deref() {
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        _ => return Ok(None),
    };
    match std::fs::metadata(&file) {
        Ok(meta) if meta.len() <= PREVIEW_LIMIT => {
            let bytes = std::fs::read(&file).map_err(|e| e.to_string())?;
            Ok(Some(format!("data:{mime};base64,{}", mime::base64(&bytes))))
        }
        _ => Ok(None),
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
    let Some((account_id, at, _)) = state.store.attachment_source(id).map_err(text)? else {
        return Ok(HashMap::new());
    };
    let cache = received_dir(&app, account_id, &at)?;
    let file = cache.join("inline.json");
    if let Ok(saved) = std::fs::read(&file) {
        if let Ok(images) = serde_json::from_slice(&saved) {
            return Ok(images);
        }
    }
    let account = state
        .store
        .accounts()
        .map_err(text)?
        .into_iter()
        .find(|a| a.id == account_id)
        .ok_or("The account of this message is gone")?;
    let raw = sync::download(&account.config, &crate::login(&account), &at).await.map_err(text)?;
    let images: HashMap<String, String> = mime::inline_images(&raw, INLINE_LIMIT).into_iter().collect();
    // Cached whole or not at all, as attachments are.
    std::fs::create_dir_all(&cache).map_err(|e| e.to_string())?;
    let partial = cache.join(".inline.partial");
    std::fs::write(&partial, serde_json::to_vec(&images).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    std::fs::rename(&partial, &file).map_err(|e| e.to_string())?;
    Ok(images)
}

/// Most the viewer shows inside Tern; bigger files open in the system's program.
const VIEW_LIMIT: u64 = 60_000_000;

/// An attachment's bytes for the viewer, downloaded the first time as for opening it. Sent raw, not as JSON.
#[tauri::command]
pub async fn attachment_bytes(
    app: AppHandle,
    state: State<'_, AppState>,
    id: i64,
    index: usize,
) -> Reply<tauri::ipc::Response> {
    let path = received_file(&app, &state, id, index).await?;
    let size = std::fs::metadata(&path).map_err(|e| e.to_string())?.len();
    if size > VIEW_LIMIT {
        return Err("This file is too big to show here; open it with the system instead".into());
    }
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    Ok(tauri::ipc::Response::new(bytes))
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

/// Saves an attachment where the person chooses in the save dialog, which opens from here so the window never
/// names a place to write. False when the dialog was cancelled.
#[tauri::command]
pub async fn save_attachment(
    app: AppHandle,
    state: State<'_, AppState>,
    id: i64,
    index: usize,
) -> Reply<bool> {
    use tauri_plugin_dialog::DialogExt;
    let (_, _, listed) =
        state.store.attachment_source(id).map_err(text)?.ok_or("This message is not on the server yet")?;
    let name = listed.get(index).ok_or("That attachment is not in this message")?;
    let (tx, rx) = tokio::sync::oneshot::channel();
    let mut dialog =
        app.dialog().file().set_title("Save attachment").set_file_name(mime::safe_file_name(name));
    if let Some(window) = app.get_webview_window("main") {
        dialog = dialog.set_parent(&window);
    }
    dialog.save_file(move |chosen| {
        let _ = tx.send(chosen);
    });
    let Some(path) = rx.await.ok().flatten().and_then(|p| p.into_path().ok()) else { return Ok(false) };
    let file = received_file(&app, &state, id, index).await?;
    std::fs::copy(&file, &path).map_err(|e| format!("{}: {e}", path.display()))?;
    Ok(true)
}

/// Most a settings file may hold: settings, snippets and signatures are text, far below this.
const BACKUP_LIMIT: u64 = 5_000_000;

/// Saves the window's export of settings, snippets and signatures where the person picks. False if they cancelled.
#[tauri::command]
pub async fn export_settings(app: AppHandle, contents: String) -> Reply<bool> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = tokio::sync::oneshot::channel();
    let mut dialog = app
        .dialog()
        .file()
        .set_title("Export Tern settings")
        .set_file_name("tern-settings.json")
        .add_filter("Tern settings", &["json"]);
    if let Some(window) = app.get_webview_window("main") {
        dialog = dialog.set_parent(&window);
    }
    dialog.save_file(move |chosen| {
        let _ = tx.send(chosen);
    });
    let Some(path) = rx.await.ok().flatten().and_then(|p| p.into_path().ok()) else { return Ok(false) };
    std::fs::write(&path, contents).map_err(|e| format!("{}: {e}", path.display()))?;
    Ok(true)
}

/// A settings file the person picks, as text for the window to read; None if they cancelled.
#[tauri::command]
pub async fn import_settings(app: AppHandle) -> Reply<Option<String>> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = tokio::sync::oneshot::channel();
    let mut dialog =
        app.dialog().file().set_title("Import Tern settings").add_filter("Tern settings", &["json"]);
    if let Some(window) = app.get_webview_window("main") {
        dialog = dialog.set_parent(&window);
    }
    dialog.pick_file(move |chosen| {
        let _ = tx.send(chosen);
    });
    let Some(path) = rx.await.ok().flatten().and_then(|p| p.into_path().ok()) else { return Ok(None) };
    let size = std::fs::metadata(&path).map_err(|e| e.to_string())?.len();
    if size > BACKUP_LIMIT {
        return Err("That file is too big to be Tern settings".into());
    }
    std::fs::read_to_string(&path).map(Some).map_err(|e| format!("{}: {e}", path.display()))
}

/// The `mailto:` link Tern was started with, once; the window asks when it is ready.
#[tauri::command]
pub fn take_mailto(app: AppHandle) -> Option<tern_core::mailto::Mailto> {
    crate::desktop::take_pending(&app)
}

/// Quits for good (the window has saved what was being written). Closing the window only hides it.
#[tauri::command]
pub fn quit(app: AppHandle) {
    app.exit(0);
}

/// A scheduled send goes now, also one held because its time passed while Tern was closed.
#[tauri::command]
pub async fn send_now(state: State<'_, AppState>, id: i64) -> Reply<()> {
    if let Some(account) = state.store.send_now(id).map_err(text)? {
        state.wake(account);
    }
    Ok(())
}

/// The version, the log file and the details a bug report needs (no addresses).
#[tauri::command]
pub fn about(app: AppHandle) -> Reply<crate::diagnostics::About> {
    crate::diagnostics::about(&app).map_err(text)
}

/// Opens the folder that holds the log file.
#[tauri::command]
pub fn open_logs(app: AppHandle) -> Reply<()> {
    use tauri_plugin_opener::OpenerExt;
    let dir = crate::diagnostics::log_dir(&app);
    app.opener().open_path(dir.display().to_string(), None::<&str>).map_err(|e| e.to_string())
}

/// Pauses or resumes sync for every account; the "sync-state" events say when each one has.
#[tauri::command]
pub fn set_sync_paused(app: AppHandle, on: bool) {
    crate::desktop::set_paused(&app, on);
}

/// The version of Tern downloaded and waiting for a restart, if any.
#[tauri::command]
pub fn update_ready(app: AppHandle) -> Option<String> {
    crate::update::ready(&app)
}

/// Installs the waiting update and restarts (the window has saved what was being written).
#[tauri::command]
pub fn restart_to_update(app: AppHandle) -> Reply<()> {
    crate::update::install(&app).map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub fn autostart(app: AppHandle) -> Reply<bool> {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch().is_enabled().map_err(|e| e.to_string())
}

/// Starts Tern at login, in the tray, or stops doing so.
#[tauri::command]
pub fn set_autostart(app: AppHandle, on: bool) -> Reply<()> {
    use tauri_plugin_autostart::ManagerExt;
    let launcher = app.autolaunch();
    if on { launcher.enable() } else { launcher.disable() }.map_err(|e| e.to_string())
}

#[tauri::command]
pub fn default_mail_app(app: AppHandle) -> bool {
    use tauri_plugin_deep_link::DeepLinkExt;
    app.deep_link().is_registered("mailto").unwrap_or(false)
}

/// Makes Tern open `mailto:` links. Only when asked: it takes over from whatever mail app did that before. Windows
/// keeps the final say in its own settings, which this opens there.
#[tauri::command]
pub fn make_default_mail_app(app: AppHandle) -> Reply<()> {
    use tauri_plugin_deep_link::DeepLinkExt;
    app.deep_link().register("mailto").map_err(|e| e.to_string())?;
    #[cfg(windows)]
    {
        use tauri_plugin_opener::OpenerExt;
        let _ = app.opener().open_url("ms-settings:defaultapps", None::<&str>);
    }
    Ok(())
}

/// Moves the senders of these messages to the inbox's Other split (or back to Important).
#[tauri::command]
pub async fn set_split(app: AppHandle, state: State<'_, AppState>, ids: Vec<i64>, other: bool) -> Reply<()> {
    state.store.set_split(&ids, other).map_err(text)?;
    let _ = app.emit("mail-changed", ());
    Ok(())
}

/// Unread messages in the Important and Other splits.
#[tauri::command]
pub async fn split_unread(state: State<'_, AppState>) -> Reply<(i64, i64)> {
    state.store.split_unread().map_err(text)
}

/// Snoozes these conversations until `due` (Unix seconds). Tern brings them back while it runs.
#[tauri::command]
pub async fn snooze(app: AppHandle, state: State<'_, AppState>, ids: Vec<i64>, due: i64) -> Reply<()> {
    state.store.snooze(&ids, due, crate::desktop::now()).map_err(text)?;
    let _ = app.emit("mail-changed", ());
    Ok(())
}

#[tauri::command]
pub async fn unsnooze(app: AppHandle, state: State<'_, AppState>, ids: Vec<i64>) -> Reply<()> {
    state.store.unsnooze(&ids).map_err(text)?;
    let _ = app.emit("mail-changed", ());
    Ok(())
}

/// What a typed snooze time means, in Unix seconds; `offset` is the local time's minutes east of UTC.
#[tauri::command]
pub fn parse_when(text: String, offset: i64) -> Option<i64> {
    tern_core::triage::when(&text, crate::desktop::now(), offset)
}

/// Saved snippets, the most used first.
#[tauri::command]
pub async fn snippets(state: State<'_, AppState>) -> Reply<Vec<tern_core::Snippet>> {
    state.store.snippets().map_err(text)
}

/// Adds or changes a snippet; its id comes back.
#[tauri::command]
pub async fn save_snippet(state: State<'_, AppState>, snippet: tern_core::Snippet) -> Reply<i64> {
    state.store.save_snippet(&snippet).map_err(text)
}

#[tauri::command]
pub async fn delete_snippet(state: State<'_, AppState>, id: i64) -> Reply<()> {
    state.store.delete_snippet(id).map_err(text)
}

#[tauri::command]
pub async fn snippet_used(state: State<'_, AppState>, id: i64) -> Reply<()> {
    state.store.snippet_used(id).map_err(text)
}

/// Every account's signatures.
#[tauri::command]
pub async fn signatures(state: State<'_, AppState>) -> Reply<Vec<tern_core::Signature>> {
    state.store.signatures().map_err(text)
}

/// Adds or changes a signature; its id comes back.
#[tauri::command]
pub async fn save_signature(state: State<'_, AppState>, signature: tern_core::Signature) -> Reply<i64> {
    state.store.save_signature(&signature).map_err(text)
}

/// The account's signature for new mail, or with `reply` for replies and forwards; none with no id.
#[tauri::command]
pub async fn set_signature_default(
    state: State<'_, AppState>,
    account_id: i64,
    reply: bool,
    id: Option<i64>,
) -> Reply<()> {
    state.store.set_signature_default(account_id, reply, id).map_err(text)
}

#[tauri::command]
pub async fn delete_signature(state: State<'_, AppState>, id: i64) -> Reply<()> {
    state.store.delete_signature(id).map_err(text)
}

/// How long a site's logo, or its having none, is kept before the site is asked again.
const LOGO_TTL: Duration = Duration::from_secs(30 * 24 * 3600);
/// Sites being fetched, so a conversation full of one sender asks once.
static FETCHING: LazyLock<Mutex<HashSet<String>>> = LazyLock::new(Default::default);

/// A sender's logo as a data: URI, from the cache, by their address. The first ask for a site fetches it in the background and emits
/// "logo" with the site once it is in; until then, and when the site has none, None. The UI asks only when the
/// person turned logos on (Settings → Reading).
#[tauri::command]
pub async fn sender_logo(app: AppHandle, addr: String) -> Reply<Option<String>> {
    // A bare domain (or nothing, for shared providers): also a safe file name.
    let Some(site) = logo::site(&addr) else { return Ok(None) };
    let dir = app.path().app_cache_dir().map_err(|e| e.to_string())?.join("logos");
    let file = dir.join(&site);
    if let Ok(meta) = std::fs::metadata(&file) {
        if meta.modified().ok().and_then(|t| t.elapsed().ok()).is_some_and(|age| age < LOGO_TTL) {
            let uri = std::fs::read_to_string(&file).unwrap_or_default();
            return Ok((!uri.is_empty()).then_some(uri));
        }
    }
    if FETCHING.lock().unwrap().insert(site.clone()) {
        tauri::async_runtime::spawn_blocking(move || {
            // A site that did not answer caches nothing, so the next look tries again.
            match logo::fetch(&site) {
                Ok(found) => {
                    let uri = found
                        .map(|l| format!("data:{};base64,{}", l.mime, mime::base64(&l.bytes)))
                        .unwrap_or_default();
                    if std::fs::create_dir_all(&dir).and_then(|_| std::fs::write(&file, uri)).is_ok() {
                        let _ = app.emit("logo", &site);
                    }
                }
                Err(e) => log::debug!("No logo for {site}: {e:#}"),
            }
            FETCHING.lock().unwrap().remove(&site);
        });
    }
    Ok(None)
}

/// The start of the day: what came in since `since` (Unix seconds, when the person was last here) and what needs
/// them. Read from the store only.
#[tauri::command]
pub async fn day_start(state: State<'_, AppState>, since: i64) -> Reply<tern_core::DayStart> {
    state.store.day_start(since).map_err(text)
}

// MARK: AI (package 10)

// Every AI command but the key's own runs only on the person's ask, and the engine checks first that AI is on and
// allowed for the feature and the account (tern_core::ai::allowed): with AI off nothing is sent anywhere.

/// Runs blocking AI work (the keyring, a streamed HTTP answer) off the async runtime.
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> anyhow::Result<T> + Send + 'static) -> Reply<T> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?.map_err(text)
}

/// Whether a key is saved for the provider.
#[tauri::command]
pub async fn ai_has_key(provider: Provider) -> Reply<bool> {
    blocking(move || Ok(providers::has_key(provider))).await
}

#[tauri::command]
pub async fn ai_set_key(provider: Provider, key: String) -> Reply<()> {
    blocking(move || providers::set_key(provider, &key)).await
}

#[tauri::command]
pub async fn ai_forget_key(provider: Provider) -> Reply<()> {
    blocking(move || providers::delete_key(provider)).await
}

/// The models to pick from: Anthropic's own list, or what the OpenAI or Google key (typed, else saved) can use.
#[tauri::command]
pub async fn ai_models(provider: Provider, key: Option<String>) -> Reply<Vec<(String, String)>> {
    blocking(move || providers::models(provider, key.as_deref())).await
}

/// Whether the key (the one typed, else the saved one) works and may use the model; the model's name if so.
#[tauri::command]
pub async fn ai_test(provider: Provider, key: Option<String>, model: String) -> Reply<String> {
    blocking(move || providers::test(provider, key.as_deref(), &model)).await
}

/// The summary kept for the conversation as it is now, if any. Sends nothing.
#[tauri::command]
pub async fn ai_cached_summary(state: State<'_, AppState>, id: i64) -> Reply<Option<ai::Summary>> {
    ai::cached_summary(&state.store, id).map_err(text)
}

/// Summarizes the conversation of message `id`; the words stream through `on_text` as they come.
#[tauri::command]
pub async fn ai_summarize(
    state: State<'_, AppState>,
    id: i64,
    fresh: bool,
    on_text: tauri::ipc::Channel<String>,
) -> Reply<ai::Summary> {
    let store = state.store.clone();
    blocking(move || {
        ai::summarize(&store, &providers::Router, id, fresh, &mut |t| drop(on_text.send(t.to_string())))
    })
    .await
}

/// Three replies the person could send to the conversation of message `id`.
#[tauri::command]
pub async fn ai_replies(
    state: State<'_, AppState>,
    id: i64,
    fresh: bool,
    on_text: tauri::ipc::Channel<String>,
) -> Reply<Vec<ai::Suggestion>> {
    let store = state.store.clone();
    blocking(move || {
        ai::replies(&store, &providers::Router, id, fresh, &mut |t| drop(on_text.send(t.to_string())))
    })
    .await
}

/// What Write with AI wrote, for compose to show; compose decides whether it goes in.
#[tauri::command]
pub async fn ai_write(
    state: State<'_, AppState>,
    input: ai::WriteInput,
    on_text: tauri::ipc::Channel<String>,
) -> Reply<ai::Written> {
    let store = state.store.clone();
    blocking(move || {
        ai::write(&store, &providers::Router, &input, &mut |t| drop(on_text.send(t.to_string())))
    })
    .await
}

/// What Settings → AI shows of use: tokens spent today (UTC) and the answers kept, by kind.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiStats {
    tokens_today: i64,
    kept: HashMap<String, i64>,
}

#[tauri::command]
pub async fn ai_stats(state: State<'_, AppState>) -> Reply<AiStats> {
    let today = tern_core::store::now().div_euclid(86_400);
    Ok(AiStats {
        tokens_today: state.store.ai_tokens(today).map_err(text)?,
        kept: state.store.ai_kept().map_err(text)?,
    })
}

#[tauri::command]
pub async fn ai_clear_cache(state: State<'_, AppState>) -> Reply<usize> {
    state.store.ai_clear_cache().map_err(text)
}

#[tauri::command]
pub async fn ai_style(state: State<'_, AppState>, account_id: i64) -> Reply<Option<AiStyle>> {
    state.store.ai_style(account_id).map_err(text)
}

/// Learns the account's style note from its sent mail. Only on the person's ask (Settings → AI).
#[tauri::command]
pub async fn ai_learn_style(state: State<'_, AppState>, account_id: i64) -> Reply<ai::Learned> {
    let store = state.store.clone();
    blocking(move || ai::learn_style(&store, &providers::Router, account_id)).await
}

/// The person's own edit of the note. Saving nothing removes it.
#[tauri::command]
pub async fn ai_set_style(state: State<'_, AppState>, account_id: i64, note: String) -> Reply<()> {
    if note.trim().is_empty() {
        return state.store.delete_ai_style(account_id).map_err(text);
    }
    let samples = state.store.ai_style(account_id).map_err(text)?.map(|s| s.samples).unwrap_or(0);
    state.store.set_ai_style(account_id, note.trim(), samples).map_err(text)
}

/// Puts conversations on the Read later shelf, or takes them off it.
#[tauri::command]
pub async fn read_later(app: AppHandle, state: State<'_, AppState>, ids: Vec<i64>, on: bool) -> Reply<()> {
    state.store.read_later(&ids, on, crate::desktop::now()).map_err(text)?;
    let _ = app.emit("mail-changed", ());
    Ok(())
}

// MARK: Marks (reading)

/// The marks on a conversation's messages.
#[tauri::command]
pub async fn marks(state: State<'_, AppState>, message_ids: Vec<i64>) -> Reply<Vec<Mark>> {
    state.store.marks(&message_ids).map_err(text)
}

#[tauri::command]
pub async fn add_mark(
    state: State<'_, AppState>,
    message_id: i64,
    text: String,
    note: String,
) -> Reply<Mark> {
    state.store.add_mark(message_id, text.trim(), note.trim()).map_err(self::text)
}

#[tauri::command]
pub async fn set_mark_note(state: State<'_, AppState>, id: i64, note: String) -> Reply<()> {
    state.store.set_mark_note(id, note.trim()).map_err(text)
}

#[tauri::command]
pub async fn delete_mark(state: State<'_, AppState>, id: i64) -> Reply<()> {
    state.store.delete_mark(id).map_err(text)
}
