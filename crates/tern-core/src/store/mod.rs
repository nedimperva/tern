//! The database on the device. Every list, thread and search the UI shows is answered from here.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::path::Path;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{bail, Context, Result};
use rusqlite::types::Value;
use rusqlite::{params, Connection, OptionalExtension, Row};

use crate::models::*;
use schema::{backup_before_migrating, migrate};

mod accounts;
mod drafts;
mod marks;
mod outbox;
mod reading;
mod schema;
mod settings;
mod syncing;
mod writing;

const SCHEMA_VERSION: i64 = 28;

/// What a mark is kept by: the message's Message-ID, or its row for mail without one.
const KEY: &str = "COALESCE(m.message_id, '#' || m.id)";
/// Seconds a draft rests after its last change before its server copy is replaced, and that a discarded one waits
/// (for Undo) before its server copy goes.
const DRAFT_REST: i64 = 30;
/// Messages with the same normalised subject and a participant in common within this many seconds of each other
/// join one conversation when nothing in their headers links them.
const SUBJECT_WINDOW: i64 = 7 * 86_400;
/// Tries before queued work stops retrying and waits for the person.
const MAX_ATTEMPTS: i64 = 5;

const ROW: &str =
    "m.id, m.account_id, m.folder_id, m.thread_id, m.subject, m.from_name, m.from_addr, m.date, \
                   m.snippet, m.seen, m.flagged, m.has_attachments";

fn row(r: &Row) -> rusqlite::Result<MessageRow> {
    Ok(MessageRow {
        id: r.get(0)?,
        account_id: r.get(1)?,
        folder_id: r.get(2)?,
        thread_id: r.get(3)?,
        subject: r.get(4)?,
        from_name: r.get(5)?,
        from_addr: r.get(6)?,
        date: r.get(7)?,
        snippet: r.get(8)?,
        seen: r.get(9)?,
        flagged: r.get(10)?,
        has_attachments: r.get(11)?,
    })
}

/// Fills in each conversation of a list page from all its messages: two queries for the page, not three per row.
fn conversations(conn: &Connection, latests: Vec<MessageRow>) -> Result<Vec<ThreadRow>> {
    let keys = serde_json::to_string(
        &latests.iter().map(|m| (m.account_id, m.thread_id.as_str())).collect::<Vec<_>>(),
    )?;
    let page = "(SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]') FROM json_each(?1))";
    struct Sums {
        ids: HashSet<String>,
        unread: i64,
        flagged: bool,
        participants: Vec<String>,
        snoozed_until: Option<i64>,
    }
    let mut sums: HashMap<(i64, String), Sums> = HashMap::new();
    let mut messages = conn.prepare_cached(&format!(
        "SELECT m.account_id, m.thread_id, m.id, m.message_id, m.seen, m.flagged, m.from_name, m.from_addr,
                lower(m.from_addr) = lower(a.email)
         FROM messages m JOIN accounts a ON a.id = m.account_id
         WHERE (m.account_id, m.thread_id) IN {page}
         ORDER BY m.account_id, m.thread_id, m.date, m.id"
    ))?;
    let mut rows = messages.query([&keys])?;
    while let Some(r) = rows.next()? {
        let key = (r.get::<_, i64>(0)?, r.get::<_, String>(1)?);
        let s = sums.entry(key).or_insert_with(|| Sums {
            ids: HashSet::new(),
            unread: 0,
            flagged: false,
            participants: Vec::new(),
            snoozed_until: None,
        });
        // A message in several folders (or a copy in Sent) counts once.
        let id =
            r.get::<_, Option<String>>(3)?.unwrap_or_else(|| format!("#{}", r.get::<_, i64>(2).unwrap_or(0)));
        s.ids.insert(id);
        s.unread += i64::from(!r.get::<_, bool>(4)?);
        s.flagged |= r.get::<_, bool>(5)?;
        let (name, addr, mine): (String, String, bool) = (r.get(6)?, r.get(7)?, r.get(8)?);
        let who = if mine {
            "me".to_string()
        } else if name.is_empty() {
            addr
        } else {
            name
        };
        if s.participants.len() < 4 && !s.participants.contains(&who) {
            s.participants.push(who);
        }
    }
    let mut labels: HashMap<(i64, String), Vec<String>> = HashMap::new();
    // Only Gmail has labels; a store without any skips the query.
    let any: bool =
        conn.prepare_cached("SELECT EXISTS (SELECT 1 FROM message_labels)")?.query_row([], |r| r.get(0))?;
    let mut named = conn.prepare_cached(&format!(
        "SELECT DISTINCT m.account_id, m.thread_id, f.name FROM messages m
         JOIN message_labels l ON l.message_id = m.message_id
         JOIN folders f ON f.id = l.folder_id AND f.account_id = m.account_id
         WHERE (m.account_id, m.thread_id) IN {page} ORDER BY f.name"
    ))?;
    let mut rows = named.query([if any { keys.as_str() } else { "[]" }])?;
    while let Some(r) = rows.next()? {
        labels.entry((r.get(0)?, r.get(1)?)).or_default().push(r.get(2)?);
    }
    let mut snoozes = conn.prepare_cached(&format!(
        "SELECT account_id, thread_id, due FROM reminders WHERE kind = 'snooze' AND (account_id, thread_id) IN {page}"
    ))?;
    let mut rows = snoozes.query([&keys])?;
    while let Some(r) = rows.next()? {
        if let Some(s) = sums.get_mut(&(r.get(0)?, r.get(1)?)) {
            s.snoozed_until = Some(r.get(2)?);
        }
    }
    Ok(latests
        .into_iter()
        .map(|latest| {
            let key = (latest.account_id, latest.thread_id.clone());
            let labels = labels.remove(&key).unwrap_or_default();
            let (count, unread, flagged, participants, snoozed_until) = match sums.remove(&key) {
                Some(s) => (s.ids.len() as i64, s.unread, s.flagged, s.participants, s.snoozed_until),
                None => (1, i64::from(!latest.seen), latest.flagged, Vec::new(), None),
            };
            ThreadRow {
                latest,
                count,
                unread,
                flagged,
                participants,
                snoozed_until,
                follow_up: false,
                labels,
            }
        })
        .collect())
}

fn security(r: &Row, i: usize) -> rusqlite::Result<Security> {
    let text: String = r.get(i)?;
    Security::parse(&text).ok_or_else(|| {
        rusqlite::Error::FromSqlConversionFailure(
            i,
            rusqlite::types::Type::Text,
            format!("security {text:?}").into(),
        )
    })
}

pub fn now() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

/// Counts a message's people for autocomplete: mail this account sent counts for its recipients (three times
/// over, in `contacts`' ranking), mail it received for the sender. Automated senders (no-reply) are left out.
fn note_people(conn: &Connection, me: &str, m: &NewMessage) -> Result<()> {
    let mut bump = conn.prepare_cached(
        "INSERT INTO contacts (email, name, sent_count, received_count, last_seen) VALUES (lower(?1), ?2, ?3, ?4, ?5)
         ON CONFLICT (email) DO UPDATE SET
             name = CASE WHEN excluded.name != '' THEN excluded.name ELSE contacts.name END,
             sent_count = contacts.sent_count + excluded.sent_count,
             received_count = contacts.received_count + excluded.received_count,
             last_seen = MAX(contacts.last_seen, excluded.last_seen)",
    )?;
    let automated = |a: &str| {
        let a = a.to_lowercase();
        ["noreply", "no-reply", "donotreply", "do-not-reply", "mailer-daemon", "notifications@"]
            .iter()
            .any(|n| a.contains(n))
    };
    if m.from_addr.eq_ignore_ascii_case(me) {
        for addr in m.to_addrs.split(',').chain(m.cc_addrs.split(',')).map(str::trim) {
            if addr.contains('@') && !addr.eq_ignore_ascii_case(me) {
                bump.execute(params![addr, "", 1, 0, m.date])?;
            }
        }
    } else if m.from_addr.contains('@') && !automated(&m.from_addr) {
        bump.execute(params![m.from_addr, m.from_name, 0, 1, m.date])?;
    }
    Ok(())
}

/// A subject as conversations compare it: lowercase, without reply and forward prefixes ("Re:", "Fwd:", "AW:",
/// "Re[2]:") or leading list tags ("[team]"). None when nothing is left, so empty subjects never join up.
pub fn subject_norm(subject: &str) -> Option<String> {
    const PREFIXES: &[&str] = &["re", "fw", "fwd", "aw", "wg", "sv", "vs", "antw", "tr", "rv", "ref", "odp"];
    let mut s = subject.trim().to_lowercase();
    loop {
        let before = s.len();
        if s.starts_with('[') {
            if let Some(end) = s.find(']') {
                s = s[end + 1..].trim_start().to_string();
            }
        }
        if let Some(colon) = s.find(':') {
            let head = s[..colon].trim();
            let word = head.split('[').next().unwrap_or(head).trim();
            if PREFIXES.contains(&word) {
                s = s[colon + 1..].trim_start().to_string();
            }
        }
        if s.len() == before {
            break;
        }
    }
    let s = s.split_whitespace().collect::<Vec<_>>().join(" ");
    (!s.is_empty()).then_some(s)
}

/// The Starred split of the inbox, as a list target: `ListTarget::Role("starred")`.
pub const STARRED: &str = "starred";

/// SQL keeping the messages `m` that are in `target`, and the value for its parameter, numbered `n`.
pub const IMPORTANT: &str = "important";
/// The Other split. Not "other": that is the role of every folder without a special one.
pub const OTHER: &str = "bulk";
pub const SNOOZED: &str = "snoozed";
/// The Read later shelf.
pub const LATER: &str = "later";
/// Conversations with something marked in them, in any folder.
pub const MARKED: &str = "marked";

/// The message goes to Other: its sender was moved there, or (with no choice made) it is bulk mail.
const IS_OTHER: &str = "COALESCE((SELECT s.other FROM sender_splits s
                                  WHERE s.account_id = m.account_id AND s.addr = lower(m.from_addr)), m.bulk)";
/// The conversation a follow-up reminder `r` watches: the one its sent message is in, once that is here.
const FOLLOW_UP_THREAD: &str = "(SELECT f.thread_id FROM messages f
                                 WHERE f.account_id = r.account_id AND f.message_id = r.message_id LIMIT 1)";
/// Its conversation is snoozed.
const IS_SNOOZED: &str = "EXISTS (SELECT 1 FROM reminders r
                                 WHERE r.account_id = m.account_id AND r.thread_id = m.thread_id AND r.kind = 'snooze')";

/// Its conversation is on the Read later shelf, and nobody has written in it since it was put there: a reply from
/// someone else takes it off, back to the inbox.
const IS_LATER: &str = "EXISTS (SELECT 1 FROM read_later l
                               WHERE l.account_id = m.account_id AND l.thread_id = m.thread_id
                                 AND NOT EXISTS (SELECT 1 FROM messages x JOIN accounts a ON a.id = x.account_id
                                                 WHERE x.account_id = l.account_id AND x.thread_id = l.thread_id
                                                   AND x.date > l.added AND lower(x.from_addr) <> lower(a.email)))";

/// The message (any copy of it) has marks. Taken from the marks, so a few marks in a big mailbox stay quick.
const IS_MARKED: &str = "m.id IN (SELECT x.id FROM marks k JOIN messages x
                                  ON x.account_id = k.account_id AND COALESCE(x.message_id, '#' || x.id) = k.message_key)";

fn target_filter(target: &ListTarget, n: u8) -> (String, Value) {
    let inbox = format!("m.folder_id IN (SELECT id FROM folders WHERE role = ?{n})");
    let role = match target {
        ListTarget::Folder(id) => return (format!("m.folder_id = ?{n}"), Value::Integer(*id)),
        // A Gmail label: All Mail's copies of the messages the label folder holds.
        ListTarget::Label(id) => {
            return (
                format!(
                    "m.folder_id IN (SELECT a.id FROM folders a JOIN folders l ON l.account_id = a.account_id
                                     WHERE l.id = ?{n} AND a.role = 'all')
                     AND m.message_id IN (SELECT message_id FROM message_labels WHERE folder_id = ?{n})"
                ),
                Value::Integer(*id),
            )
        }
        ListTarget::Role(role) => role.as_str(),
    };
    // Snoozed and shelved conversations stay in the inbox folder (both are Tern's alone) but out of its lists.
    let filter = match role {
        "inbox" => format!("{inbox} AND NOT {IS_SNOOZED} AND NOT {IS_LATER}"),
        STARRED => format!("m.flagged AND {inbox} AND NOT {IS_SNOOZED} AND NOT {IS_LATER}"),
        IMPORTANT => format!("{inbox} AND NOT {IS_SNOOZED} AND NOT {IS_LATER} AND NOT {IS_OTHER}"),
        OTHER => format!("{inbox} AND NOT {IS_SNOOZED} AND NOT {IS_LATER} AND {IS_OTHER}"),
        SNOOZED => format!("{inbox} AND {IS_SNOOZED}"),
        // Wherever the conversation is: one shelved from Archive or a search stays there, and shows here too. Not
        // its drafts (a click would open compose) or the bin and spam.
        LATER => {
            return (
                format!(
                    "{IS_LATER} AND NOT {IS_SNOOZED}
                     AND m.folder_id NOT IN (SELECT id FROM folders WHERE role IN (?{n}, 'junk', 'drafts'))"
                ),
                Value::Text("trash".into()),
            )
        }
        // Wherever the conversation went, except the bin.
        MARKED => {
            return (
                format!("{IS_MARKED} AND m.folder_id NOT IN (SELECT id FROM folders WHERE role = ?{n})"),
                Value::Text("trash".into()),
            )
        }
        _ => return (inbox, Value::Text(role.into())),
    };
    (filter, Value::Text("inbox".into()))
}

pub struct Store {
    conn: Mutex<Connection>,
    /// A second, read-only connection for what the window reads (lists, search, a conversation), so a sync batch
    /// writing on `conn` never makes a keypress wait. WAL lets it read while the writer writes. None in memory,
    /// where a second connection would be a different database.
    reader: Option<Mutex<Connection>>,
}

impl Store {
    pub fn open(path: &Path) -> Result<Self> {
        let conn = Connection::open(path)?;
        backup_before_migrating(&conn, path)?;
        let mut store = Self::init(conn)?;
        // Opened after migrating, so it never sees an older schema.
        let reader = Connection::open_with_flags(
            path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        reader.execute_batch("PRAGMA temp_store = MEMORY; PRAGMA mmap_size = 268435456;")?;
        store.reader = Some(Mutex::new(reader));
        Ok(store)
    }

    pub fn open_in_memory() -> Result<Self> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(conn: Connection) -> Result<Self> {
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             PRAGMA foreign_keys = ON;
             PRAGMA temp_store = MEMORY;
             PRAGMA mmap_size = 268435456;",
        )?;
        migrate(&conn)?;
        // Work claimed by a run that did not finish is free to go again, except a send that had started: it may
        // have gone out, so it waits for the person (claimed = 2, see `outbox_sending`).
        conn.execute("UPDATE outbox SET claimed = 0 WHERE claimed = 1", [])?;
        conn.execute(
            "UPDATE outbox SET claimed = 0, maybe_sent = 1, gave_up_at = ?1, attempts = attempts + 1,
                               last_error = 'Tern stopped while sending this, so it may have been sent'
             WHERE claimed = 2",
            [now()],
        )?;
        Ok(Self { conn: Mutex::new(conn), reader: None })
    }

    fn conn(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.conn.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// At quit: lets SQLite refresh the statistics its query planner uses (cheap; it only looks where they went
    /// stale) and folds the write-ahead log back into the database, so it doesn't stay large between runs.
    pub fn tidy_on_exit(&self) -> Result<()> {
        let conn = self.conn();
        conn.execute_batch("PRAGMA optimize;")?;
        conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()))?;
        Ok(())
    }

    /// The connection for reads the window waits on (see `reader`).
    fn reader(&self) -> std::sync::MutexGuard<'_, Connection> {
        match &self.reader {
            Some(reader) => reader.lock().unwrap_or_else(|e| e.into_inner()),
            None => self.conn(),
        }
    }
}

/// Puts the local store back as it was before `op`.
/// A Message-ID without its angle brackets, as messages store them.
fn bare_id(id: &str) -> String {
    id.trim().trim_start_matches('<').trim_end_matches('>').to_string()
}

/// Puts a draft's current version in its account's Drafts folder as a message row (uid NULL until the server copy
/// is there), so lists and its conversation show it. No Drafts folder: nothing to show it in.
fn mirror_draft(tx: &Connection, account_id: i64, draft: &Draft) -> Result<()> {
    let folder: Option<i64> = tx
        .query_row("SELECT id FROM folders WHERE account_id = ?1 AND role = 'drafts'", [account_id], |r| {
            r.get(0)
        })
        .optional()?;
    let Some(folder_id) = folder else { return Ok(()) };
    let bare = bare_id(draft.message_id.as_deref().unwrap_or_default());
    let (email, name): (String, String) =
        tx.query_row("SELECT email, display_name FROM accounts WHERE id = ?1", [account_id], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })?;
    let (body, out_html) = draft.outgoing();
    let snippet = crate::mime::snippet(body);
    let to = draft.to.join(", ");
    let existing: Option<i64> = tx
        .query_row(
            "SELECT id FROM messages WHERE account_id = ?1 AND folder_id = ?2 AND message_id = ?3",
            params![account_id, folder_id, bare],
            |r| r.get(0),
        )
        .optional()?;
    let id = match existing {
        Some(id) => {
            tx.execute(
                "UPDATE messages SET subject = ?2, to_addrs = ?3, snippet = ?4, date = ?5, subject_norm = ?6 WHERE id = ?1",
                params![id, draft.subject, to, snippet, now(), subject_norm(&draft.subject)],
            )?;
            id
        }
        None => {
            let m = NewMessage {
                message_id: Some(bare.clone()),
                in_reply_to: draft.in_reply_to.as_deref().map(bare_id),
                references: draft.references.iter().map(|r| bare_id(r)).collect(),
                subject: draft.subject.clone(),
                from_addr: email.clone(),
                to_addrs: to.clone(),
                date: now(),
                ..Default::default()
            };
            let thread_id = thread_for(tx, account_id, folder_id, &m)?;
            tx.execute(
                "INSERT INTO messages (account_id, folder_id, uid, message_id, thread_id, subject, from_name, from_addr,
                                       to_addrs, date, snippet, seen, body_state, subject_norm)
                 VALUES (?1, ?2, NULL, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 1, 'full', ?11)",
                params![
                    account_id, folder_id, bare, thread_id, draft.subject, name, email, to, now(), snippet,
                    subject_norm(&draft.subject)
                ],
            )?;
            tx.last_insert_rowid()
        }
    };
    // The editor's HTML is Tern's own, but it can hold pasted markup: cleaned like any mail before it is shown.
    let html = out_html.map(crate::mime::sanitize_html);
    tx.execute(
        "INSERT OR REPLACE INTO bodies (message_id, text, html) VALUES (?1, ?2, ?3)",
        params![id, body, html],
    )?;
    Ok(())
}

/// Takes a draft's row out of the Drafts folder (sent or discarded).
fn unmirror_draft(conn: &Connection, id: i64) -> Result<()> {
    conn.execute(
        "DELETE FROM messages WHERE id IN (
             SELECT m.id FROM drafts d
             JOIN messages m ON m.account_id = d.account_id AND m.message_id = d.message_id
             JOIN folders f ON f.id = m.folder_id AND f.role = 'drafts'
             WHERE d.id = ?1)",
        [id],
    )?;
    Ok(())
}

/// Every queued op of the account, in order.
fn queued(conn: &Connection, account_id: i64) -> Result<Vec<OutboxOp>> {
    let mut stmt = conn.prepare_cached("SELECT payload FROM outbox WHERE account_id = ?1 ORDER BY id")?;
    let payloads =
        stmt.query_map([account_id], |r| r.get::<_, String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
    payloads.iter().map(|p| Ok(serde_json::from_str(p)?)).collect()
}

/// Whether work queued after `id` waits on a message that `op` moves.
fn waited_on(conn: &Connection, id: i64, op: &OutboxOp) -> Result<bool> {
    let OutboxOp::Move { revert, .. } = op else { return Ok(false) };
    let moved: HashSet<i64> = revert.iter().map(|r| r.0).collect();
    let mut stmt = conn.prepare_cached(
        "SELECT payload FROM outbox WHERE id > ?1 AND account_id = (SELECT account_id FROM outbox WHERE id = ?1)",
    )?;
    let later = stmt.query_map([id], |r| r.get::<_, String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
    for payload in later {
        match serde_json::from_str::<OutboxOp>(&payload)? {
            OutboxOp::Flags { waiting, .. } | OutboxOp::Move { waiting, .. }
                if waiting.iter().any(|w| moved.contains(w)) =>
            {
                return Ok(true)
            }
            _ => {}
        }
    }
    Ok(false)
}

/// Reverts queued work that has not reached the server and drops it. `tried`: also work that failed a try (the
/// failure was definite: an uncertain send is a problem, not waiting work). Work being sent now, or that later work
/// depends on, stays.
fn take_back(tx: &Connection, id: i64, tried: bool) -> Result<bool> {
    let payload: Option<String> = tx
        .query_row(
            "SELECT payload FROM outbox
             WHERE id = ?1 AND claimed = 0 AND gave_up_at IS NULL AND (attempts = 0 OR ?2)",
            params![id, tried],
            |r| r.get(0),
        )
        .optional()?;
    let Some(payload) = payload else { return Ok(false) };
    let op: OutboxOp = serde_json::from_str(&payload)?;
    // Later work on the same messages counts on this move happening; taking it back would strand that.
    if waited_on(tx, id, &op)? {
        return Ok(false);
    }
    revert(tx, &op)?;
    // An unsent message that was a draft is a draft again, back in Drafts.
    if let OutboxOp::Send(draft) = &op {
        let account_id: i64 =
            tx.query_row("SELECT account_id FROM outbox WHERE id = ?1", [id], |r| r.get(0))?;
        let bare = bare_id(draft.message_id.as_deref().unwrap_or_default());
        let restored = tx.execute(
            "UPDATE drafts SET sent_at = NULL WHERE account_id = ?1 AND message_id = ?2 AND sent_at IS NOT NULL",
            params![account_id, bare],
        )?;
        if restored > 0 {
            mirror_draft(tx, account_id, draft)?;
        }
        // A message that never went out gets no answer to wait for.
        tx.execute(
            "DELETE FROM reminders WHERE account_id = ?1 AND kind = 'followup' AND message_id = ?2",
            params![account_id, bare],
        )?;
    }
    tx.execute("DELETE FROM outbox WHERE id = ?1", [id])?;
    Ok(true)
}

fn revert(conn: &Connection, op: &OutboxOp) -> Result<()> {
    match op {
        OutboxOp::Label { label_folder, add, message_ids, .. } => {
            let sql = if *add {
                "DELETE FROM message_labels WHERE folder_id = ?1 AND message_id = ?2"
            } else {
                "INSERT OR IGNORE INTO message_labels (folder_id, message_id) VALUES (?1, ?2)"
            };
            for id in message_ids {
                conn.execute(sql, params![label_folder, id])?;
            }
        }
        OutboxOp::Flags { revert, .. } => {
            for (mid, seen, flagged) in revert {
                conn.execute(
                    "UPDATE messages SET seen = ?2, flagged = ?3 WHERE id = ?1",
                    params![mid, seen, flagged],
                )?;
            }
        }
        OutboxOp::Move { revert, .. } => {
            for (mid, folder_id, uid) in revert {
                conn.execute(
                    "UPDATE messages SET folder_id = ?2, uid = ?3 WHERE id = ?1",
                    params![mid, folder_id, uid],
                )?;
            }
        }
        OutboxOp::Send(_) | OutboxOp::Append { .. } => {}
    }
    Ok(())
}

/// The attachments listed in a row's `parts`. A row whose parts do not parse shows none rather than failing.
fn attachments_of(parts: Option<&str>) -> Vec<Attachment> {
    let parts: Vec<Part> = parts.and_then(|p| serde_json::from_str(p).ok()).unwrap_or_default();
    parts
        .into_iter()
        .filter(|p| p.attachment)
        .map(|p| Attachment { name: p.name.unwrap_or_else(|| "Untitled".into()), mime: p.mime, size: p.size })
        .collect()
}

/// A few words on what queued work does, for the problems list.
fn describe(op: &OutboxOp) -> String {
    let count = |n: usize| if n == 1 { "1 message".to_string() } else { format!("{n} messages") };
    match op {
        OutboxOp::Send(draft) => format!("Send “{}”", draft.subject),
        OutboxOp::Append { subject, folder, .. } => format!("Save “{subject}” to {folder}"),
        OutboxOp::Move { dest, uids, .. } => format!("Move {} to {dest}", count(uids.len())),
        OutboxOp::Label { label, add: true, uids, .. } => format!("Label {} {label}", count(uids.len())),
        OutboxOp::Label { label, add: false, uids, .. } => {
            format!("Remove the label {label} from {}", count(uids.len()))
        }
        OutboxOp::Flags { flag, add, uids, .. } => {
            let verb = match (flag.as_str(), add) {
                ("\\Seen", true) => "Mark read",
                ("\\Seen", false) => "Mark unread",
                ("\\Flagged", true) => "Star",
                ("\\Flagged", false) => "Unstar",
                _ => "Change flags on",
            };
            format!("{verb} {}", count(uids.len()))
        }
    }
}

fn enqueue(conn: &Connection, account_id: i64, op: &OutboxOp, delay: i64) -> Result<i64> {
    conn.execute(
        "INSERT INTO outbox (account_id, payload, not_before) VALUES (?1, ?2, ?3)",
        params![account_id, serde_json::to_string(op)?, now() + delay],
    )?;
    Ok(conn.last_insert_rowid())
}

/// The conversation a message belongs to: the one any message it answers is in, or else the first message it
/// names, so a reply that arrives before its parent still lands with it.
fn thread_for(conn: &Connection, account_id: i64, folder_id: i64, m: &NewMessage) -> Result<String> {
    let mut related: Vec<&str> = m.references.iter().map(String::as_str).collect();
    if let Some(parent) = &m.in_reply_to {
        related.push(parent);
    }
    let mut stmt = conn
        .prepare_cached("SELECT thread_id FROM messages WHERE account_id = ?1 AND message_id = ?2 LIMIT 1")?;
    for id in &related {
        if let Some(thread) = stmt.query_row(params![account_id, id], |r| r.get::<_, String>(0)).optional()? {
            return Ok(thread);
        }
    }
    if let Some(first) = related.first() {
        // Its parent has not arrived: the first message it names stands for the conversation until it does.
        return Ok(first.to_string());
    }
    // Nothing in its headers links it. A reply that came first may already have named it.
    if let Some(id) = &m.message_id {
        let named: bool = conn
            .prepare_cached(
                "SELECT EXISTS (SELECT 1 FROM messages WHERE account_id = ?1 AND thread_id = ?2)",
            )?
            .query_row(params![account_id, id], |r| r.get(0))?;
        if named {
            return Ok(id.clone());
        }
    }
    // Lists and bulk senders repeat one subject on purpose (a weekly report, an alert): those stay apart.
    let bulk = m.list_id.is_some() || m.precedence_bulk;
    if !bulk {
        if let Some(thread) = thread_by_subject(conn, account_id, m)? {
            return Ok(thread);
        }
    }
    Ok(m.message_id.clone().unwrap_or_else(|| format!("uid:{folder_id}:{}", m.uid)))
}

/// The conversation of a message with the same normalised subject, within SUBJECT_WINDOW, that shares someone
/// other than the account itself (which is on nearly every message), nearest in time first.
fn thread_by_subject(conn: &Connection, account_id: i64, m: &NewMessage) -> Result<Option<String>> {
    let Some(norm) = subject_norm(&m.subject) else { return Ok(None) };
    let me: String =
        conn.query_row("SELECT lower(email) FROM accounts WHERE id = ?1", [account_id], |r| r.get(0))?;
    let people = |from: &str, to: &str| -> HashSet<String> {
        std::iter::once(from)
            .chain(to.split(','))
            .map(|a| a.trim().to_lowercase())
            .filter(|a| !a.is_empty() && *a != me)
            .collect()
    };
    let ours = people(&m.from_addr, &m.to_addrs);
    if ours.is_empty() {
        return Ok(None);
    }
    let mut stmt = conn.prepare_cached(
        "SELECT thread_id, from_addr, to_addrs FROM messages
         WHERE account_id = ?1 AND subject_norm = ?2 AND date BETWEEN ?3 - ?4 AND ?3 + ?4
         ORDER BY abs(date - ?3) LIMIT 20",
    )?;
    let candidates = stmt
        .query_map(params![account_id, norm, m.date, SUBJECT_WINDOW], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(candidates.into_iter().find(|(_, from, to)| !people(from, to).is_disjoint(&ours)).map(|(t, _, _)| t))
}

#[cfg(test)]
mod tests;
