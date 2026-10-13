//! The database on the device. Every list, thread and search the UI shows is answered from here.

use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::path::Path;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{bail, Result};
use rusqlite::types::Value;
use rusqlite::{params, Connection, OptionalExtension, Row};

use crate::models::*;

const SCHEMA_VERSION: i64 = 1;

const SCHEMA: &str = r#"
CREATE TABLE accounts (
    id INTEGER PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL DEFAULT '',
    username TEXT NOT NULL,
    imap_host TEXT NOT NULL,
    imap_port INTEGER NOT NULL,
    smtp_host TEXT NOT NULL,
    smtp_port INTEGER NOT NULL
);

CREATE TABLE folders (
    id INTEGER PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'other',
    uid_validity INTEGER,
    uid_next INTEGER,
    highest_modseq INTEGER,
    UNIQUE (account_id, name)
);

-- `uid` is the server's id for the message in `folder_id`. It is NULL while a move made here has not reached the
-- server: the next sync of the destination folder finds the message again by Message-ID and fills it in.
CREATE TABLE messages (
    id INTEGER PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    folder_id INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
    uid INTEGER,
    message_id TEXT,
    thread_id TEXT NOT NULL,
    subject TEXT NOT NULL DEFAULT '',
    from_name TEXT NOT NULL DEFAULT '',
    from_addr TEXT NOT NULL DEFAULT '',
    to_addrs TEXT NOT NULL DEFAULT '',
    date INTEGER NOT NULL,
    snippet TEXT NOT NULL DEFAULT '',
    seen INTEGER NOT NULL DEFAULT 0,
    flagged INTEGER NOT NULL DEFAULT 0,
    has_attachments INTEGER NOT NULL DEFAULT 0,
    UNIQUE (folder_id, uid)
);
CREATE INDEX messages_list ON messages (folder_id, date DESC, id DESC);
CREATE INDEX messages_thread ON messages (account_id, thread_id, date);
CREATE INDEX messages_msgid ON messages (account_id, message_id);
CREATE INDEX messages_unread ON messages (folder_id) WHERE seen = 0;

-- Bodies apart from the rows, so scanning a list never pages them in.
CREATE TABLE bodies (
    message_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
    text TEXT,
    html TEXT
);

-- Contentless: the index alone, without a second copy of every body.
CREATE VIRTUAL TABLE messages_fts USING fts5 (
    subject, from_name, from_addr, body,
    content = '', contentless_delete = 1,
    tokenize = 'unicode61 remove_diacritics 2'
);
CREATE TRIGGER messages_fts_delete AFTER DELETE ON messages BEGIN
    DELETE FROM messages_fts WHERE rowid = old.id;
END;

CREATE TABLE outbox (
    id INTEGER PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    payload TEXT NOT NULL,
    not_before INTEGER NOT NULL,
    claimed INTEGER NOT NULL DEFAULT 0,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT
);
"#;

const ROW: &str = "m.id, m.account_id, m.folder_id, m.thread_id, m.subject, m.from_name, m.from_addr, m.date, \
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

pub fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

pub struct Store {
    conn: Mutex<Connection>,
}

impl Store {
    pub fn open(path: &Path) -> Result<Self> {
        Self::init(Connection::open(path)?)
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
        let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        if version < 1 {
            conn.execute_batch(SCHEMA)?;
        }
        // Later migrations go here, each guarded by `version < n`.
        conn.execute_batch(&format!("PRAGMA user_version = {SCHEMA_VERSION}"))?;
        // Work claimed by a run that did not finish is free to go again.
        conn.execute("UPDATE outbox SET claimed = 0 WHERE claimed = 1", [])?;
        Ok(Self { conn: Mutex::new(conn) })
    }

    fn conn(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.conn.lock().unwrap_or_else(|e| e.into_inner())
    }

    // MARK: Accounts and folders

    pub fn add_account(&self, c: &AccountConfig) -> Result<Account> {
        let conn = self.conn();
        conn.execute(
            "INSERT INTO accounts (email, display_name, username, imap_host, imap_port, smtp_host, smtp_port)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![c.email, c.display_name, c.username, c.imap_host, c.imap_port, c.smtp_host, c.smtp_port],
        )?;
        Ok(Account { id: conn.last_insert_rowid(), config: c.clone() })
    }

    pub fn remove_account(&self, id: i64) -> Result<()> {
        self.conn().execute("DELETE FROM accounts WHERE id = ?1", [id])?;
        Ok(())
    }

    pub fn accounts(&self) -> Result<Vec<Account>> {
        let conn = self.conn();
        let mut stmt = conn.prepare_cached(
            "SELECT id, email, display_name, username, imap_host, imap_port, smtp_host, smtp_port
             FROM accounts ORDER BY id",
        )?;
        let accounts = stmt
            .query_map([], |r| {
                Ok(Account {
                    id: r.get(0)?,
                    config: AccountConfig {
                        email: r.get(1)?,
                        display_name: r.get(2)?,
                        username: r.get(3)?,
                        imap_host: r.get(4)?,
                        imap_port: r.get(5)?,
                        smtp_host: r.get(6)?,
                        smtp_port: r.get(7)?,
                    },
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(accounts)
    }

    pub fn upsert_folder(&self, account_id: i64, name: &str, role: &str) -> Result<i64> {
        Ok(self.conn().query_row(
            "INSERT INTO folders (account_id, name, role) VALUES (?1, ?2, ?3)
             ON CONFLICT (account_id, name) DO UPDATE SET role = excluded.role
             RETURNING id",
            params![account_id, name, role],
            |r| r.get(0),
        )?)
    }

    pub fn folders(&self) -> Result<Vec<Folder>> {
        let conn = self.conn();
        let mut stmt = conn.prepare_cached(
            "SELECT f.id, f.account_id, f.name, f.role,
                    (SELECT COUNT(*) FROM messages m WHERE m.folder_id = f.id AND m.seen = 0)
             FROM folders f
             ORDER BY f.account_id,
                      CASE f.role WHEN 'inbox' THEN 0 WHEN 'archive' THEN 1 WHEN 'all' THEN 1 WHEN 'sent' THEN 2
                                  WHEN 'drafts' THEN 3 WHEN 'junk' THEN 4 WHEN 'trash' THEN 5 ELSE 6 END,
                      f.name",
        )?;
        let folders = stmt
            .query_map([], |r| {
                Ok(Folder { id: r.get(0)?, account_id: r.get(1)?, name: r.get(2)?, role: r.get(3)?, unread: r.get(4)? })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(folders)
    }

    /// The folders sync keeps, inbox first. Gmail's All Mail is left out: it repeats every other folder.
    pub fn folders_to_sync(&self, account_id: i64) -> Result<Vec<(i64, String)>> {
        let conn = self.conn();
        let mut stmt = conn.prepare_cached(
            "SELECT id, name FROM folders WHERE account_id = ?1 AND role != 'all'
             ORDER BY role = 'inbox' DESC, name",
        )?;
        let folders = stmt
            .query_map([account_id], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(folders)
    }

    /// (UIDVALIDITY, UIDNEXT) as of the last sync.
    pub fn folder_state(&self, folder_id: i64) -> Result<(Option<u32>, Option<u32>)> {
        Ok(self.conn().query_row(
            "SELECT uid_validity, uid_next FROM folders WHERE id = ?1",
            [folder_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?)
    }

    pub fn set_folder_state(&self, folder_id: i64, uid_validity: Option<u32>, uid_next: Option<u32>) -> Result<()> {
        self.conn().execute(
            "UPDATE folders SET uid_validity = ?2, uid_next = ?3 WHERE id = ?1",
            params![folder_id, uid_validity, uid_next],
        )?;
        Ok(())
    }

    /// The server renumbered the folder (UIDVALIDITY changed): forget what we know of it.
    pub fn reset_folder(&self, folder_id: i64) -> Result<()> {
        let conn = self.conn();
        conn.execute("DELETE FROM messages WHERE folder_id = ?1 AND uid IS NOT NULL", [folder_id])?;
        conn.execute(
            "UPDATE folders SET uid_validity = NULL, uid_next = NULL, highest_modseq = NULL WHERE id = ?1",
            [folder_id],
        )?;
        Ok(())
    }

    // MARK: Sync

    pub fn local_uids(&self, folder_id: i64) -> Result<HashSet<u32>> {
        let conn = self.conn();
        let mut stmt = conn.prepare_cached("SELECT uid FROM messages WHERE folder_id = ?1 AND uid IS NOT NULL")?;
        let uids = stmt
            .query_map([folder_id], |r| r.get::<_, u32>(0))?
            .collect::<rusqlite::Result<HashSet<_>>>()?;
        Ok(uids)
    }

    pub fn insert_messages(&self, account_id: i64, folder_id: i64, messages: &[NewMessage]) -> Result<()> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        for m in messages {
            // A message moved here on this device: it has a row already, waiting for its uid.
            if let Some(mid) = &m.message_id {
                let claimed = tx.execute(
                    "UPDATE messages SET uid = ?1, seen = ?2, flagged = ?3
                     WHERE account_id = ?4 AND folder_id = ?5 AND uid IS NULL AND message_id = ?6",
                    params![m.uid, m.seen, m.flagged, account_id, folder_id, mid],
                )?;
                if claimed > 0 {
                    continue;
                }
            }
            let thread_id = thread_for(&tx, account_id, folder_id, m)?;
            let inserted = tx.execute(
                "INSERT OR IGNORE INTO messages (account_id, folder_id, uid, message_id, thread_id, subject, from_name,
                                                 from_addr, to_addrs, date, snippet, seen, flagged, has_attachments)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
                params![
                    account_id, folder_id, m.uid, m.message_id, thread_id, m.subject, m.from_name, m.from_addr,
                    m.to_addrs, m.date, m.snippet, m.seen, m.flagged, m.has_attachments
                ],
            )?;
            if inserted == 0 {
                continue;
            }
            let id = tx.last_insert_rowid();
            tx.execute(
                "INSERT INTO bodies (message_id, text, html) VALUES (?1, ?2, ?3)",
                params![id, m.body_text, m.body_html],
            )?;
            tx.execute(
                "INSERT INTO messages_fts (rowid, subject, from_name, from_addr, body) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![id, m.subject, m.from_name, m.from_addr, m.body_text.as_deref().unwrap_or("")],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    /// Applies (uid, seen, flagged) from the server. Returns how many rows changed.
    pub fn update_flags(&self, folder_id: i64, flags: &[(u32, bool, bool)]) -> Result<usize> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        let mut changed = 0;
        {
            let mut stmt = tx.prepare_cached(
                "UPDATE messages SET seen = ?3, flagged = ?4
                 WHERE folder_id = ?1 AND uid = ?2 AND (seen != ?3 OR flagged != ?4)",
            )?;
            for (uid, seen, flagged) in flags {
                changed += stmt.execute(params![folder_id, uid, seen, flagged])?;
            }
        }
        tx.commit()?;
        Ok(changed)
    }

    pub fn remove_uids(&self, folder_id: i64, uids: &[u32]) -> Result<()> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        {
            let mut stmt = tx.prepare_cached("DELETE FROM messages WHERE folder_id = ?1 AND uid = ?2")?;
            for uid in uids {
                stmt.execute(params![folder_id, uid])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    // MARK: Reading

    /// One page of a list, newest first, starting after `before`.
    pub fn list(&self, target: &ListTarget, before: Option<Cursor>, limit: i64) -> Result<Vec<MessageRow>> {
        let (filter, key) = match target {
            ListTarget::Folder(id) => ("m.folder_id = ?1", Value::Integer(*id)),
            ListTarget::Role(role) => (
                "m.folder_id IN (SELECT id FROM folders WHERE role = ?1)",
                Value::Text(role.clone()),
            ),
        };
        let before = before.unwrap_or(Cursor { date: i64::MAX, id: i64::MAX });
        let sql = format!(
            "SELECT {ROW} FROM messages m WHERE {filter} AND (m.date, m.id) < (?2, ?3)
             ORDER BY m.date DESC, m.id DESC LIMIT ?4"
        );
        let conn = self.conn();
        let mut stmt = conn.prepare_cached(&sql)?;
        let rows = stmt
            .query_map(params![key, before.date, before.id, limit], row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    /// Every message in the conversation `id` belongs to, oldest first, once each.
    pub fn thread(&self, id: i64) -> Result<Vec<ThreadMessage>> {
        let conn = self.conn();
        let mut stmt = conn.prepare_cached(&format!(
            "SELECT {ROW}, m.message_id, m.to_addrs, b.text, b.html
             FROM messages m LEFT JOIN bodies b ON b.message_id = m.id
             WHERE m.account_id = (SELECT account_id FROM messages WHERE id = ?1)
               AND m.thread_id = (SELECT thread_id FROM messages WHERE id = ?1)
             GROUP BY COALESCE(m.message_id, m.id)
             ORDER BY m.date, m.id"
        ))?;
        let messages = stmt
            .query_map([id], |r| {
                Ok(ThreadMessage {
                    row: row(r)?,
                    message_id: r.get(12)?,
                    to_addrs: r.get(13)?,
                    body_text: r.get(14)?,
                    body_html: r.get(15)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(messages)
    }

    /// Full-text search over subject, sender and body. Every word is a prefix: "inv acme" finds "Invoice from ACME".
    pub fn search(&self, query: &str, limit: i64) -> Result<Vec<MessageRow>> {
        let fts = fts_query(query);
        if fts.is_empty() {
            return Ok(Vec::new());
        }
        let conn = self.conn();
        let mut stmt = conn.prepare_cached(&format!(
            "SELECT {ROW} FROM messages_fts JOIN messages m ON m.id = messages_fts.rowid
             WHERE messages_fts MATCH ?1 ORDER BY m.date DESC LIMIT ?2"
        ))?;
        let rows = stmt
            .query_map(params![fts, limit], row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    // MARK: Changes and the outbox

    /// Applies an action here at once and queues it for the server after `delay` seconds (the undo window).
    pub fn apply(&self, ids: &[i64], action: Action, delay: i64) -> Result<Applied> {
        struct Hit {
            id: i64,
            folder_id: i64,
            folder: String,
            uid: Option<u32>,
            seen: bool,
            flagged: bool,
        }

        let mut conn = self.conn();
        let tx = conn.transaction()?;
        let mut groups: BTreeMap<(i64, i64), Vec<Hit>> = BTreeMap::new();
        for id in ids {
            let hit = tx
                .query_row(
                    "SELECT m.id, m.account_id, m.folder_id, f.name, m.uid, m.seen, m.flagged
                     FROM messages m JOIN folders f ON f.id = m.folder_id WHERE m.id = ?1",
                    [id],
                    |r| {
                        Ok((
                            r.get::<_, i64>(1)?,
                            Hit {
                                id: r.get(0)?,
                                folder_id: r.get(2)?,
                                folder: r.get(3)?,
                                uid: r.get(4)?,
                                seen: r.get(5)?,
                                flagged: r.get(6)?,
                            },
                        ))
                    },
                )
                .optional()?;
            if let Some((account_id, hit)) = hit {
                groups.entry((account_id, hit.folder_id)).or_default().push(hit);
            }
        }

        let mut token = Vec::new();
        let mut accounts = BTreeSet::new();
        for ((account_id, folder_id), hits) in groups {
            let folder = hits[0].folder.clone();
            let uids: Vec<u32> = hits.iter().filter_map(|h| h.uid).collect();
            let op = match action {
                Action::MarkRead | Action::MarkUnread | Action::Star | Action::Unstar => {
                    let (column, flag, add) = match action {
                        Action::MarkRead => ("seen", "\\Seen", true),
                        Action::MarkUnread => ("seen", "\\Seen", false),
                        Action::Star => ("flagged", "\\Flagged", true),
                        _ => ("flagged", "\\Flagged", false),
                    };
                    for h in &hits {
                        tx.execute(&format!("UPDATE messages SET {column} = ?1 WHERE id = ?2"), params![add, h.id])?;
                    }
                    OutboxOp::Flags {
                        folder,
                        uids,
                        flag: flag.into(),
                        add,
                        revert: hits.iter().map(|h| (h.id, h.seen, h.flagged)).collect(),
                    }
                }
                Action::Archive | Action::Trash => {
                    // Gmail has no Archive folder: archiving there is a move to All Mail.
                    let roles = if action == Action::Archive { ["archive", "all"] } else { ["trash", "trash"] };
                    let dest: Option<(i64, String)> = tx
                        .query_row(
                            "SELECT id, name FROM folders WHERE account_id = ?1 AND role IN (?2, ?3)
                             ORDER BY role = ?2 DESC LIMIT 1",
                            params![account_id, roles[0], roles[1]],
                            |r| Ok((r.get(0)?, r.get(1)?)),
                        )
                        .optional()?;
                    let Some((dest_id, dest)) = dest else {
                        bail!("This account has no {} folder", roles[0]);
                    };
                    if dest_id == folder_id {
                        continue;
                    }
                    for h in &hits {
                        tx.execute("UPDATE messages SET folder_id = ?1, uid = NULL WHERE id = ?2", params![dest_id, h.id])?;
                    }
                    OutboxOp::Move {
                        folder,
                        dest,
                        uids,
                        revert: hits.iter().map(|h| (h.id, h.folder_id, h.uid)).collect(),
                    }
                }
            };
            token.push(enqueue(&tx, account_id, &op, delay)?);
            accounts.insert(account_id);
        }
        tx.commit()?;
        Ok(Applied { token, accounts: accounts.into_iter().collect() })
    }

    pub fn queue_send(&self, account_id: i64, draft: Draft, delay: i64) -> Result<i64> {
        enqueue(&self.conn(), account_id, &OutboxOp::Send(draft), delay)
    }

    /// Takes back what `apply` or `queue_send` did, if it has not gone to the server yet.
    pub fn undo(&self, token: &[i64]) -> Result<bool> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        let mut undone = false;
        for id in token {
            let payload: Option<String> = tx
                .query_row("SELECT payload FROM outbox WHERE id = ?1 AND claimed = 0 AND attempts = 0", [id], |r| r.get(0))
                .optional()?;
            let Some(payload) = payload else { continue };
            match serde_json::from_str::<OutboxOp>(&payload)? {
                OutboxOp::Flags { revert, .. } => {
                    for (mid, seen, flagged) in revert {
                        tx.execute("UPDATE messages SET seen = ?2, flagged = ?3 WHERE id = ?1", params![mid, seen, flagged])?;
                    }
                }
                OutboxOp::Move { revert, .. } => {
                    for (mid, folder_id, uid) in revert {
                        tx.execute("UPDATE messages SET folder_id = ?2, uid = ?3 WHERE id = ?1", params![mid, folder_id, uid])?;
                    }
                }
                OutboxOp::Send(_) => {}
            }
            tx.execute("DELETE FROM outbox WHERE id = ?1", [id])?;
            undone = true;
        }
        tx.commit()?;
        Ok(undone)
    }

    /// Takes the account's work that is due, in the order it was made. Each must end in `outbox_done` or
    /// `outbox_failed`.
    pub fn claim_due(&self, account_id: i64) -> Result<Vec<(i64, OutboxOp)>> {
        let conn = self.conn();
        let mut stmt = conn.prepare_cached(
            "UPDATE outbox SET claimed = 1 WHERE account_id = ?1 AND claimed = 0 AND not_before <= ?2
             RETURNING id, payload",
        )?;
        let mut rows = stmt
            .query_map(params![account_id, now()], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows.sort_by_key(|(id, _)| *id);
        rows.into_iter()
            .map(|(id, payload)| -> Result<(i64, OutboxOp)> { Ok((id, serde_json::from_str(&payload)?)) })
            .collect()
    }

    pub fn outbox_done(&self, id: i64) -> Result<()> {
        self.conn().execute("DELETE FROM outbox WHERE id = ?1", [id])?;
        Ok(())
    }

    /// Puts the work back, to try again later: 20 s, 40 s, … up to an hour.
    pub fn outbox_failed(&self, id: i64, error: &str) -> Result<()> {
        self.conn().execute(
            "UPDATE outbox SET claimed = 0, attempts = attempts + 1, last_error = ?2,
                               not_before = ?3 + MIN(3600, 10 << MIN(attempts + 1, 9))
             WHERE id = ?1",
            params![id, error, now()],
        )?;
        Ok(())
    }

    /// When the account's next queued work falls due.
    pub fn next_due(&self, account_id: i64) -> Result<Option<i64>> {
        Ok(self.conn().query_row(
            "SELECT MIN(not_before) FROM outbox WHERE account_id = ?1 AND claimed = 0",
            [account_id],
            |r| r.get(0),
        )?)
    }

    /// Uids in `folder` that queued work is about to change. Sync leaves these alone, so it does not undo on screen
    /// what the person just did.
    pub fn pending_uids(&self, account_id: i64, folder: &str) -> Result<HashSet<u32>> {
        let conn = self.conn();
        let mut stmt = conn.prepare_cached("SELECT payload FROM outbox WHERE account_id = ?1")?;
        let payloads = stmt
            .query_map([account_id], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut uids = HashSet::new();
        for payload in payloads {
            match serde_json::from_str::<OutboxOp>(&payload)? {
                OutboxOp::Flags { folder: f, uids: u, .. } | OutboxOp::Move { folder: f, uids: u, .. } if f == folder => {
                    uids.extend(u)
                }
                _ => {}
            }
        }
        Ok(uids)
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
    let mut stmt = conn.prepare_cached("SELECT thread_id FROM messages WHERE account_id = ?1 AND message_id = ?2 LIMIT 1")?;
    for id in &related {
        if let Some(thread) = stmt.query_row(params![account_id, id], |r| r.get::<_, String>(0)).optional()? {
            return Ok(thread);
        }
    }
    Ok(related
        .first()
        .map(|s| s.to_string())
        .or_else(|| m.message_id.clone())
        .unwrap_or_else(|| format!("uid:{folder_id}:{}", m.uid)))
}

fn fts_query(input: &str) -> String {
    input
        .split_whitespace()
        .map(|word| format!("\"{}\"*", word.replace('"', "\"\"")))
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config() -> AccountConfig {
        AccountConfig {
            email: "me@example.com".into(),
            display_name: "Me".into(),
            username: "me@example.com".into(),
            imap_host: "imap.example.com".into(),
            imap_port: 993,
            smtp_host: "smtp.example.com".into(),
            smtp_port: 465,
        }
    }

    fn message(uid: u32, subject: &str, date: i64) -> NewMessage {
        NewMessage {
            uid,
            message_id: Some(format!("{uid}@example.com")),
            subject: subject.into(),
            from_name: "Ada".into(),
            from_addr: "ada@example.com".into(),
            date,
            body_text: Some(format!("body of {subject}")),
            ..Default::default()
        }
    }

    fn setup() -> (Store, i64, i64, i64) {
        let store = Store::open_in_memory().unwrap();
        let account = store.add_account(&config()).unwrap();
        let inbox = store.upsert_folder(account.id, "INBOX", "inbox").unwrap();
        let archive = store.upsert_folder(account.id, "Archive", "archive").unwrap();
        (store, account.id, inbox, archive)
    }

    #[test]
    fn lists_pages_newest_first() {
        let (store, account, inbox, _) = setup();
        let batch: Vec<_> = (1..=5).map(|i| message(i, &format!("m{i}"), i as i64 * 100)).collect();
        store.insert_messages(account, inbox, &batch).unwrap();

        let page = store.list(&ListTarget::Folder(inbox), None, 2).unwrap();
        assert_eq!(page.iter().map(|r| r.subject.as_str()).collect::<Vec<_>>(), ["m5", "m4"]);
        let last = page.last().unwrap();
        let next = store.list(&ListTarget::Folder(inbox), Some(Cursor { date: last.date, id: last.id }), 2).unwrap();
        assert_eq!(next.iter().map(|r| r.subject.as_str()).collect::<Vec<_>>(), ["m3", "m2"]);
        assert_eq!(store.list(&ListTarget::Role("inbox".into()), None, 10).unwrap().len(), 5);
    }

    #[test]
    fn searches_by_prefix() {
        let (store, account, inbox, _) = setup();
        store
            .insert_messages(account, inbox, &[message(1, "Invoice from ACME", 1), message(2, "Lunch", 2)])
            .unwrap();
        let hits = store.search("inv acme", 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].subject, "Invoice from ACME");
        assert!(store.search("\"", 10).unwrap().is_empty());
    }

    #[test]
    fn threads_replies_that_arrive_first() {
        let (store, account, inbox, _) = setup();
        let mut reply = message(2, "Re: plan", 200);
        reply.in_reply_to = Some("1@example.com".into());
        reply.references = vec!["1@example.com".into()];
        store.insert_messages(account, inbox, &[reply]).unwrap();
        store.insert_messages(account, inbox, &[message(1, "plan", 100)]).unwrap();

        let rows = store.list(&ListTarget::Folder(inbox), None, 10).unwrap();
        assert_eq!(rows[0].thread_id, rows[1].thread_id);
        assert_eq!(store.thread(rows[0].id).unwrap().len(), 2);
    }

    #[test]
    fn archive_shows_at_once_and_undoes() {
        let (store, account, inbox, archive) = setup();
        store.insert_messages(account, inbox, &[message(1, "a", 1), message(2, "b", 2)]).unwrap();
        let id = store.list(&ListTarget::Folder(inbox), None, 10).unwrap()[0].id;

        let applied = store.apply(&[id], Action::Archive, 5).unwrap();
        assert_eq!(store.list(&ListTarget::Folder(inbox), None, 10).unwrap().len(), 1);
        assert_eq!(store.list(&ListTarget::Folder(archive), None, 10).unwrap().len(), 1);
        // Sync must not bring it back to the inbox while the move is queued.
        assert!(store.pending_uids(account, "INBOX").unwrap().contains(&2));

        assert!(store.undo(&applied.token).unwrap());
        assert_eq!(store.list(&ListTarget::Folder(inbox), None, 10).unwrap().len(), 2);
        assert!(store.pending_uids(account, "INBOX").unwrap().is_empty());
    }

    #[test]
    fn moved_message_gets_its_new_uid_from_sync() {
        let (store, account, inbox, archive) = setup();
        store.insert_messages(account, inbox, &[message(1, "a", 1)]).unwrap();
        let id = store.list(&ListTarget::Folder(inbox), None, 10).unwrap()[0].id;
        store.apply(&[id], Action::Archive, 0).unwrap();
        for (op_id, _) in store.claim_due(account).unwrap() {
            store.outbox_done(op_id).unwrap();
        }
        // The archive's sync sees the message under the uid the server gave it there.
        store.insert_messages(account, archive, &[message(40, "a", 1)].map(|mut m| {
            m.message_id = Some("1@example.com".into());
            m
        })).unwrap();
        let rows = store.list(&ListTarget::Folder(archive), None, 10).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, id);
        assert!(store.local_uids(archive).unwrap().contains(&40));
    }

    #[test]
    fn flags_apply_and_failed_work_waits() {
        let (store, account, inbox, _) = setup();
        store.insert_messages(account, inbox, &[message(1, "a", 1)]).unwrap();
        let id = store.list(&ListTarget::Folder(inbox), None, 10).unwrap()[0].id;
        store.apply(&[id], Action::MarkRead, 0).unwrap();
        assert!(store.list(&ListTarget::Folder(inbox), None, 10).unwrap()[0].seen);

        let due = store.claim_due(account).unwrap();
        assert_eq!(due.len(), 1);
        assert!(store.claim_due(account).unwrap().is_empty(), "claimed work is not handed out twice");
        store.outbox_failed(due[0].0, "offline").unwrap();
        assert!(store.next_due(account).unwrap().unwrap() > now());
    }
}
