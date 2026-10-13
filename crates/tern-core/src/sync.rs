//! Keeps one account's folders in the store in step with its IMAP server, and sends the outbox.
//!
//! Each pass: send what the person did (outbox), then per folder drop what the server no longer has, take its flags,
//! and fetch what is new, newest first, a few hundred at a time so the inbox fills before the backlog.

use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

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
/// Messages per FETCH.
const FETCH_CHUNK: usize = 50;
/// New messages per folder per pass; the rest come on later passes, newest first.
const PER_PASS: usize = 500;

pub async fn connect(config: &AccountConfig, password: &str) -> Result<Session> {
    let tcp = TcpStream::connect((config.imap_host.as_str(), config.imap_port))
        .await
        .with_context(|| format!("Could not reach {}:{}", config.imap_host, config.imap_port))?;
    let tls = async_native_tls::TlsConnector::new()
        .connect(config.imap_host.as_str(), tcp)
        .await
        .context("Could not make a secure connection")?;
    async_imap::Client::new(tls)
        .login(&config.username, password)
        .await
        .map_err(|(e, _)| anyhow::Error::from(e).context("The server refused the sign-in"))
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
            Ok(()) => {
                failures = 0;
                match store.next_due(account.id) {
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
) -> Result<()> {
    if session.is_none() {
        let mut fresh = connect(&account.config, password).await?;
        discover_folders(&mut fresh, store, account.id).await?;
        on_change();
        *session = Some(fresh);
    }
    let s = session.as_mut().expect("connected above");

    if drain_outbox(s, store, account, password).await? {
        on_change();
    }
    for (folder_id, name) in store.folders_to_sync(account.id)? {
        if sync_folder(s, store, account.id, folder_id, &name, on_change).await? {
            on_change();
        }
    }
    Ok(())
}

async fn discover_folders(s: &mut Session, store: &Store, account_id: i64) -> Result<()> {
    let names: Vec<Name> = s.list(Some(""), Some("*")).await?.try_collect().await?;
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

/// Returns true when the store changed.
async fn sync_folder(
    s: &mut Session,
    store: &Store,
    account_id: i64,
    folder_id: i64,
    name: &str,
    on_change: &(dyn Fn() + Send + Sync),
) -> Result<bool> {
    let mailbox = s.select(name).await.with_context(|| format!("Could not open {name}"))?;
    let mut changed = false;

    let (known_validity, _) = store.folder_state(folder_id)?;
    if known_validity.is_some() && known_validity != mailbox.uid_validity {
        store.reset_folder(folder_id)?;
        changed = true;
    }

    let server: HashSet<u32> = if mailbox.exists == 0 { HashSet::new() } else { s.uid_search("ALL").await? };
    let local = store.local_uids(folder_id)?;
    let pending = store.pending_uids(account_id, name)?;

    let gone: Vec<u32> = local.iter().filter(|u| !server.contains(u) && !pending.contains(u)).copied().collect();
    if !gone.is_empty() {
        store.remove_uids(folder_id, &gone)?;
        changed = true;
    }

    // Flags of the mail already here. TODO: CONDSTORE/QRESYNC (FETCH … CHANGEDSINCE), so an unchanged folder costs
    // one round trip instead of a line per message.
    if !local.is_empty() && mailbox.exists > 0 {
        let fetches: Vec<Fetch> = s.uid_fetch("1:*", "(UID FLAGS)").await?.try_collect().await?;
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

    let mut new: Vec<u32> = server.iter().filter(|u| !local.contains(u) && !pending.contains(u)).copied().collect();
    new.sort_unstable_by(|a, b| b.cmp(a));
    new.truncate(PER_PASS);
    for chunk in new.chunks(FETCH_CHUNK) {
        // TODO: fetch headers and a short text part first, and whole bodies (BODY.PEEK[]) behind them.
        let fetches: Vec<Fetch> = s.uid_fetch(uid_set(chunk), "(UID FLAGS BODY.PEEK[])").await?.try_collect().await?;
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
    Ok(changed)
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
            s.select(folder).await?;
            let query = format!("{}FLAGS.SILENT ({flag})", if *add { "+" } else { "-" });
            let _: Vec<Fetch> = s.uid_store(uid_set(uids), query).await?.try_collect().await?;
        }
        OutboxOp::Move { folder, dest, uids, .. } => {
            if uids.is_empty() {
                return Ok(());
            }
            s.select(folder).await?;
            let set = uid_set(uids);
            if s.capabilities().await?.has_str("MOVE") {
                s.uid_mv(&set, dest).await?;
            } else {
                s.uid_copy(&set, dest).await?;
                let _: Vec<Fetch> = s.uid_store(&set, "+FLAGS.SILENT (\\Deleted)").await?.try_collect().await?;
                // TODO: UID EXPUNGE (UIDPLUS), which leaves alone other mail someone marked deleted.
                let _: Vec<u32> = s.expunge().await?.try_collect().await?;
            }
        }
        OutboxOp::Send(draft) => smtp::send(config, password, draft).await?,
    }
    Ok(())
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
    use super::role;

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
