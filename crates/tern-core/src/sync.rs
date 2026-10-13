//! Keeps one account's folders in the store in step with its IMAP server, and sends the outbox.
//!
//! Each pass: send what the person did (outbox), then per folder drop what the server no longer has, take its flags,
//! and fetch what is new, newest first, a few hundred at a time so the inbox fills before the backlog.

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use async_imap::types::{Fetch, Flag, Name};
use futures::TryStreamExt;
use tokio::net::TcpStream;
use tokio::sync::Notify;

use crate::models::{Account, AccountConfig, NewMessage, OutboxOp};
use crate::store::{now, Store};
use crate::{mime, smtp};

pub type Session = async_imap::Session<async_native_tls::TlsStream<TcpStream>>;

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
    let tcp = TcpStream::connect((config.imap_host.as_str(), config.imap_port))
        .await
        .with_context(|| format!("Could not reach {}:{}", config.imap_host, config.imap_port))?;
    let tls = async_native_tls::TlsConnector::new()
        .connect(config.imap_host.as_str(), tcp)
        .await
        .context("Could not make a secure connection")?;
    let mut client = async_imap::Client::new(tls);
    // The greeting has to be read first: AUTHENTICATE would take it for its own reply and then wait forever.
    client
        .read_response()
        .await
        .context("The server closed the connection")?
        .context("Could not read the server's greeting")?;
    // AUTHENTICATE PLAIN sends the password base64-encoded, so no server has to unquote it; some (SmarterMail)
    // reject LOGIN's quoted string when the password holds quotes, backslashes or non-ASCII letters.
    // A server without PLAIN answers BAD, and then we fall back to LOGIN. SmarterMail also answers BAD to a
    // wrong password, so there a wrong password costs two attempts.
    let plain = Plain { username: &config.username, password };
    match client.authenticate("PLAIN", plain).await {
        Ok(session) => Ok(session),
        Err((async_imap::error::Error::Bad(_), client)) => client
            .login(&config.username, password)
            .await
            .map_err(|(e, _)| anyhow::Error::from(e).context("The server refused the sign-in")),
        Err((e, _)) => Err(anyhow::Error::from(e).context("The server refused the sign-in")),
    }
}

struct Plain<'a> {
    username: &'a str,
    password: &'a str,
}

impl async_imap::Authenticator for Plain<'_> {
    type Response = String;

    fn process(&mut self, _challenge: &[u8]) -> String {
        format!("\0{}\0{}", self.username, self.password)
    }
}

/// Signs in and out, to check settings before an account is saved.
pub async fn check_login(config: &AccountConfig, password: &str) -> Result<()> {
    let mut session = connect(config, password).await?;
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
    let names: Vec<Name> = within(async { s.list(Some(""), Some("*")).await?.try_collect().await })
        .await
        .context("Could not list folders")?;
    for name in &names {
        // async-imap's attribute type differs between versions; its debug text is stable enough to read roles from.
        let attrs: Vec<String> = name.attributes().iter().map(|a| format!("{a:?}").to_lowercase()).collect();
        if attrs.iter().any(|a| a.contains("noselect") || a.contains("nonexistent")) {
            continue;
        }
        store.upsert_folder(account_id, name.name(), role(name.name(), &attrs))?;
    }
    Ok(())
}

/// The folder's role from its SPECIAL-USE attribute (RFC 6154), or else from its name.
fn role(name: &str, attrs: &[String]) -> &'static str {
    let has = |k: &str| attrs.iter().any(|a| a == k || a.contains(&format!("\\{k}\"")));
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

    let server: HashSet<u32> =
        if mailbox.exists == 0 { HashSet::new() } else { within(s.uid_search("ALL")).await? };
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
        let fetches: Vec<Fetch> =
            within(async { s.uid_fetch("1:*", "(UID FLAGS)").await?.try_collect().await })
                .await
                .with_context(|| format!("Could not read flags in {name}"))?;
        let updates: Vec<(u32, bool, bool)> = fetches
            .iter()
            .filter_map(|f| {
                let uid = f.uid?;
                if pending.contains(&uid) || !local.contains(&uid) {
                    return None;
                }
                let (seen, flagged) = flags(f);
                Some((uid, seen, flagged))
            })
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
        let fetches: Vec<Fetch> =
            within(async { s.uid_fetch(uid_set(&new), "(UID RFC822.SIZE)").await?.try_collect().await })
                .await
                .with_context(|| format!("Could not read message sizes in {name}"))?;
        fetches.iter().filter_map(|f| Some((f.uid?, f.size?))).collect()
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
        let fetches: Vec<Fetch> = within_for(limit, async {
            s.uid_fetch(&set, "(UID FLAGS BODY.PEEK[])").await?.try_collect().await
        })
        .await
        .with_context(|| format!("Could not fetch {name} UIDs {set}"))?;
        let batch: Vec<NewMessage> = fetches
            .iter()
            .filter_map(|f| {
                let (seen, flagged) = flags(f);
                mime::parse(f.uid?, f.body()?, seen, flagged)
            })
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
            let query = format!("{}FLAGS.SILENT ({flag})", if *add { "+" } else { "-" });
            let _: Vec<Fetch> = s.uid_store(uid_set(uids), query).await?.try_collect().await?;
        }
        OutboxOp::Move { folder, dest, uids, .. } => {
            if uids.is_empty() {
                return Ok(());
            }
            within(s.select(folder)).await?;
            let set = uid_set(uids);
            if s.capabilities().await?.has_str("MOVE") {
                s.uid_mv(&set, dest).await?;
            } else {
                s.uid_copy(&set, dest).await?;
                let _: Vec<Fetch> =
                    s.uid_store(&set, "+FLAGS.SILENT (\\Deleted)").await?.try_collect().await?;
                // TODO: UID EXPUNGE (UIDPLUS), which leaves alone other mail someone marked deleted.
                let _: Vec<u32> = s.expunge().await?.try_collect().await?;
            }
        }
        OutboxOp::Send(draft) => smtp::send(config, password, draft).await?,
    }
    Ok(())
}

/// Runs one IMAP command, giving up after COMMAND_TIMEOUT.
async fn within<T>(command: impl Future<Output = async_imap::error::Result<T>>) -> Result<T> {
    within_for(COMMAND_TIMEOUT, command).await
}

async fn within_for<T>(
    limit: Duration,
    command: impl Future<Output = async_imap::error::Result<T>>,
) -> Result<T> {
    Ok(tokio::time::timeout(limit, command).await.context("The server stopped answering")??)
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

fn flags(f: &Fetch) -> (bool, bool) {
    let (mut seen, mut flagged) = (false, false);
    for flag in f.flags() {
        match flag {
            Flag::Seen => seen = true,
            Flag::Flagged => flagged = true,
            _ => {}
        }
    }
    (seen, flagged)
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
        assert_eq!(role("[Gmail]/All Mail", &attrs(&["extension(\"\\\\all\")"])), "all");
        assert_eq!(role("Whatever", &attrs(&["sent"])), "sent");
        assert_eq!(role("[Gmail]/Spam", &[]), "junk");
        assert_eq!(role("Deleted Items", &[]), "trash");
        assert_eq!(role("Receipts", &[]), "other");
    }
}
