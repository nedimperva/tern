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

use crate::imap::{self, TlsImap};
use crate::models::{Account, AccountConfig, NewMessage, OutboxOp};
use crate::store::{now, Store};
use crate::{mime, smtp};

pub type Session = TlsImap;

/// How often to look for new mail. TODO: IMAP IDLE on the inbox, so new mail shows the moment it lands.
const POLL: Duration = Duration::from_secs(60);
/// How long one pass spends fetching mail that is already on the server before new mail and the outbox get
/// another look.
const BACKFILL_BUDGET: Duration = Duration::from_secs(15);
/// Most messages per FETCH.
const FETCH_CHUNK: usize = 50;
/// Most bytes per FETCH, so one batch of big attachments doesn't become a single long wait.
const FETCH_BYTES: u64 = 4_000_000;
/// The slowest download we still wait for when fetching mail bodies.
const MIN_BYTES_PER_SECOND: u64 = 100_000;
/// New messages per folder per pass; the rest come on later passes, newest first.
const PER_PASS: usize = 500;
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
                Duration::from_secs((5u64 << failures.min(6)).min(300))
            }
        };
        tokio::select! {
            _ = wake.notified() => {}
            _ = tokio::time::sleep(wait) => {}
        }
    }
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
    let sizes: HashMap<u32, u32> = if new.is_empty() {
        HashMap::new()
    } else {
        within(s.sizes(&uid_set(&new)))
            .await
            .with_context(|| format!("Could not read message sizes in {name}"))?
    };
    let batches = by_size(&new, &sizes);
    for (i, chunk) in batches.iter().enumerate() {
        if Instant::now() >= deadline {
            more = true;
            log::debug!("{name}: {} batches left for the next pass", batches.len() - i);
            break;
        }
        // TODO: fetch headers and a short text part first, and whole bodies (BODY.PEEK[]) behind them.
        let set = uid_set(chunk);
        let bytes: u64 = chunk.iter().map(|u| sizes.get(u).copied().unwrap_or(0) as u64).sum();
        log::debug!("fetching {name} UIDs {set} ({} kB)", bytes / 1000);
        // Big mail takes longer to come down, so the limit grows with the batch.
        let limit = COMMAND_TIMEOUT + Duration::from_secs(bytes / MIN_BYTES_PER_SECOND);
        let fetches = within_for(limit, s.bodies(&set))
            .await
            .with_context(|| format!("Could not fetch {name} UIDs {set}"))?;
        let batch: Vec<NewMessage> = fetches
            .iter()
            .filter_map(|f| mime::parse(f.uid, f.body.as_deref()?, f.seen, f.flagged))
            .collect();
        store.insert_messages(account_id, folder_id, &batch)?;
        on_change();
    }

    store.set_folder_state(folder_id, mailbox.uid_validity, mailbox.uid_next)?;
    Ok((changed, more))
}

/// Sends everything due. Returns true when there was anything.
async fn drain_outbox(s: &mut Session, store: &Store, account: &Account, password: &str) -> Result<bool> {
    let due = store.claim_due(account.id)?;
    let any = !due.is_empty();
    let mut first_error = None;
    for (id, op) in due {
        match run_op(s, &account.config, password, &op).await {
            Ok(()) => store.outbox_done(id)?,
            Err(e) => {
                store.outbox_failed(id, &format!("{e:#}"))?;
                first_error.get_or_insert(e);
            }
        }
    }
    match first_error {
        Some(e) => Err(e),
        None => Ok(any),
    }
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
