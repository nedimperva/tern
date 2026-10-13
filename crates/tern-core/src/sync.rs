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

use crate::imap::{self, Idled, TlsImap};
use crate::models::{Account, AccountConfig, NewMessage, OutboxOp};
use crate::store::{now, Store};
use crate::{mime, smtp};

pub type Session = TlsImap;

/// How often every folder is checked. The inbox does not wait for this when the server has IDLE: `watch_inbox`
/// wakes the worker the moment something changes there.
const POLL: Duration = Duration::from_secs(60);
/// How long one IDLE lasts before it is ended and started again. Servers may drop a connection that has been idle
/// for 30 minutes (RFC 2177), and middleboxes sooner.
const IDLE_REFRESH: Duration = Duration::from_secs(25 * 60);
/// How long one pass spends fetching mail that is already on the server before new mail and the outbox get
/// another look.
const BACKFILL_BUDGET: Duration = Duration::from_secs(15);
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

/// Runs for as long as the app does. `wake` cuts a wait short (new work in the outbox, the window got focus);
/// `on_change` is called whenever the store changed.
pub async fn run_account(
    store: Arc<Store>,
    account: Account,
    password: String,
    wake: Arc<Notify>,
    on_change: Arc<dyn Fn() + Send + Sync>,
) {
    tokio::spawn(watch_inbox(account.clone(), password.clone(), wake.clone()));
    let mut session: Option<Session> = None;
    let mut failures: u32 = 0;
    loop {
        let wait = match pass(&store, &account, &password, &mut session, &*on_change).await {
            Ok(more) => {
                failures = 0;
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
                backoff(failures)
            }
        };
        tokio::select! {
            _ = wake.notified() => {}
            _ = tokio::time::sleep(wait) => {}
        }
    }
}

/// Keeps a second connection in IDLE on the inbox and wakes the sync worker as soon as the server reports a change
/// there. It only ever selects the inbox and idles, so it never competes with the worker's commands. Without IDLE
/// on the server it stops, and the worker's poll is what finds new mail.
async fn watch_inbox(account: Account, password: String, wake: Arc<Notify>) {
    let email = &account.config.email;
    let mut failures: u32 = 0;
    loop {
        let mut s = match within(connect(&account.config, &password)).await {
            Ok(s) => s,
            Err(e) => {
                failures += 1;
                log::warn!("{email}: inbox watch could not connect: {e:#}");
                tokio::time::sleep(backoff(failures)).await;
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
        if let Err(e) = keep_idling(&mut s, &wake).await {
            log::warn!("{email}: inbox watch stopped: {e:#}");
            tokio::time::sleep(backoff(1)).await;
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

/// Wait before trying again after `failures` failures in a row: 10 s, 20 s, … up to 5 minutes.
fn backoff(failures: u32) -> Duration {
    Duration::from_secs((5u64 << failures.min(6)).min(300))
}

async fn pass(
    store: &Store,
    account: &Account,
    password: &str,
    session: &mut Option<Session>,
    on_change: &(dyn Fn() + Send + Sync),
) -> Result<bool> {
    if session.is_none() {
        let mut fresh = tokio::time::timeout(COMMAND_TIMEOUT, connect(&account.config, password))
            .await
            .with_context(|| format!("No answer from {}", account.config.imap_host))??;
        discover_folders(&mut fresh, store, account.id).await?;
        on_change();
        *session = Some(fresh);
    }
    let s = session.as_mut().expect("connected above");

    if drain_outbox(s, store, account, password).await? {
        on_change();
    }
    // Messages someone opened before their body came: those first, whatever folder they are in.
    for (folder_id, name) in store.folders_with_wanted_bodies(account.id)? {
        within(s.select(&name)).await.with_context(|| format!("Could not open {name}"))?;
        let opened_only = i64::MAX;
        fetch_bodies(s, store, folder_id, &name, opened_only, Instant::now() + BACKFILL_BUDGET, on_change)
            .await?;
    }
    // Every folder gets its new mail looked for, but old mail only comes down until the deadline; the next pass
    // starts at once and carries on, after the outbox and inbox have had their turn.
    let deadline = Instant::now() + BACKFILL_BUDGET;
    let mut more = false;
    for (folder_id, name) in store.folders_to_sync(account.id)? {
        let (changed, unfinished) =
            sync_folder(s, store, account.id, folder_id, &name, deadline, on_change).await?;
        if changed {
            on_change();
        }
        more |= unfinished;
    }
    Ok(more)
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

/// Returns (the store changed, mail is left to fetch on a later pass).
async fn sync_folder(
    s: &mut Session,
    store: &Store,
    account_id: i64,
    folder_id: i64,
    name: &str,
    deadline: Instant,
    on_change: &(dyn Fn() + Send + Sync),
) -> Result<(bool, bool)> {
    let mailbox = within(s.select(name)).await.with_context(|| format!("Could not open {name}"))?;
    let mut changed = false;

    let (known_validity, _) = store.folder_state(folder_id)?;
    if known_validity.is_some() && known_validity != mailbox.uid_validity {
        store.reset_folder(folder_id)?;
        changed = true;
    }

    let server: HashSet<u32> = if mailbox.exists == 0 { HashSet::new() } else { within(s.uids()).await? };
    let local = store.local_uids(folder_id)?;
    let pending = store.pending_uids(account_id, name)?;

    let gone: Vec<u32> =
        local.iter().filter(|u| !server.contains(u) && !pending.contains(u)).copied().collect();
    if !gone.is_empty() {
        store.remove_uids(folder_id, &gone)?;
        changed = true;
    }

    // Flags of the mail already here. TODO: CONDSTORE/QRESYNC (FETCH … CHANGEDSINCE), so an unchanged folder costs
    // one round trip instead of a line per message.
    if !local.is_empty() && mailbox.exists > 0 {
        let fetches =
            within(s.flags("1:*")).await.with_context(|| format!("Could not read flags in {name}"))?;
        let updates: Vec<(u32, bool, bool)> = fetches
            .iter()
            .filter(|f| !pending.contains(&f.uid) && local.contains(&f.uid))
            .map(|f| (f.uid, f.seen, f.flagged))
            .collect();
        if store.update_flags(folder_id, &updates)? > 0 {
            changed = true;
        }
    }

    let mut new: Vec<u32> =
        server.iter().filter(|u| !local.contains(u) && !pending.contains(u)).copied().collect();
    new.sort_unstable_by(|a, b| b.cmp(a));
    let mut more = new.len() > PER_PASS;
    new.truncate(PER_PASS);
    // Headers first: a few hundred bytes a message, so the list fills in a round trip or two. Bodies follow.
    for chunk in new.chunks(HEADER_CHUNK) {
        let set = uid_set(chunk);
        let fetched =
            within(s.headers(&set)).await.with_context(|| format!("Could not fetch headers in {name}"))?;
        // io-imap drops a response it cannot parse without an error; say so, or the message silently never shows.
        if fetched.len() < chunk.len() {
            log::warn!(
                "{name}: the server's answer for {} of {} messages could not be read",
                chunk.len() - fetched.len(),
                chunk.len()
            );
        }
        let batch: Vec<NewMessage> = fetched
            .iter()
            .filter_map(|f| mime::parse_headers(f.uid, f.header.as_deref()?, f.seen, f.flagged, f.size))
            .collect();
        store.insert_messages(account_id, folder_id, &batch)?;
        on_change();
    }
    if fetch_bodies(s, store, folder_id, name, now() - BODY_DAYS * 86_400, deadline, on_change).await? {
        more = true;
    }

    store.set_folder_state(folder_id, mailbox.uid_validity, mailbox.uid_next)?;
    Ok((changed, more))
}

/// Fills in bodies for rows that have only headers: opened ones first, then the newest received since `since`,
/// until `deadline`. Returns true when some are left for a later pass.
async fn fetch_bodies(
    s: &mut Session,
    store: &Store,
    folder_id: i64,
    name: &str,
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
            if Instant::now() >= deadline {
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
async fn drain_outbox(s: &mut Session, store: &Store, account: &Account, password: &str) -> Result<bool> {
    let due = store.claim_due(account.id)?;
    let any = !due.is_empty();
    for (id, op) in due {
        let Err(e) = run_op(s, &account.config, password, &op).await else {
            store.outbox_done(id)?;
            continue;
        };
        let permanent = smtp::is_permanent(&e);
        store.outbox_failed(id, &format!("{e:#}"), permanent)?;
        log::warn!(
            "{}: queued work {id} failed{}: {e:#}",
            account.config.email,
            if permanent { " for good" } else { "" }
        );
        // A Send uses its own SMTP connection, so only IMAP work can leave this session broken.
        if !matches!(op, OutboxOp::Send(_)) && connection_broke(&e) {
            store.release_claims(account.id)?;
            return Err(e);
        }
    }
    Ok(any)
}

/// Whether an error means the connection is gone (I/O error or no answer), not that the server said no.
fn connection_broke(e: &anyhow::Error) -> bool {
    imap::connection_lost(e) || e.chain().any(|c| c.is::<tokio::time::error::Elapsed>())
}

async fn run_op(s: &mut Session, config: &AccountConfig, password: &str, op: &OutboxOp) -> Result<()> {
    match op {
        OutboxOp::Flags { folder, uids, flag, add, .. } => {
            if uids.is_empty() {
                return Ok(());
            }
            within(s.select(folder)).await?;
            within(s.store_flag(&uid_set(uids), flag, *add)).await?;
        }
        OutboxOp::Move { folder, dest, uids, .. } => {
            if uids.is_empty() {
                return Ok(());
            }
            within(s.select(folder)).await?;
            within(s.move_to(&uid_set(uids), dest)).await?;
        }
        OutboxOp::Send(draft) => smtp::send(config, password, draft).await?,
    }
    Ok(())
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
    fn roles_from_attributes_and_names() {
        let attrs = |a: &[&str]| a.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(role("INBOX", &[]), "inbox");
        assert_eq!(role("[Gmail]/All Mail", &attrs(&["hasnochildren", "all"])), "all");
        assert_eq!(role("Whatever", &attrs(&["sent"])), "sent");
        assert_eq!(role("[Gmail]/Spam", &[]), "junk");
        assert_eq!(role("Deleted Items", &[]), "trash");
        assert_eq!(role("Receipts", &[]), "other");
    }
}
