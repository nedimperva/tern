//! Keeps one account's folders in the store in step with its IMAP server, and sends the outbox.
//!
//! Each pass: send what the person did (outbox), then per folder drop what the server no longer has, take its flags,
//! and fetch what is new, newest first, a few hundred at a time so the inbox fills before the backlog.

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use tokio::sync::Notify;

use crate::imap::{self, Idled, Imap, TlsImap};
use crate::models::{Account, AccountConfig, Failure, FolderState, NewMessage, OutboxOp};
use crate::store::{now, Store};
use crate::{mime, smtp};

pub type Session = TlsImap;

/// What an IMAP session can run over: TLS in the app, a scripted stream in tests.
pub trait Stream: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send {}
impl<T: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send> Stream for T {}

/// How often every folder is checked. The inbox does not wait for this when the server has IDLE: `watch_inbox`
/// wakes the worker the moment something changes there.
const POLL: Duration = Duration::from_secs(60);
/// How long one IDLE lasts before it is ended and started again. Servers may drop a connection that has been idle
/// for 30 minutes (RFC 2177), and middleboxes sooner.
const IDLE_REFRESH: Duration = Duration::from_secs(25 * 60);
/// How long one pass spends fetching mail that is already on the server before new mail and the outbox get
/// another look.
const BACKFILL_BUDGET: Duration = Duration::from_secs(15);
/// How often folders other than the inbox are checked. The inbox is checked every pass (and IDLE wakes it); a
/// folder someone opens is checked at once (`want_folder`).
const FOLDER_INTERVAL: Duration = Duration::from_secs(5 * 60);
/// Flags read per FETCH on a server that cannot say which changed.
const FLAG_BATCH: usize = 5_000;
/// Most messages per FETCH.
const FETCH_CHUNK: usize = 50;
/// Most bytes per FETCH, so one batch of big attachments doesn't become a single long wait.
const FETCH_BYTES: u64 = 4_000_000;
/// The slowest download we still wait for when fetching mail bodies.
const MIN_BYTES_PER_SECOND: u64 = 100_000;
/// New messages per folder per pass; the rest come on later passes, newest first. Headers only, so this is cheap.
const PER_PASS: usize = 2_000;
/// Messages per header FETCH.
const HEADER_CHUNK: usize = 500;
/// Bodies are fetched ahead of time for mail this recent; older mail gets its body when it is opened.
const BODY_DAYS: i64 = 90;
/// Snippets read per round, and bytes read from each text part for one.
const SNIPPET_ROUND: i64 = 200;
const SNIPPET_BYTES: u32 = 2_048;
/// Rows looked at per round of body fetching.
const BODY_ROUND: i64 = 200;
/// Longest one IMAP command may take. Without a limit, a reply the parser never finishes leaves the worker waiting
/// forever, and with it new mail and the outbox.
const COMMAND_TIMEOUT: Duration = Duration::from_secs(60);

pub async fn connect(config: &AccountConfig, password: &str) -> Result<Session> {
    imap::connect(&config.imap_host, config.imap_port, config.imap_security, &config.username, password).await
}

/// Signs in and out, to check settings before an account is saved.
pub async fn check_login(config: &AccountConfig, password: &str) -> Result<()> {
    let session = connect(config, password).await?;
    session.logout().await?;
    Ok(())
}

/// Folders someone opened since they were last checked; the next pass checks them whatever their schedule.
static WANTED: std::sync::Mutex<Vec<i64>> = std::sync::Mutex::new(Vec::new());

/// Asks for `folder_id` to be checked on the next pass (the person opened it). Wake the account's worker after.
pub fn want_folder(folder_id: i64) {
    let mut wanted = WANTED.lock().unwrap_or_else(|e| e.into_inner());
    if !wanted.contains(&folder_id) {
        wanted.push(folder_id);
    }
}

/// Which folders a pass checks: the inbox always; others every FOLDER_INTERVAL, when someone opened them, or while
/// their backfill is unfinished.
#[derive(Default)]
pub struct Schedule {
    checked: HashMap<i64, Instant>,
    unfinished: HashSet<i64>,
}

impl Schedule {
    fn due(&self, folder_id: i64, name: &str) -> bool {
        let wanted = WANTED.lock().unwrap_or_else(|e| e.into_inner()).contains(&folder_id);
        name.eq_ignore_ascii_case("INBOX")
            || wanted
            || self.unfinished.contains(&folder_id)
            || self.checked.get(&folder_id).is_none_or(|t| t.elapsed() >= FOLDER_INTERVAL)
    }

    fn done(&mut self, folder_id: i64, unfinished: bool) {
        WANTED.lock().unwrap_or_else(|e| e.into_inner()).retain(|f| *f != folder_id);
        self.checked.insert(folder_id, Instant::now());
        if unfinished {
            self.unfinished.insert(folder_id);
        } else {
            self.unfinished.remove(&folder_id);
        }
    }
}

/// Where an account's sync stands, for the UI.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SyncState {
    /// Opening a connection (first start, or after one was lost).
    Connecting,
    /// Connected and working through a pass.
    Syncing,
    /// Connected and up to date; waiting for IDLE, the next poll, or queued work.
    Idle,
    /// The server cannot be reached; trying again with backoff.
    Offline,
    /// The server refused the password. Not retried until the app starts again or is woken (window focus), so a
    /// wrong password does not lock the account.
    AuthFailed,
}

/// How long a refused sign-in waits before the next try, unless woken sooner.
const AUTH_RETRY: Duration = Duration::from_secs(30 * 60);
/// How often the wall clock is compared with the time that passed, to notice the computer slept.
const CLOCK_TICK: Duration = Duration::from_secs(10);
/// More time than this unaccounted for between ticks means the computer was asleep: connections are likely dead
/// without knowing it, so they are dropped and opened again.
const SLEPT: Duration = Duration::from_secs(30);

/// Runs for as long as the app does. `wake` cuts a wait short (new work in the outbox, the window got focus);
/// `on_change` is called whenever the store changed, `on_state` whenever the account's `SyncState` changes.
pub async fn run_account(
    store: Arc<Store>,
    account: Account,
    password: String,
    wake: Arc<Notify>,
    on_change: Arc<dyn Fn() + Send + Sync>,
    on_state: Arc<dyn Fn(SyncState) + Send + Sync>,
) {
    let mut resumed = watch_clock();
    tokio::spawn(watch_inbox(account.clone(), password.clone(), wake.clone(), resumed.clone()));
    let mut session: Option<Session> = None;
    let mut schedule = Schedule::default();
    let mut failures: u32 = 0;
    let mut last: Option<SyncState> = None;
    let mut report = |state: SyncState| {
        if last != Some(state) {
            last = Some(state);
            log::debug!("{}: {state:?}", account.config.email);
            on_state(state);
        }
    };
    loop {
        if resumed.has_changed().unwrap_or(false) {
            resumed.mark_unchanged();
            log::info!("{}: the computer woke from sleep; reconnecting", account.config.email);
            session = None;
            failures = 0;
        }
        let mut connected = session.is_some();
        // While offline or refused, a retry says nothing until it gets through, so the label does not flicker.
        let quiet = failures > 0;
        let result = async {
            if session.is_none() {
                if !quiet {
                    report(SyncState::Connecting);
                }
                session = Some(open(&store, &account, &password, &*on_change).await?);
                connected = true;
            }
            report(SyncState::Syncing);
            pass(&store, &account, &password, &mut session, &mut schedule, &*on_change).await
        }
        .await;
        let wait = match result {
            Ok(more) => {
                failures = 0;
                report(SyncState::Idle);
                match store.next_due(account.id) {
                    _ if more => Duration::ZERO,
                    Ok(Some(due)) => Duration::from_secs((due - now()).max(0) as u64).min(POLL),
                    _ => POLL,
                }
            }
            Err(e) => {
                log::warn!("{}: {e:#}", account.config.email);
                session = None;
                failures += 1;
                if imap::sign_in_refused(&e) {
                    report(SyncState::AuthFailed);
                    AUTH_RETRY
                } else {
                    // A server that answered and then refused one command is not offline; the pass is tried
                    // again on a fresh connection all the same.
                    let reachable = connected && !connection_broke(&e);
                    report(if reachable { SyncState::Idle } else { SyncState::Offline });
                    backoff(failures)
                }
            }
        };
        tokio::select! {
            _ = wake.notified() => {}
            _ = tokio::time::sleep(wait) => {}
            _ = resumed.changed() => {}
        }
    }
}

/// Counts the times the computer woke from sleep, noticed as wall-clock time that passed while the process did
/// not run. Works the same everywhere, without listening to each system's power events.
fn watch_clock() -> tokio::sync::watch::Receiver<u64> {
    let (tx, rx) = tokio::sync::watch::channel(0);
    tokio::spawn(async move {
        let mut before = std::time::SystemTime::now();
        while !tx.is_closed() {
            tokio::time::sleep(CLOCK_TICK).await;
            let after = std::time::SystemTime::now();
            if after.duration_since(before).unwrap_or_default() > CLOCK_TICK + SLEPT {
                tx.send_modify(|n| *n += 1);
            }
            before = after;
        }
    });
    rx
}

/// Keeps a second connection in IDLE on the inbox and wakes the sync worker as soon as the server reports a change
/// there. It only ever selects the inbox and idles, so it never competes with the worker's commands. Without IDLE
/// on the server it stops, and the worker's poll is what finds new mail.
async fn watch_inbox(
    account: Account,
    password: String,
    wake: Arc<Notify>,
    mut resumed: tokio::sync::watch::Receiver<u64>,
) {
    let email = &account.config.email;
    let mut failures: u32 = 0;
    loop {
        let mut s = match within(connect(&account.config, &password)).await {
            Ok(s) => s,
            Err(e) => {
                failures += 1;
                log::warn!("{email}: inbox watch could not connect: {e:#}");
                let wait = if imap::sign_in_refused(&e) { AUTH_RETRY } else { backoff(failures) };
                tokio::select! {
                    _ = tokio::time::sleep(wait) => {}
                    _ = resumed.changed() => {}
                }
                continue;
            }
        };
        failures = 0;
        if !s.has("IDLE") {
            log::info!(
                "{email}: the server has no IDLE; new mail is found by polling every {}s",
                POLL.as_secs()
            );
            let _ = s.logout().await;
            return;
        }
        tokio::select! {
            stopped = keep_idling(&mut s, &wake) => {
                if let Err(e) = stopped {
                    log::warn!("{email}: inbox watch stopped: {e:#}");
                    tokio::time::sleep(backoff(1)).await;
                }
            }
            // After sleep the connection is most likely dead without either side knowing; start a new one.
            _ = resumed.changed() => {}
        }
    }
}

async fn keep_idling(s: &mut Session, wake: &Notify) -> Result<()> {
    within(s.select("INBOX")).await?;
    loop {
        // idle() keeps its own deadline; the outer limit only catches a server that never answers DONE.
        if within_for(IDLE_REFRESH + COMMAND_TIMEOUT, s.idle(IDLE_REFRESH)).await? == Idled::Changed {
            wake.notify_one();
        }
    }
}

/// Wait before trying again after `failures` failures in a row: about 1 s, 2 s, 4 s, … up to a minute, each
/// between half and all of that at random so many clients do not come back in step after an outage.
fn backoff(failures: u32) -> Duration {
    let cap = Duration::from_secs(1u64 << failures.saturating_sub(1).min(6)).min(Duration::from_secs(60));
    cap / 2 + cap.mul_f64(fastrand::f64() / 2.0)
}

/// Whether queued work is due, so a long pass stops to send it rather than finishing the backfill first.
fn outbox_due(store: &Store, account_id: i64) -> Result<bool> {
    Ok(store.next_due(account_id)?.is_some_and(|due| due <= now()))
}

async fn pass(
    store: &Store,
    account: &Account,
    password: &str,
    session: &mut Option<Session>,
    schedule: &mut Schedule,
    on_change: &(dyn Fn() + Send + Sync),
) -> Result<bool> {
    if session.is_none() {
        *session = Some(open(store, account, password, on_change).await?);
    }
    let s = session.as_mut().expect("connected above");

    if drain_outbox(s, store, account, password).await? {
        on_change();
    }
    // Messages someone opened before their body came: those first, whatever folder they are in.
    for (folder_id, name) in store.folders_with_wanted_bodies(account.id)? {
        within(s.select(&name)).await.with_context(|| format!("Could not open {name}"))?;
        let opened_only = i64::MAX;
        fetch_bodies(
            s,
            store,
            account.id,
            (folder_id, &name),
            opened_only,
            Instant::now() + BACKFILL_BUDGET,
            on_change,
        )
        .await?;
    }
    // Every folder gets its new mail looked for, but old mail only comes down until the deadline; the next pass
    // starts at once and carries on, after the outbox and inbox have had their turn.
    let deadline = Instant::now() + BACKFILL_BUDGET;
    let mut more = false;
    for (folder_id, name) in store.folders_to_sync(account.id)? {
        if !schedule.due(folder_id, &name) {
            continue;
        }
        if outbox_due(store, account.id)? && drain_outbox(s, store, account, password).await? {
            on_change();
        }
        let (changed, unfinished) =
            sync_folder(s, store, account.id, folder_id, &name, deadline, on_change).await?;
        schedule.done(folder_id, unfinished);
        if changed {
            on_change();
        }
        more |= unfinished;
    }
    Ok(more)
}

/// Signs in, turns on QRESYNC, and brings the folder list up to date.
async fn open(
    store: &Store,
    account: &Account,
    password: &str,
    on_change: &(dyn Fn() + Send + Sync),
) -> Result<Session> {
    let mut fresh = tokio::time::timeout(COMMAND_TIMEOUT, connect(&account.config, password))
        .await
        .with_context(|| format!("No answer from {}", account.config.imap_host))??;
    // Folders then report their changes as part of SELECT (sync_folder).
    within(fresh.enable_qresync()).await?;
    // Without QRESYNC, CONDSTORE still lets a check read only the flags that changed.
    within(fresh.enable_condstore()).await?;
    discover_folders(&mut fresh, store, account.id).await?;
    on_change();
    Ok(fresh)
}

async fn discover_folders(s: &mut Session, store: &Store, account_id: i64) -> Result<()> {
    let folders = within(s.folders()).await.context("Could not list folders")?;
    for folder in &folders {
        if folder.attributes.iter().any(|a| a == "noselect" || a == "nonexistent") {
            continue;
        }
        store.upsert_folder(account_id, &folder.name, role(&folder.name, &folder.attributes))?;
    }
    Ok(())
}

/// The folder's role from its SPECIAL-USE attribute (RFC 6154), or else from its name.
fn role(name: &str, attrs: &[String]) -> &'static str {
    let has = |k: &str| attrs.iter().any(|a| a == k);
    let lower = name.to_lowercase();
    let named = |options: &[&str]| options.iter().any(|o| lower == *o || lower.ends_with(&format!("/{o}")));
    if lower == "inbox" {
        "inbox"
    } else if has("all") || named(&["all mail"]) {
        "all"
    } else if has("sent") || named(&["sent", "sent mail", "sent items", "sent messages"]) {
        "sent"
    } else if has("drafts") || named(&["drafts"]) {
        "drafts"
    } else if has("junk") || named(&["junk", "spam", "junk email", "junk e-mail"]) {
        "junk"
    } else if has("trash") || named(&["trash", "bin", "deleted items", "deleted messages"]) {
        "trash"
    } else if has("archive") || named(&["archive", "archives"]) {
        "archive"
    } else {
        "other"
    }
}

/// (uid, seen, flagged) as the server has it.
type FlagUpdate = (u32, bool, bool);

/// Returns (the store changed, mail is left to fetch on a later pass).
async fn sync_folder<S: Stream>(
    s: &mut Imap<S>,
    store: &Store,
    account_id: i64,
    folder_id: i64,
    name: &str,
    deadline: Instant,
    on_change: &(dyn Fn() + Send + Sync),
) -> Result<(bool, bool)> {
    let known = store.folder_state(folder_id)?;
    // With QRESYNC and a folder synced before, the server says what changed since then as part of the SELECT.
    let since = match (s.qresync(), known.uid_validity, known.highest_modseq) {
        (true, Some(validity), Some(modseq)) if modseq > 0 => Some((validity, modseq as u64)),
        _ => None,
    };
    let (mailbox, delta) = match since {
        Some((validity, modseq)) => {
            let r = within(s.select_since(name, validity, modseq))
                .await
                .with_context(|| format!("Could not open {name}"))?;
            (r.selected, Some((r.vanished, r.changed)))
        }
        None => (within(s.select(name)).await.with_context(|| format!("Could not open {name}"))?, None),
    };
    let mut changed = false;

    let renumbered = known.uid_validity.is_some() && known.uid_validity != mailbox.uid_validity;
    if renumbered {
        store.reset_folder(folder_id)?;
        changed = true;
    }
    let local = store.local_uids(folder_id)?;
    let pending = store.pending_uids(account_id, name)?;
    let keep = |uid: &u32| local.contains(uid) && !pending.contains(uid);

    let (gone, flag_updates, server): (Vec<u32>, Vec<FlagUpdate>, HashSet<u32>) = match delta {
        // A change report is only good for the numbering it was made against.
        Some((vanished, changes)) if !renumbered => {
            let gone: Vec<u32> = vanished.into_iter().filter(|u| keep(u)).collect();
            let updates: Vec<_> =
                changes.iter().filter(|f| keep(&f.uid)).map(|f| (f.uid, f.seen, f.flagged)).collect();
            // New mail moves UIDNEXT. Only then is a UID SEARCH worth its round trip; known.uid_next is None
            // while an earlier pass left new mail unfetched.
            let look_for_new = known.uid_next.is_none() || known.uid_next != mailbox.uid_next;
            let server =
                if look_for_new && mailbox.exists > 0 { within(s.uids()).await? } else { HashSet::new() };
            log::debug!(
                "{name}: QRESYNC, {} gone, {} flag changes, new mail check: {look_for_new}",
                gone.len(),
                updates.len()
            );
            (gone, updates, server)
        }
        // Without QRESYNC (or the first time): every UID, to find new and deleted mail, and the flags: only those
        // that changed where CONDSTORE can say so, otherwise all of them, a batch at a time.
        _ => {
            let server: HashSet<u32> =
                if mailbox.exists == 0 { HashSet::new() } else { within(s.uids()).await? };
            let gone: Vec<u32> = local.iter().filter(|u| !server.contains(u) && keep(u)).copied().collect();
            let changed_since = match (known.highest_modseq, s.enable_condstore().await?) {
                (Some(modseq), true) if modseq > 0 && !renumbered && known.uid_validity.is_some() => {
                    Some(modseq as u64)
                }
                _ => None,
            };
            let mut fetches = Vec::new();
            if !local.is_empty() && mailbox.exists > 0 {
                let context = || format!("Could not read flags in {name}");
                match changed_since {
                    Some(modseq) => {
                        fetches = within(s.flags_changed_since("1:*", modseq)).await.with_context(context)?;
                    }
                    None => {
                        let mut all: Vec<u32> = server.iter().copied().collect();
                        all.sort_unstable();
                        for batch in all.chunks(FLAG_BATCH) {
                            let range = format!("{}:{}", batch[0], batch[batch.len() - 1]);
                            fetches.extend(within(s.flags(&range)).await.with_context(context)?);
                        }
                    }
                }
            }
            log::debug!(
                "{name}: {} flags read{}",
                fetches.len(),
                if changed_since.is_some() { " (CONDSTORE, changed only)" } else { "" }
            );
            let updates =
                fetches.iter().filter(|f| keep(&f.uid)).map(|f| (f.uid, f.seen, f.flagged)).collect();
            (gone, updates, server)
        }
    };
    if !gone.is_empty() {
        store.remove_uids(folder_id, &gone)?;
        changed = true;
    }
    if store.update_flags(folder_id, &flag_updates)? > 0 {
        changed = true;
    }

    let unknown: Vec<u32> = server.iter().filter(|u| !local.contains(u)).copied().collect();
    let mut new: Vec<u32> = unknown.iter().filter(|u| !pending.contains(u)).copied().collect();
    new.sort_unstable_by(|a, b| b.cmp(a));
    let mut more = new.len() > PER_PASS;
    // Uids held back for queued work (a move still to go out, or stale uids after a renumbering) are looked at
    // again on the next pass, so one that turns out to be new mail is not skipped for good.
    let mut all_new_fetched = !more && new.len() == unknown.len();
    new.truncate(PER_PASS);
    // Headers first: a few hundred bytes a message, so the list fills in a round trip or two. Bodies follow.
    for chunk in new.chunks(HEADER_CHUNK) {
        let set = uid_set(chunk);
        let fetched =
            within(s.headers(&set)).await.with_context(|| format!("Could not fetch headers in {name}"))?;
        // io-imap drops a response it cannot parse without an error; say so, or the message silently never shows.
        if fetched.len() < chunk.len() {
            all_new_fetched = false;
            log::warn!(
                "{name}: the server's answer for {} of {} messages could not be read",
                chunk.len() - fetched.len(),
                chunk.len()
            );
        }
        let batch: Vec<NewMessage> = fetched
            .iter()
            .filter_map(|f| {
                mime::parse_headers(
                    f.uid,
                    f.header.as_deref()?,
                    f.seen,
                    f.flagged,
                    f.size,
                    f.structure.clone(),
                )
            })
            .collect();
        store.insert_messages(account_id, folder_id, &batch)?;
        on_change();
    }
    // Phase B: a snippet for headers-only rows from the start of their text part, so the list reads well before
    // the bodies come (and mail older than BODY_DAYS, which gets its body only when opened, has one at all).
    if fetch_snippets(s, store, account_id, (folder_id, name), deadline, on_change).await? {
        more = true;
    }
    if fetch_bodies(s, store, account_id, (folder_id, name), now() - BODY_DAYS * 86_400, deadline, on_change)
        .await?
    {
        more = true;
    }

    let state = FolderState {
        uid_validity: mailbox.uid_validity,
        // Kept back while new mail is still to fetch, so the next pass searches for it again.
        uid_next: if all_new_fetched { mailbox.uid_next } else { None },
        highest_modseq: mailbox.highest_modseq.map(|m| m as i64),
    };
    store.set_folder_state(folder_id, &state)?;
    Ok((changed, more))
}

/// Reads snippets for headers-only rows from the first bytes of their text part, newest first, until `deadline`,
/// queued work, or an opened message without a body needs the connection. Returns true when some are left.
async fn fetch_snippets<S: Stream>(
    s: &mut Imap<S>,
    store: &Store,
    account_id: i64,
    (folder_id, name): (i64, &str),
    deadline: Instant,
    on_change: &(dyn Fn() + Send + Sync),
) -> Result<bool> {
    loop {
        let needed = store.snippets_needed(folder_id, SNIPPET_ROUND)?;
        if needed.is_empty() {
            return Ok(false);
        }
        if Instant::now() >= deadline
            || outbox_due(store, account_id)?
            || !store.folders_with_wanted_bodies(account_id)?.is_empty()
        {
            return Ok(true);
        }
        // One FETCH per section number: most messages share "1" or "1.1".
        let mut by_section: HashMap<&str, Vec<u32>> = HashMap::new();
        for (uid, part) in &needed {
            by_section.entry(part.section.as_str()).or_default().push(*uid);
        }
        let parts: HashMap<u32, &crate::models::Part> = needed.iter().map(|(uid, p)| (*uid, p)).collect();
        let mut snippets: HashMap<u32, String> =
            needed.iter().map(|(uid, _)| (*uid, String::new())).collect();
        for (section, uids) in by_section {
            let fetched = within(s.part_start(&uid_set(&uids), section, SNIPPET_BYTES))
                .await
                .with_context(|| format!("Could not read snippets in {name}"))?;
            for f in fetched {
                if let (Some(bytes), Some(part)) = (f.part.as_deref(), parts.get(&f.uid)) {
                    snippets.insert(f.uid, mime::part_snippet(part, bytes));
                }
            }
        }
        // Rows the server sent nothing for get an empty snippet, so they are not asked for again and again.
        store.set_snippets(folder_id, &snippets.into_iter().collect::<Vec<_>>())?;
        on_change();
    }
}

/// Fills in bodies for rows that have only headers: opened ones first, then the newest received since `since`,
/// until `deadline` or until queued work is due. Returns true when some are left for a later pass.
async fn fetch_bodies<S: Stream>(
    s: &mut Imap<S>,
    store: &Store,
    account_id: i64,
    (folder_id, name): (i64, &str),
    since: i64,
    deadline: Instant,
    on_change: &(dyn Fn() + Send + Sync),
) -> Result<bool> {
    loop {
        let needed = store.bodies_needed(folder_id, since, BODY_ROUND)?;
        if needed.is_empty() {
            return Ok(false);
        }
        let uids: Vec<u32> = needed.iter().map(|(uid, _)| *uid).collect();
        let sizes: HashMap<u32, u32> =
            needed.iter().filter_map(|(uid, size)| Some((*uid, (*size)?))).collect();
        let mut filled = 0;
        for chunk in by_size(&uids, &sizes) {
            // Out of time, or something the person did is waiting: leave the rest for later. Prefetch also stops
            // for a message someone opened that has no body yet.
            let prefetching = since != i64::MAX;
            if Instant::now() >= deadline
                || outbox_due(store, account_id)?
                || (prefetching && !store.folders_with_wanted_bodies(account_id)?.is_empty())
            {
                return Ok(true);
            }
            let set = uid_set(chunk);
            let bytes: u64 = chunk.iter().map(|u| sizes.get(u).copied().unwrap_or(0) as u64).sum();
            log::debug!("fetching {name} bodies {set} ({} kB)", bytes / 1000);
            // Big mail takes longer to come down, so the limit grows with the batch.
            let limit = COMMAND_TIMEOUT + Duration::from_secs(bytes / MIN_BYTES_PER_SECOND);
            let fetched = within_for(limit, s.bodies(&set))
                .await
                .with_context(|| format!("Could not fetch {name} bodies {set}"))?;
            // A body that does not parse is stored empty rather than fetched again and again.
            let batch: Vec<NewMessage> = fetched
                .iter()
                .map(|f| {
                    f.body
                        .as_deref()
                        .and_then(|raw| mime::parse(f.uid, raw, f.seen, f.flagged))
                        .unwrap_or_else(|| NewMessage { uid: f.uid, ..Default::default() })
                })
                .collect();
            filled += store.fill_bodies(folder_id, &batch)?;
            on_change();
        }
        // Nothing came back for any of them (gone from the server): leave them to the next pass's cleanup
        // instead of asking again now.
        if filled == 0 {
            return Ok(false);
        }
    }
}

/// Sends everything due. Returns true when there was anything.
///
/// Work the server refuses is recorded and the rest goes on, and so does the pass: one bad message must not hold
/// up new mail. Only a connection that broke ends the pass, so it can reconnect; what was claimed and not tried
/// goes back in the queue.
async fn drain_outbox<S: Stream>(
    s: &mut Imap<S>,
    store: &Store,
    account: &Account,
    password: &str,
) -> Result<bool> {
    let due = store.claim_due(account.id)?;
    let any = !due.is_empty();
    for (id, _) in due {
        let Some(op) = store.outbox_op(id)? else { continue };
        if matches!(op, OutboxOp::Send(_)) {
            store.outbox_sending(id)?;
        }
        let Err(e) = run_op(s, store, account, password, &op).await else {
            store.outbox_done(id)?;
            // The server files a copy in Sent: look there next instead of in up to five minutes.
            if matches!(op, OutboxOp::Send(_)) {
                for f in store.folders()? {
                    if f.account_id == account.id && f.role == "sent" {
                        want_folder(f.id);
                    }
                }
            }
            continue;
        };
        let failure = failure(&e);
        store.outbox_failed(id, &format!("{e:#}"), failure)?;
        log::warn!("{}: queued work {id} failed ({failure:?}): {e:#}", account.config.email);
        // A Send uses its own SMTP connection, so only IMAP work can leave this session broken.
        if !matches!(op, OutboxOp::Send(_)) && connection_broke(&e) {
            store.release_claims(account.id)?;
            return Err(e);
        }
    }
    Ok(any)
}

/// Work that cannot succeed however often it is tried (its messages are no longer on the server).
#[derive(Debug)]
struct Unworkable(String);

impl std::fmt::Display for Unworkable {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for Unworkable {}

fn failure(e: &anyhow::Error) -> Failure {
    if smtp::maybe_sent(e) {
        Failure::MaybeSent
    } else if smtp::is_permanent(e) || e.chain().any(|c| c.is::<Unworkable>()) {
        Failure::Permanent
    } else {
        Failure::Retry
    }
}

/// Whether an error means the connection is gone (I/O error or no answer), not that the server said no.
fn connection_broke(e: &anyhow::Error) -> bool {
    imap::connection_lost(e) || e.chain().any(|c| c.is::<tokio::time::error::Elapsed>())
}

async fn run_op<S: Stream>(
    s: &mut Imap<S>,
    store: &Store,
    account: &Account,
    password: &str,
    op: &OutboxOp,
) -> Result<()> {
    match op {
        OutboxOp::Flags { folder, uids, flag, add, revert, validity, waiting } => {
            let ids: Vec<i64> = revert.iter().map(|r| r.0).collect();
            let found = locate(s, store, folder, uids, *validity, waiting, &ids).await?;
            if found.is_empty() {
                return Ok(());
            }
            let set = uid_set(&found.keys().copied().collect::<Vec<_>>());
            within(s.store_flag(&set, flag, *add)).await?;
        }
        OutboxOp::Move { folder, dest, uids, revert, validity, waiting } => {
            let ids: Vec<i64> = revert.iter().map(|r| r.0).collect();
            let mut found = locate(s, store, folder, uids, *validity, waiting, &ids).await?;
            // Uids that were known when the work was queued: which message each one is. (After a renumbering
            // every entry already names its message, so a stale uid cannot claim one.)
            for (id, _, uid) in revert {
                if let Some(entry) = uid.and_then(|u| found.get_mut(&u)) {
                    entry.get_or_insert(*id);
                }
            }
            if found.is_empty() {
                return Ok(());
            }
            let set = uid_set(&found.keys().copied().collect::<Vec<_>>());
            let placed: Vec<(i64, u32)> = within(s.move_to(&set, dest))
                .await?
                .into_iter()
                .filter_map(|(from, to)| Some((found.get(&from).copied().flatten()?, to)))
                .collect();
            // Later work on these messages may be waiting to learn where they went.
            store.moved(account.id, dest, &placed)?;
        }
        OutboxOp::Send(draft) => smtp::send(&account.config, password, draft).await?,
    }
    Ok(())
}

/// Opens `folder` and works out which uids queued work should act on, as uid → message id (when known).
///
/// The uids it was queued with hold while the folder keeps its UIDVALIDITY. If the server renumbered the folder
/// since, every message is looked up again by Message-ID; so are `waiting` messages, whose uid here was never
/// learned. A message that cannot be found is skipped; when none can be, the work is unworkable.
async fn locate<S: Stream>(
    s: &mut Imap<S>,
    store: &Store,
    folder: &str,
    uids: &[u32],
    validity: Option<u32>,
    waiting: &[i64],
    ids: &[i64],
) -> Result<HashMap<u32, Option<i64>>> {
    let selected = within(s.select(folder)).await?;
    let renumbered = validity.is_some() && selected.uid_validity != validity;
    let mut found: HashMap<u32, Option<i64>> =
        if renumbered { HashMap::new() } else { uids.iter().map(|u| (*u, None)).collect() };
    let lookup = if renumbered { ids } else { waiting };
    if lookup.is_empty() {
        return Ok(found);
    }
    if renumbered {
        log::info!("{folder} was renumbered on the server; finding queued messages by Message-ID");
    }
    let mut missing = Vec::new();
    for (id, message_id) in store.message_ids(lookup)? {
        let uids = within(s.find_message_id(&message_id)).await?;
        if uids.is_empty() {
            missing.push((id, message_id));
        }
        found.extend(uids.into_iter().map(|uid| (uid, Some(id))));
    }
    // The server found nothing by header search, which some cannot do (Stalwart): read every Message-ID in the
    // folder once and match here. A renumbering or a server without COPYUID is rare enough to afford it.
    if !missing.is_empty() && selected.exists > 0 {
        for (uid, message_id) in within(s.message_ids("1:*")).await? {
            if let Some((id, _)) = missing.iter().find(|(_, m)| *m == message_id) {
                found.insert(uid, Some(*id));
            }
        }
    }
    if found.is_empty() {
        return Err(Unworkable(format!("The messages are no longer in {folder} on the server")).into());
    }
    Ok(found)
}

/// Runs one IMAP command, giving up after COMMAND_TIMEOUT.
async fn within<T>(command: impl Future<Output = Result<T>>) -> Result<T> {
    within_for(COMMAND_TIMEOUT, command).await
}

async fn within_for<T>(limit: Duration, command: impl Future<Output = Result<T>>) -> Result<T> {
    tokio::time::timeout(limit, command).await.context("The server stopped answering")?
}

/// Splits UIDs into batches of at most FETCH_CHUNK messages and FETCH_BYTES bytes; a message bigger than that
/// goes alone.
fn by_size<'a>(uids: &'a [u32], sizes: &HashMap<u32, u32>) -> Vec<&'a [u32]> {
    let mut batches = Vec::new();
    let (mut start, mut bytes) = (0, 0u64);
    for (i, uid) in uids.iter().enumerate() {
        let size = sizes.get(uid).copied().unwrap_or(0) as u64;
        if i > start && (i - start == FETCH_CHUNK || bytes + size > FETCH_BYTES) {
            batches.push(&uids[start..i]);
            (start, bytes) = (i, 0);
        }
        bytes += size;
    }
    if start < uids.len() {
        batches.push(&uids[start..]);
    }
    batches
}

fn uid_set(uids: &[u32]) -> String {
    uids.iter().map(u32::to_string).collect::<Vec<_>>().join(",")
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::{by_size, role, FETCH_BYTES, FETCH_CHUNK};

    #[test]
    fn batches_by_count_and_size() {
        let uids: Vec<u32> = (1..=120).collect();
        let small: HashMap<u32, u32> = uids.iter().map(|&u| (u, 1_000)).collect();
        let lens: Vec<usize> = by_size(&uids, &small).iter().map(|b| b.len()).collect();
        assert_eq!(lens, [FETCH_CHUNK, FETCH_CHUNK, 20]);

        let big = FETCH_BYTES as u32;
        let sizes: HashMap<u32, u32> = [(1, 1_000), (2, big), (3, 1_000), (4, 1_000)].into();
        let batches = by_size(&[1, 2, 3, 4], &sizes);
        assert_eq!(batches, [&[1][..], &[2][..], &[3, 4][..]]);
    }

    #[test]
    fn reconnect_waits_grow_to_a_minute_with_jitter() {
        use std::time::Duration;
        for _ in 0..100 {
            let first = super::backoff(1);
            assert!(first >= Duration::from_millis(500) && first <= Duration::from_secs(1), "{first:?}");
            let late = super::backoff(20);
            assert!(late >= Duration::from_secs(30) && late <= Duration::from_secs(60), "{late:?}");
        }
        let spread: std::collections::HashSet<_> = (0..20).map(|_| super::backoff(6)).collect();
        assert!(spread.len() > 1, "jittered");
    }

    #[test]
    fn roles_from_attributes_and_names() {
        let attrs = |a: &[&str]| a.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(role("INBOX", &[]), "inbox");
        assert_eq!(role("[Gmail]/All Mail", &attrs(&["hasnochildren", "all"])), "all");
        assert_eq!(role("Whatever", &attrs(&["sent"])), "sent");
        assert_eq!(role("[Gmail]/Spam", &[]), "junk");
        assert_eq!(role("Deleted Items", &[]), "trash");
        assert_eq!(role("Receipts", &[]), "other");
    }

    /// Queued work run against a scripted server: the cases a real server rarely produces on demand.
    mod outbox {
        use super::super::drain_outbox;
        use crate::imap::Imap;
        use crate::models::{Account, AccountConfig, Action, FolderState, ListTarget, NewMessage, Security};
        use crate::scripted::{signed_in, Script};
        use crate::store::Store;

        const SIGNED_IN: &str = "{tag} OK [CAPABILITY IMAP4rev1 MOVE UIDPLUS] in\r\n";
        const SELECT_INBOX: &str = "* 1 EXISTS\r\n* OK [UIDVALIDITY 7] v\r\n{tag} OK [READ-WRITE] s\r\n";
        const SELECT_ARCHIVE: &str = "* 1 EXISTS\r\n* OK [UIDVALIDITY 3] v\r\n{tag} OK [READ-WRITE] s\r\n";

        struct Mailbox {
            store: Store,
            account: Account,
            inbox: i64,
            archive: i64,
            trash: i64,
            /// One message, uid 4 in INBOX (UIDVALIDITY 7), Message-ID a1@example.com.
            message: i64,
        }

        fn mailbox() -> Mailbox {
            let store = Store::open_in_memory().unwrap();
            let account = store
                .add_account(&AccountConfig {
                    email: "ada@example.com".into(),
                    display_name: String::new(),
                    username: "ada".into(),
                    imap_host: "imap.example.com".into(),
                    imap_port: 993,
                    imap_security: Security::Tls,
                    smtp_host: "smtp.example.com".into(),
                    smtp_port: 465,
                    smtp_security: Security::Tls,
                })
                .unwrap();
            let inbox = store.upsert_folder(account.id, "INBOX", "inbox").unwrap();
            let archive = store.upsert_folder(account.id, "Archive", "archive").unwrap();
            let trash = store.upsert_folder(account.id, "Trash", "trash").unwrap();
            let state = FolderState { uid_validity: Some(7), uid_next: Some(5), highest_modseq: None };
            store.set_folder_state(inbox, &state).unwrap();
            let m = NewMessage {
                uid: 4,
                message_id: Some("a1@example.com".into()),
                subject: "hi".into(),
                date: 1,
                ..Default::default()
            };
            store.insert_messages(account.id, inbox, &[m]).unwrap();
            let message = store.list(&ListTarget::Folder(inbox), None, 10).unwrap()[0].id;
            Mailbox { store, account, inbox, archive, trash, message }
        }

        /// Runs the due outbox against `script`; returns the result and the commands sent after signing in.
        async fn drain(m: &Mailbox, script: Script) -> (anyhow::Result<bool>, Vec<String>) {
            let (stream, sent) = signed_in(SIGNED_IN, script);
            let mut s = Imap::open(stream, "ada", "x").await.unwrap();
            let result = drain_outbox(&mut s, &m.store, &m.account, "").await;
            let sent = sent.lock().unwrap()[2..].to_vec();
            (result, sent)
        }

        fn queue_empty(m: &Mailbox) -> bool {
            m.store.next_due(m.account.id).unwrap().is_none() && m.store.outbox_problems().unwrap().is_empty()
        }

        #[tokio::test]
        async fn a_renumbered_folder_is_searched_by_message_id() {
            let m = mailbox();
            m.store.apply(&[m.message], Action::Star, 0).unwrap();
            let (result, sent) = drain(
                &m,
                vec![
                    ("SELECT INBOX", "* 1 EXISTS\r\n* OK [UIDVALIDITY 8] v\r\n{tag} OK [READ-WRITE] s\r\n"),
                    ("UID SEARCH HEADER Message-ID", "* SEARCH 15\r\n{tag} OK done\r\n"),
                    ("UID STORE 15 +FLAGS (\\Flagged)", "{tag} OK done\r\n"),
                ],
            )
            .await;
            result.unwrap();
            // Never the old uid 4, which now may be any message.
            assert!(!sent.iter().any(|c| c.contains("STORE 4 ")), "{sent:?}");
            assert!(queue_empty(&m));
        }

        #[tokio::test]
        async fn without_header_search_the_folder_message_ids_are_read() {
            let m = mailbox();
            m.store.apply(&[m.message], Action::Star, 0).unwrap();
            let (result, _) = drain(
                &m,
                vec![
                    ("SELECT INBOX", "* 2 EXISTS\r\n* OK [UIDVALIDITY 8] v\r\n{tag} OK [READ-WRITE] s\r\n"),
                    ("UID SEARCH HEADER Message-ID", "* SEARCH\r\n{tag} OK done\r\n"),
                    (
                        "UID FETCH 1:* (UID BODY.PEEK[HEADER.FIELDS (MESSAGE-ID)])",
                        "* 1 FETCH (UID 15 BODY[HEADER.FIELDS (MESSAGE-ID)] {32}\r\nMessage-ID: <z9@example.com>\r\n\r\n)\r\n\
                         * 2 FETCH (UID 16 BODY[HEADER.FIELDS (MESSAGE-ID)] {32}\r\nMessage-ID: <a1@example.com>\r\n\r\n)\r\n\
                         {tag} OK done\r\n",
                    ),
                    ("UID STORE 16 +FLAGS (\\Flagged)", "{tag} OK done\r\n"),
                ],
            )
            .await;
            result.unwrap();
            assert!(queue_empty(&m));
        }

        #[tokio::test]
        async fn a_message_gone_after_renumbering_waits_for_the_person() {
            let m = mailbox();
            m.store.apply(&[m.message], Action::Star, 0).unwrap();
            let (result, _) = drain(
                &m,
                vec![
                    ("SELECT INBOX", "* 0 EXISTS\r\n* OK [UIDVALIDITY 8] v\r\n{tag} OK [READ-WRITE] s\r\n"),
                    ("UID SEARCH HEADER Message-ID", "* SEARCH\r\n{tag} OK done\r\n"),
                ],
            )
            .await;
            result.unwrap();
            let problems = m.store.outbox_problems().unwrap();
            assert_eq!(problems.len(), 1, "given up at once, not retried against the wrong messages");
            assert!(problems[0].last_error.contains("no longer in INBOX"));
        }

        #[tokio::test]
        async fn a_star_made_before_the_archive_went_out_follows_the_message() {
            let m = mailbox();
            m.store.apply(&[m.message], Action::Archive, 0).unwrap();
            // The row is in Archive now, its uid there not known until the move goes out.
            m.store.apply(&[m.message], Action::Star, 0).unwrap();
            let (result, sent) = drain(
                &m,
                vec![
                    ("SELECT INBOX", SELECT_INBOX),
                    ("UID MOVE 4 Archive", "* OK [COPYUID 3 4 9] moved\r\n* 1 EXPUNGE\r\n{tag} OK done\r\n"),
                    ("SELECT Archive", SELECT_ARCHIVE),
                    ("UID STORE 9 +FLAGS (\\Flagged)", "{tag} OK done\r\n"),
                ],
            )
            .await;
            result.unwrap();
            assert!(!sent.iter().any(|c| c.contains("SEARCH")), "COPYUID said where it went: {sent:?}");
            assert!(m.store.local_uids(m.archive).unwrap().contains(&9));
            assert!(queue_empty(&m));
        }

        #[tokio::test]
        async fn archive_then_trash_before_either_went_out() {
            let m = mailbox();
            m.store.apply(&[m.message], Action::Archive, 0).unwrap();
            m.store.apply(&[m.message], Action::Trash, 0).unwrap();
            let (result, _) = drain(
                &m,
                vec![
                    ("SELECT INBOX", SELECT_INBOX),
                    ("UID MOVE 4 Archive", "* OK [COPYUID 3 4 9] moved\r\n* 1 EXPUNGE\r\n{tag} OK done\r\n"),
                    ("SELECT Archive", SELECT_ARCHIVE),
                    ("UID MOVE 9 Trash", "* OK [COPYUID 5 9 20] moved\r\n* 1 EXPUNGE\r\n{tag} OK done\r\n"),
                ],
            )
            .await;
            result.unwrap();
            assert_eq!(m.store.local_uids(m.trash).unwrap(), [20].into());
            assert!(m.store.local_uids(m.archive).unwrap().is_empty());
            assert!(queue_empty(&m));
        }

        #[tokio::test]
        async fn without_copyuid_waiting_work_finds_the_message_by_message_id() {
            let m = mailbox();
            m.store.apply(&[m.message], Action::Archive, 0).unwrap();
            m.store.apply(&[m.message], Action::Star, 0).unwrap();
            let (result, _) = drain(
                &m,
                vec![
                    ("SELECT INBOX", SELECT_INBOX),
                    ("UID MOVE 4 Archive", "* 1 EXPUNGE\r\n{tag} OK done\r\n"),
                    ("SELECT Archive", SELECT_ARCHIVE),
                    ("UID SEARCH HEADER Message-ID", "* SEARCH 9\r\n{tag} OK done\r\n"),
                    ("UID STORE 9 +FLAGS (\\Flagged)", "{tag} OK done\r\n"),
                ],
            )
            .await;
            result.unwrap();
            assert!(queue_empty(&m));
        }

        #[tokio::test]
        async fn a_dropped_connection_puts_the_work_back() {
            let m = mailbox();
            m.store.apply(&[m.message], Action::Archive, 0).unwrap();
            // The server hangs up instead of answering the move.
            let (result, _) =
                drain(&m, vec![("SELECT INBOX", SELECT_INBOX), ("UID MOVE 4 Archive", "")]).await;
            assert!(result.is_err());
            assert!(m.store.outbox_problems().unwrap().is_empty());
            assert!(m.store.next_due(m.account.id).unwrap().is_some(), "still queued, to try again");
            assert!(m.store.local_uids(m.inbox).unwrap().is_empty(), "and still archived here");
        }

        /// Runs one folder check against `script` on a server with `capabilities`; returns the commands sent.
        async fn check(m: &Mailbox, capabilities: &'static str, script: Script) -> Vec<String> {
            let (stream, sent) = signed_in(capabilities, script);
            let mut s = Imap::open(stream, "ada", "x").await.unwrap();
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
            super::super::sync_folder(&mut s, &m.store, m.account.id, m.inbox, "INBOX", deadline, &|| {})
                .await
                .unwrap();
            let sent = sent.lock().unwrap()[2..].to_vec();
            sent
        }

        #[tokio::test]
        async fn condstore_alone_reads_only_changed_flags() {
            let m = mailbox();
            let state = FolderState { uid_validity: Some(7), uid_next: Some(5), highest_modseq: Some(100) };
            m.store.set_folder_state(m.inbox, &state).unwrap();
            let sent = check(
                &m,
                "{tag} OK [CAPABILITY IMAP4rev1 CONDSTORE] in\r\n",
                vec![
                    (
                        "SELECT INBOX",
                        "* 1 EXISTS\r\n* OK [UIDVALIDITY 7] v\r\n* OK [UIDNEXT 5] n\r\n\
                         * OK [HIGHESTMODSEQ 130] m\r\n{tag} OK [READ-WRITE] s\r\n",
                    ),
                    ("UID SEARCH ALL", "* SEARCH 4\r\n{tag} OK done\r\n"),
                    (
                        "UID FETCH 1:* (UID FLAGS) (CHANGEDSINCE 100)",
                        "* 1 FETCH (UID 4 FLAGS (\\Seen) MODSEQ (120))\r\n{tag} OK done\r\n",
                    ),
                ],
            )
            .await;
            assert_eq!(sent.len(), 3, "{sent:?}");
            assert_eq!(m.store.flags_of(m.inbox, 4), Some((true, false)));
            assert_eq!(m.store.folder_state(m.inbox).unwrap().highest_modseq, Some(130));
        }

        #[tokio::test]
        async fn without_condstore_flags_are_read_in_uid_ranges() {
            let m = mailbox();
            let sent = check(
                &m,
                "{tag} OK [CAPABILITY IMAP4rev1] in\r\n",
                vec![
                    ("SELECT INBOX", "* 1 EXISTS\r\n* OK [UIDVALIDITY 7] v\r\n{tag} OK [READ-WRITE] s\r\n"),
                    ("UID SEARCH ALL", "* SEARCH 4\r\n{tag} OK done\r\n"),
                    ("UID FETCH 4 (UID FLAGS)", "* 1 FETCH (UID 4 FLAGS (\\Flagged))\r\n{tag} OK done\r\n"),
                ],
            )
            .await;
            assert!(!sent.iter().any(|c| c.contains("1:*")), "{sent:?}");
            assert_eq!(m.store.flags_of(m.inbox, 4), Some((false, true)));
        }

        #[test]
        fn undo_is_refused_while_later_work_counts_on_the_move() {
            let m = mailbox();
            let archived = m.store.apply(&[m.message], Action::Archive, 5).unwrap();
            let starred = m.store.apply(&[m.message], Action::Star, 5).unwrap();
            assert!(!m.store.undo(&archived.token).unwrap());
            assert!(m.store.undo(&starred.token).unwrap());
            assert!(m.store.undo(&archived.token).unwrap(), "fine once nothing waits on it");
            assert_eq!(m.store.local_uids(m.inbox).unwrap(), [4].into());
        }
    }

    /// The dev mail server's test account and its password.
    fn dev_account() -> (crate::models::AccountConfig, String) {
        use crate::models::{AccountConfig, Security};
        let dir =
            std::path::PathBuf::from(std::env::var_os("HOME").unwrap()).join(".local/share/tern-devmail");
        let password = std::fs::read_to_string(dir.join("test-password")).unwrap().trim().to_string();
        let config = AccountConfig {
            email: "test@localhost".into(),
            display_name: String::new(),
            username: "test@localhost".into(),
            imap_host: "localhost".into(),
            imap_port: 1993,
            imap_security: Security::Tls,
            smtp_host: "localhost".into(),
            smtp_port: 1465,
            smtp_security: Security::Tls,
        };
        (config, password)
    }

    /// A fresh sync against the dev mail server: mail older than BODY_DAYS gets no body, but a snippet from its
    /// text part.
    #[tokio::test]
    #[ignore = "needs scripts/dev-mail-server.sh start; run with scripts/dev-mail-server.sh test"]
    async fn old_mail_gets_a_snippet_without_its_body() {
        use crate::models::ListTarget;
        use crate::store::Store;

        let (config, password) = dev_account();
        let store = Store::open_in_memory().unwrap();
        let account = store.add_account(&config).unwrap();
        let (mut session, mut schedule, nothing) = (None, super::Schedule::default(), || {});
        while super::pass(&store, &account, &password, &mut session, &mut schedule, &nothing).await.unwrap() {
        }
        let inbox =
            store.folders_to_sync(account.id).unwrap().into_iter().find(|(_, n)| n == "INBOX").unwrap().0;
        let old: Vec<_> = store
            .list(&ListTarget::Folder(inbox), None, 10_000)
            .unwrap()
            .into_iter()
            .filter(|r| r.date < crate::store::now() - super::BODY_DAYS * 86_400)
            .collect();
        assert!(!old.is_empty(), "the dev inbox has mail older than {} days (seed it)", super::BODY_DAYS);
        for row in &old {
            assert!(!row.snippet.is_empty(), "{:?} has a snippet", row.subject);
            assert!(
                !store.thread(row.id).unwrap().iter().any(|m| m.row.id == row.id && m.body_loaded),
                "no body"
            );
        }
    }

    /// Two real sync passes against the dev mail server, with an outside flag change and move in between.
    #[tokio::test]
    #[ignore = "needs scripts/dev-mail-server.sh start; run with scripts/dev-mail-server.sh test"]
    async fn second_pass_applies_outside_changes_through_qresync() {
        use crate::store::Store;

        let (config, password) = dev_account();
        let store = Store::open_in_memory().unwrap();
        let account = store.add_account(&config).unwrap();
        let mut session = None;
        let mut schedule = super::Schedule::default();
        let nothing = || {};
        while super::pass(&store, &account, &password, &mut session, &mut schedule, &nothing).await.unwrap() {
        }

        let inbox =
            store.folders_to_sync(account.id).unwrap().into_iter().find(|(_, n)| n == "INBOX").unwrap().0;
        assert!(store.folder_state(inbox).unwrap().highest_modseq.is_some(), "the server keeps modseqs");
        let local = store.local_uids(inbox).unwrap();
        let (flag_me, move_me) = (*local.iter().min().unwrap(), *local.iter().max().unwrap());

        // Outside Tern: star one message, move another away.
        let mut other = super::connect(&config, &password).await.unwrap();
        other.select("INBOX").await.unwrap();
        let was_flagged = other.flags(&flag_me.to_string()).await.unwrap()[0].flagged;
        other.store_flag(&flag_me.to_string(), "\\Flagged", !was_flagged).await.unwrap();
        other.move_to(&move_me.to_string(), "Archive").await.unwrap();

        while super::pass(&store, &account, &password, &mut session, &mut schedule, &nothing).await.unwrap() {
        }
        let local = store.local_uids(inbox).unwrap();
        assert!(!local.contains(&move_me), "the moved message left the inbox");
        let (_, flagged) = store.flags_of(inbox, flag_me).unwrap();
        assert_eq!(flagged, !was_flagged, "the outside flag change arrived");

        // Put the flag back so the test leaves the mailbox as it found it.
        other.select("INBOX").await.unwrap();
        other.store_flag(&flag_me.to_string(), "\\Flagged", was_flagged).await.unwrap();
        other.logout().await.unwrap();
    }

    /// Archive a message and star it before the archive has gone out, against the dev mail server: the star must
    /// land on the archived copy, then both are undone on the server the same way.
    #[tokio::test]
    #[ignore = "needs scripts/dev-mail-server.sh start; run with scripts/dev-mail-server.sh test"]
    async fn star_made_before_the_archive_went_out_reaches_the_archived_message() {
        use crate::models::{Action, ListTarget};
        use crate::store::Store;

        let (config, password) = dev_account();
        let store = Store::open_in_memory().unwrap();
        let account = store.add_account(&config).unwrap();
        let mut session = None;
        let mut schedule = super::Schedule::default();
        let nothing = || {};
        while super::pass(&store, &account, &password, &mut session, &mut schedule, &nothing).await.unwrap() {
        }
        let folder = |name: &str| {
            store.folders_to_sync(account.id).unwrap().into_iter().find(|(_, n)| n == name).unwrap().0
        };
        let (inbox, archive) = (folder("INBOX"), folder("Archive"));
        // The newest unstarred inbox message that has a Message-ID, so the check below can find it.
        let row = store
            .list(&ListTarget::Folder(inbox), None, 100)
            .unwrap()
            .into_iter()
            .find(|r| !r.flagged && !store.message_ids(&[r.id]).unwrap().is_empty())
            .expect("seed the inbox first");

        store.apply(&[row.id], Action::Archive, 0).unwrap();
        store.apply(&[row.id], Action::Star, 0).unwrap();
        while super::pass(&store, &account, &password, &mut session, &mut schedule, &nothing).await.unwrap() {
        }
        let problems = store.outbox_problems().unwrap();
        assert!(problems.is_empty(), "{problems:?}");
        assert_eq!(store.next_due(account.id).unwrap(), None);

        // On the server: the archived copy carries the star.
        let message_id = store.message_ids(&[row.id]).unwrap().remove(0).1;
        let mut other = super::connect(&config, &password).await.unwrap();
        other.select("Archive").await.unwrap();
        // Stalwart cannot search Message-ID headers, so read them all.
        let found: Vec<u32> = other
            .message_ids("1:*")
            .await
            .unwrap()
            .into_iter()
            .filter(|(_, m)| *m == message_id)
            .map(|(uid, _)| uid)
            .collect();
        assert_eq!(found.len(), 1, "archived once");
        assert!(other.flags(&found[0].to_string()).await.unwrap()[0].flagged, "the star reached it");
        assert!(store.local_uids(archive).unwrap().contains(&found[0]), "Tern knows its uid there");

        // Leave the mailbox as it was: unstar it and put it back in the inbox.
        other.store_flag(&found[0].to_string(), "\\Flagged", false).await.unwrap();
        other.move_to(&found[0].to_string(), "INBOX").await.unwrap();
        other.logout().await.unwrap();
    }
}
