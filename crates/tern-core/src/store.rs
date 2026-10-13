//! The database on the device. Every list, thread and search the UI shows is answered from here.

use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::path::Path;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{bail, Result};
use rusqlite::types::Value;
use rusqlite::{params, Connection, OptionalExtension, Row};

use crate::models::*;

const SCHEMA_VERSION: i64 = 4;
/// Tries before queued work stops retrying and waits for the person.
const MAX_ATTEMPTS: i64 = 5;

/// Version 1, the starting point. Later versions are steps on top of it in `migrate`, so a new database and an
/// upgraded one go through the same SQL.
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

/// Brings the database up to SCHEMA_VERSION one step at a time, each step in its own transaction together with
/// its version number, so a crash leaves the database at a whole version. Forward only.
fn migrate(conn: &Connection) -> Result<()> {
    let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    if version > SCHEMA_VERSION {
        bail!("This mail database was written by a newer Tern (schema {version}); update Tern to open it.");
    }
    for from in version..SCHEMA_VERSION {
        let step = match from {
            0 => SCHEMA,
            // Connection security per account. Existing accounts keep what Tern did before: IMAP always implicit
            // TLS, SMTP implicit TLS on 465 and STARTTLS on any other port.
            1 => {
                "ALTER TABLE accounts ADD COLUMN imap_security TEXT NOT NULL DEFAULT 'tls';
                 ALTER TABLE accounts ADD COLUMN smtp_security TEXT NOT NULL DEFAULT 'starttls';
                 UPDATE accounts SET smtp_security = 'tls' WHERE smtp_port = 465;"
            }
            // When queued work stopped retrying; NULL while it is still being tried.
            2 => "ALTER TABLE outbox ADD COLUMN gave_up_at INTEGER;",
            // Headers first: a row can exist before its body. 'none' = headers only, 'wanted' = someone opened it,
            // fetch it next, 'full' = body here. Rows from before this all have their bodies.
            3 => {
                "ALTER TABLE messages ADD COLUMN size INTEGER;
                 ALTER TABLE messages ADD COLUMN body_state TEXT NOT NULL DEFAULT 'full';
                 CREATE INDEX messages_bodyless ON messages (folder_id, date DESC) WHERE body_state != 'full';"
            }
            _ => unreachable!("no migration from schema {from}"),
        };
        conn.execute_batch(&format!("BEGIN; {step}; PRAGMA user_version = {}; COMMIT;", from + 1))?;
    }
    Ok(())
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
        migrate(&conn)?;
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
            "INSERT INTO accounts (email, display_name, username, imap_host, imap_port, imap_security,
                                   smtp_host, smtp_port, smtp_security)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                c.email,
                c.display_name,
                c.username,
                c.imap_host,
                c.imap_port,
                c.imap_security.as_str(),
                c.smtp_host,
                c.smtp_port,
                c.smtp_security.as_str()
            ],
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
            "SELECT id, email, display_name, username, imap_host, imap_port, imap_security,
                    smtp_host, smtp_port, smtp_security
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
                        imap_security: security(r, 6)?,
                        smtp_host: r.get(7)?,
                        smtp_port: r.get(8)?,
                        smtp_security: security(r, 9)?,
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
                Ok(Folder {
                    id: r.get(0)?,
                    account_id: r.get(1)?,
                    name: r.get(2)?,
                    role: r.get(3)?,
                    unread: r.get(4)?,
                })
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

    /// What the last sync left behind for a folder.
    pub fn folder_state(&self, folder_id: i64) -> Result<FolderState> {
        Ok(self.conn().query_row(
            "SELECT uid_validity, uid_next, highest_modseq FROM folders WHERE id = ?1",
            [folder_id],
            |r| Ok(FolderState { uid_validity: r.get(0)?, uid_next: r.get(1)?, highest_modseq: r.get(2)? }),
        )?)
    }

    pub fn set_folder_state(&self, folder_id: i64, state: &FolderState) -> Result<()> {
        self.conn().execute(
            "UPDATE folders SET uid_validity = ?2, uid_next = ?3, highest_modseq = ?4 WHERE id = ?1",
            params![folder_id, state.uid_validity, state.uid_next, state.highest_modseq],
        )?;
        Ok(())
    }

    /// (seen, flagged) of one message, for tests.
    #[cfg(test)]
    pub(crate) fn flags_of(&self, folder_id: i64, uid: u32) -> Option<(bool, bool)> {
        self.conn()
            .query_row(
                "SELECT seen, flagged FROM messages WHERE folder_id = ?1 AND uid = ?2",
                params![folder_id, uid],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .ok()
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
        let mut stmt =
            conn.prepare_cached("SELECT uid FROM messages WHERE folder_id = ?1 AND uid IS NOT NULL")?;
        let uids =
            stmt.query_map([folder_id], |r| r.get::<_, u32>(0))?.collect::<rusqlite::Result<HashSet<_>>>()?;
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
            let body_state = if m.headers_only { "none" } else { "full" };
            let inserted = tx.execute(
                "INSERT OR IGNORE INTO messages (account_id, folder_id, uid, message_id, thread_id, subject, from_name,
                                                 from_addr, to_addrs, date, snippet, seen, flagged, has_attachments,
                                                 size, body_state)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)",
                params![
                    account_id, folder_id, m.uid, m.message_id, thread_id, m.subject, m.from_name, m.from_addr,
                    m.to_addrs, m.date, m.snippet, m.seen, m.flagged, m.has_attachments, m.size, body_state
                ],
            )?;
            if inserted == 0 {
                continue;
            }
            let id = tx.last_insert_rowid();
            if !m.headers_only {
                tx.execute(
                    "INSERT INTO bodies (message_id, text, html) VALUES (?1, ?2, ?3)",
                    params![id, m.body_text, m.body_html],
                )?;
            }
            tx.execute(
                "INSERT INTO messages_fts (rowid, subject, from_name, from_addr, body) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![id, m.subject, m.from_name, m.from_addr, m.body_text.as_deref().unwrap_or("")],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    /// Adds bodies to rows that arrived as headers only: snippet, attachment marker, the body itself, and the body
    /// in the search index. Rows that already have a body are left alone. Returns how many were filled.
    pub fn fill_bodies(&self, folder_id: i64, messages: &[NewMessage]) -> Result<usize> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        let mut filled = 0;
        for m in messages {
            let row: Option<(i64, String, String, String)> = tx
                .query_row(
                    "SELECT id, subject, from_name, from_addr FROM messages
                     WHERE folder_id = ?1 AND uid = ?2 AND body_state != 'full'",
                    params![folder_id, m.uid],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
                )
                .optional()?;
            let Some((id, subject, from_name, from_addr)) = row else { continue };
            tx.execute(
                "UPDATE messages SET snippet = ?2, has_attachments = ?3, body_state = 'full' WHERE id = ?1",
                params![id, m.snippet, m.has_attachments],
            )?;
            tx.execute(
                "INSERT OR REPLACE INTO bodies (message_id, text, html) VALUES (?1, ?2, ?3)",
                params![id, m.body_text, m.body_html],
            )?;
            // The index is contentless: replace the headers-only entry with one that has the body.
            tx.execute("DELETE FROM messages_fts WHERE rowid = ?1", [id])?;
            tx.execute(
                "INSERT INTO messages_fts (rowid, subject, from_name, from_addr, body) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![id, subject, from_name, from_addr, m.body_text.as_deref().unwrap_or("")],
            )?;
            filled += 1;
        }
        tx.commit()?;
        Ok(filled)
    }

    /// Rows in a folder still without a body, as (uid, size): opened ones first, then the newest. Mail older than
    /// `since` is left for when it is opened.
    pub fn bodies_needed(&self, folder_id: i64, since: i64, limit: i64) -> Result<Vec<(u32, Option<u32>)>> {
        let conn = self.conn();
        let mut stmt = conn.prepare_cached(
            "SELECT uid, size FROM messages
             WHERE folder_id = ?1 AND body_state != 'full' AND uid IS NOT NULL
               AND (body_state = 'wanted' OR date >= ?2)
             ORDER BY body_state = 'wanted' DESC, date DESC LIMIT ?3",
        )?;
        let rows = stmt.query_map(params![folder_id, since, limit], |r| Ok((r.get(0)?, r.get(1)?)))?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// Folders of `account` holding messages someone opened before their body arrived.
    pub fn folders_with_wanted_bodies(&self, account_id: i64) -> Result<Vec<(i64, String)>> {
        let conn = self.conn();
        let mut stmt = conn.prepare_cached(
            "SELECT DISTINCT f.id, f.name FROM messages m JOIN folders f ON f.id = m.folder_id
             WHERE m.account_id = ?1 AND m.body_state = 'wanted'",
        )?;
        let rows = stmt.query_map([account_id], |r| Ok((r.get(0)?, r.get(1)?)))?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// Marks bodyless messages as wanted, so the sync worker fetches them before anything else. Returns the
    /// accounts to wake.
    pub fn want_bodies(&self, ids: &[i64]) -> Result<Vec<i64>> {
        let conn = self.conn();
        let mut accounts = BTreeSet::new();
        for id in ids {
            let account: Option<i64> = conn
                .query_row(
                    "UPDATE messages SET body_state = 'wanted' WHERE id = ?1 AND body_state = 'none'
                     RETURNING account_id",
                    [id],
                    |r| r.get(0),
                )
                .optional()?;
            accounts.extend(account);
        }
        Ok(accounts.into_iter().collect())
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
            ListTarget::Role(role) => {
                ("m.folder_id IN (SELECT id FROM folders WHERE role = ?1)", Value::Text(role.clone()))
            }
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
            "SELECT {ROW}, m.message_id, m.to_addrs, b.text, b.html, m.body_state = 'full'
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
                    body_loaded: r.get(16)?,
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
        let rows = stmt.query_map(params![fts, limit], row)?.collect::<rusqlite::Result<Vec<_>>>()?;
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
                        tx.execute(
                            &format!("UPDATE messages SET {column} = ?1 WHERE id = ?2"),
                            params![add, h.id],
                        )?;
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
                    let roles =
                        if action == Action::Archive { ["archive", "all"] } else { ["trash", "trash"] };
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
                        tx.execute(
                            "UPDATE messages SET folder_id = ?1, uid = NULL WHERE id = ?2",
                            params![dest_id, h.id],
                        )?;
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
                .query_row(
                    "SELECT payload FROM outbox WHERE id = ?1 AND claimed = 0 AND attempts = 0",
                    [id],
                    |r| r.get(0),
                )
                .optional()?;
            let Some(payload) = payload else { continue };
            revert(&tx, &serde_json::from_str(&payload)?)?;
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
            "UPDATE outbox SET claimed = 1
             WHERE account_id = ?1 AND claimed = 0 AND not_before <= ?2 AND gave_up_at IS NULL
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

    /// Puts the work back, to try again later: 20 s, 40 s, … up to an hour. After MAX_ATTEMPTS, or at once when
    /// the server's answer means trying again cannot help (`permanent`), it stops being tried and waits in
    /// `outbox_problems` for the person to retry or discard it. It is never dropped on its own.
    pub fn outbox_failed(&self, id: i64, error: &str, permanent: bool) -> Result<()> {
        self.conn().execute(
            "UPDATE outbox SET claimed = 0, attempts = attempts + 1, last_error = ?2,
                               not_before = ?3 + MIN(3600, 10 << MIN(attempts + 1, 9)),
                               gave_up_at = CASE WHEN ?4 OR attempts + 1 >= ?5 THEN ?3 END
             WHERE id = ?1",
            params![id, error, now(), permanent, MAX_ATTEMPTS],
        )?;
        Ok(())
    }

    /// Hands claimed but untried work back to the queue, after a pass ended early.
    pub fn release_claims(&self, account_id: i64) -> Result<()> {
        self.conn()
            .execute("UPDATE outbox SET claimed = 0 WHERE account_id = ?1 AND claimed = 1", [account_id])?;
        Ok(())
    }

    /// Work that stopped being retried, oldest first.
    pub fn outbox_problems(&self) -> Result<Vec<OutboxProblem>> {
        let conn = self.conn();
        let mut stmt = conn.prepare_cached(
            "SELECT id, account_id, payload, attempts, COALESCE(last_error, ''), gave_up_at
             FROM outbox WHERE gave_up_at IS NOT NULL ORDER BY gave_up_at, id",
        )?;
        let rows = stmt
            .query_map([], |r| {
                Ok((r.get::<_, i64>(0)?, r.get(1)?, r.get::<_, String>(2)?, r.get(3)?, r.get(4)?, r.get(5)?))
            })?
            .collect::<rusqlite::Result<Vec<(i64, i64, String, i64, String, i64)>>>()?;
        rows.into_iter()
            .map(|(id, account_id, payload, attempts, last_error, gave_up_at)| {
                let what = describe(&serde_json::from_str(&payload)?);
                Ok(OutboxProblem { id, account_id, what, attempts, last_error, gave_up_at })
            })
            .collect()
    }

    /// Tries given-up work again from the start.
    pub fn retry_outbox(&self, id: i64) -> Result<()> {
        self.conn().execute(
            "UPDATE outbox SET gave_up_at = NULL, attempts = 0, not_before = ?2, claimed = 0
             WHERE id = ?1 AND gave_up_at IS NOT NULL",
            params![id, now()],
        )?;
        Ok(())
    }

    /// Drops given-up work and puts the local store back as it was before, as undo would.
    pub fn discard_outbox(&self, id: i64) -> Result<()> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        let payload: Option<String> = tx
            .query_row("SELECT payload FROM outbox WHERE id = ?1 AND gave_up_at IS NOT NULL", [id], |r| {
                r.get(0)
            })
            .optional()?;
        if let Some(payload) = payload {
            revert(&tx, &serde_json::from_str(&payload)?)?;
            tx.execute("DELETE FROM outbox WHERE id = ?1", [id])?;
        }
        tx.commit()?;
        Ok(())
    }

    /// When the account's next queued work falls due.
    pub fn next_due(&self, account_id: i64) -> Result<Option<i64>> {
        Ok(self.conn().query_row(
            "SELECT MIN(not_before) FROM outbox WHERE account_id = ?1 AND claimed = 0 AND gave_up_at IS NULL",
            [account_id],
            |r| r.get(0),
        )?)
    }

    /// Uids in `folder` that queued work is about to change. Sync leaves these alone, so it does not undo on screen
    /// what the person just did.
    pub fn pending_uids(&self, account_id: i64, folder: &str) -> Result<HashSet<u32>> {
        let conn = self.conn();
        let mut stmt = conn.prepare_cached("SELECT payload FROM outbox WHERE account_id = ?1")?;
        let payloads =
            stmt.query_map([account_id], |r| r.get::<_, String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
        let mut uids = HashSet::new();
        for payload in payloads {
            match serde_json::from_str::<OutboxOp>(&payload)? {
                OutboxOp::Flags { folder: f, uids: u, .. } | OutboxOp::Move { folder: f, uids: u, .. }
                    if f == folder =>
                {
                    uids.extend(u)
                }
                _ => {}
            }
        }
        Ok(uids)
    }
}

/// Puts the local store back as it was before `op`.
fn revert(conn: &Connection, op: &OutboxOp) -> Result<()> {
    match op {
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
        OutboxOp::Send(_) => {}
    }
    Ok(())
}

/// A few words on what queued work does, for the problems list.
fn describe(op: &OutboxOp) -> String {
    let count = |n: usize| if n == 1 { "1 message".to_string() } else { format!("{n} messages") };
    match op {
        OutboxOp::Send(draft) => format!("Send “{}”", draft.subject),
        OutboxOp::Move { dest, uids, .. } => format!("Move {} to {dest}", count(uids.len())),
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
            imap_security: Security::Tls,
            smtp_host: "smtp.example.com".into(),
            smtp_port: 465,
            smtp_security: Security::Tls,
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
        let next =
            store.list(&ListTarget::Folder(inbox), Some(Cursor { date: last.date, id: last.id }), 2).unwrap();
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
        store
            .insert_messages(
                account,
                archive,
                &[message(40, "a", 1)].map(|mut m| {
                    m.message_id = Some("1@example.com".into());
                    m
                }),
            )
            .unwrap();
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
        store.outbox_failed(due[0].0, "offline", false).unwrap();
        assert!(store.next_due(account).unwrap().unwrap() > now());
    }

    /// Marks the inbox's one message read and returns the queued work's id.
    fn queued_mark_read(store: &Store, account: i64, inbox: i64) -> i64 {
        store.insert_messages(account, inbox, &[message(1, "a", 1)]).unwrap();
        let id = store.list(&ListTarget::Folder(inbox), None, 10).unwrap()[0].id;
        store.apply(&[id], Action::MarkRead, 0).unwrap();
        store.claim_due(account).unwrap()[0].0
    }

    #[test]
    fn a_permanent_refusal_stops_retrying_at_once() {
        let (store, account, inbox, _) = setup();
        let work = queued_mark_read(&store, account, inbox);
        store.outbox_failed(work, "550 no such mailbox", true).unwrap();
        assert_eq!(store.next_due(account).unwrap(), None, "given-up work is not scheduled");
        let problems = store.outbox_problems().unwrap();
        assert_eq!(
            (problems[0].id, problems[0].what.as_str(), problems[0].attempts),
            (work, "Mark read 1 message", 1)
        );
        assert!(problems[0].last_error.contains("550"));
    }

    #[test]
    fn transient_failures_give_up_after_max_attempts() {
        let (store, account, inbox, _) = setup();
        let work = queued_mark_read(&store, account, inbox);
        for _ in 1..MAX_ATTEMPTS {
            store.outbox_failed(work, "timed out", false).unwrap();
            assert!(store.outbox_problems().unwrap().is_empty());
        }
        store.outbox_failed(work, "timed out", false).unwrap();
        assert_eq!(store.outbox_problems().unwrap().len(), 1);
        // Never dropped: the row is still there, just no longer tried.
        let rows: i64 = store.conn().query_row("SELECT COUNT(*) FROM outbox", [], |r| r.get(0)).unwrap();
        assert_eq!(rows, 1);
    }

    #[test]
    fn retry_puts_given_up_work_back_in_the_queue() {
        let (store, account, inbox, _) = setup();
        let work = queued_mark_read(&store, account, inbox);
        store.outbox_failed(work, "550", true).unwrap();
        store.retry_outbox(work).unwrap();
        assert!(store.outbox_problems().unwrap().is_empty());
        assert_eq!(store.claim_due(account).unwrap()[0].0, work);
    }

    #[test]
    fn discard_drops_given_up_work_and_reverts_the_local_change() {
        let (store, account, inbox, _) = setup();
        let work = queued_mark_read(&store, account, inbox);
        store.outbox_failed(work, "550", true).unwrap();
        store.discard_outbox(work).unwrap();
        assert!(store.outbox_problems().unwrap().is_empty());
        assert!(!store.list(&ListTarget::Folder(inbox), None, 10).unwrap()[0].seen, "back to unread");
        assert!(store.pending_uids(account, "INBOX").unwrap().is_empty(), "sync may update it again");
    }

    #[test]
    fn released_claims_are_handed_out_again() {
        let (store, account, inbox, _) = setup();
        let work = queued_mark_read(&store, account, inbox);
        store.release_claims(account).unwrap();
        assert_eq!(store.claim_due(account).unwrap()[0].0, work);
    }

    /// A database as Tern wrote it before connection security was stored (schema 1).
    fn schema_1_with_accounts() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(SCHEMA).unwrap();
        conn.execute_batch(
            "PRAGMA user_version = 1;
             INSERT INTO accounts (email, username, imap_host, imap_port, smtp_host, smtp_port)
             VALUES ('a@x', 'a@x', 'imap.x', 993, 'smtp.x', 465), ('b@x', 'b@x', 'imap.x', 993, 'smtp.x', 587);",
        )
        .unwrap();
        conn
    }

    #[test]
    fn migration_3_leaves_existing_work_queued() {
        let conn = schema_1_with_accounts();
        conn.execute(
            "INSERT INTO outbox (account_id, payload, not_before) VALUES (1, '{\"kind\":\"send\",\"to\":[],\"subject\":\"s\",\"body\":\"\"}', 0)",
            [],
        )
        .unwrap();
        let store = Store::init(conn).unwrap();
        assert_eq!(store.claim_due(1).unwrap().len(), 1);
        assert!(store.outbox_problems().unwrap().is_empty());
    }

    #[test]
    fn migration_2_keeps_what_existing_accounts_did() {
        let store = Store::init(schema_1_with_accounts()).unwrap();
        let accounts = store.accounts().unwrap();
        let modes: Vec<_> = accounts
            .iter()
            .map(|a| (a.config.smtp_port, a.config.imap_security, a.config.smtp_security))
            .collect();
        assert_eq!(modes, [(465, Security::Tls, Security::Tls), (587, Security::Tls, Security::Starttls)]);
        let version: i64 = store.conn().query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
        assert_eq!(version, SCHEMA_VERSION);
    }

    #[test]
    fn new_and_migrated_databases_have_the_same_accounts_table() {
        let columns = |store: &Store| -> Vec<String> {
            let conn = store.conn();
            let mut stmt =
                conn.prepare("SELECT name FROM pragma_table_info('accounts') ORDER BY cid").unwrap();
            stmt.query_map([], |r| r.get(0)).unwrap().collect::<rusqlite::Result<_>>().unwrap()
        };
        let fresh = Store::open_in_memory().unwrap();
        let migrated = Store::init(schema_1_with_accounts()).unwrap();
        assert_eq!(columns(&fresh), columns(&migrated));
    }

    #[test]
    fn refuses_a_database_from_a_newer_tern() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(&format!("PRAGMA user_version = {}", SCHEMA_VERSION + 1)).unwrap();
        let err = Store::init(conn).err().unwrap();
        assert!(err.to_string().contains("newer Tern"));
    }

    #[test]
    fn security_round_trips_through_the_store() {
        let store = Store::open_in_memory().unwrap();
        let mut c = config();
        c.smtp_port = 1465;
        c.smtp_security = Security::Tls;
        c.imap_security = Security::Starttls;
        store.add_account(&c).unwrap();
        let back = &store.accounts().unwrap()[0].config;
        assert_eq!(
            (back.imap_security, back.smtp_port, back.smtp_security),
            (Security::Starttls, 1465, Security::Tls)
        );
    }

    fn headers_only(uid: u32, subject: &str, date: i64) -> NewMessage {
        NewMessage {
            body_text: None,
            size: Some(1000 * uid),
            headers_only: true,
            ..message(uid, subject, date)
        }
    }

    #[test]
    fn headers_show_in_the_list_before_the_body() {
        let (store, account, inbox, _) = setup();
        store.insert_messages(account, inbox, &[headers_only(1, "Lunch?", now())]).unwrap();
        let rows = store.list(&ListTarget::Folder(inbox), None, 10).unwrap();
        assert_eq!((rows[0].subject.as_str(), rows[0].snippet.as_str()), ("Lunch?", ""));
        assert!(!store.thread(rows[0].id).unwrap()[0].body_loaded);
        assert_eq!(store.search("lunch", 10).unwrap().len(), 1, "headers are searchable at once");
    }

    #[test]
    fn filling_a_body_adds_snippet_and_search_text() {
        let (store, account, inbox, _) = setup();
        store.insert_messages(account, inbox, &[headers_only(1, "Lunch?", now())]).unwrap();
        let full = NewMessage {
            snippet: "Shall we try the new place".into(),
            body_text: Some("Shall we try the new place on Friday".into()),
            has_attachments: true,
            ..message(1, "ignored: the row keeps its header subject", now())
        };
        assert_eq!(store.fill_bodies(inbox, std::slice::from_ref(&full)).unwrap(), 1);
        assert_eq!(store.fill_bodies(inbox, &[full]).unwrap(), 0, "a full row is not filled twice");

        let row = &store.list(&ListTarget::Folder(inbox), None, 10).unwrap()[0];
        assert_eq!(
            (row.subject.as_str(), row.snippet.as_str(), row.has_attachments),
            ("Lunch?", "Shall we try the new place", true)
        );
        let thread = store.thread(row.id).unwrap();
        assert!(thread[0].body_loaded);
        assert_eq!(thread[0].body_text.as_deref(), Some("Shall we try the new place on Friday"));
        assert_eq!(store.search("friday", 10).unwrap().len(), 1, "the body is in the index now");
        assert_eq!(store.search("lunch", 10).unwrap().len(), 1, "and the headers still are");
    }

    #[test]
    fn bodies_needed_puts_opened_mail_first_then_the_newest() {
        let (store, account, inbox, _) = setup();
        let day = 86_400;
        store
            .insert_messages(
                account,
                inbox,
                &[
                    headers_only(1, "old", now() - 400 * day),
                    headers_only(2, "recent", now() - day),
                    headers_only(3, "newest", now()),
                ],
            )
            .unwrap();
        let since = now() - 90 * day;
        assert_eq!(
            store.bodies_needed(inbox, since, 10).unwrap(),
            [(3, Some(3000)), (2, Some(2000))],
            "old mail waits"
        );

        let old = store
            .list(&ListTarget::Folder(inbox), None, 10)
            .unwrap()
            .into_iter()
            .find(|r| r.subject == "old")
            .unwrap();
        assert_eq!(store.want_bodies(&[old.id]).unwrap(), [account]);
        assert_eq!(store.bodies_needed(inbox, since, 10).unwrap()[0].0, 1, "opened mail jumps the queue");
        assert_eq!(store.folders_with_wanted_bodies(account).unwrap(), [(inbox, "INBOX".to_string())]);
        assert_eq!(store.bodies_needed(inbox, i64::MAX, 10).unwrap(), [(1, Some(1000))], "only opened mail");
    }

    #[test]
    fn want_bodies_ignores_messages_that_have_theirs() {
        let (store, account, inbox, _) = setup();
        store.insert_messages(account, inbox, &[message(1, "full", now())]).unwrap();
        let id = store.list(&ListTarget::Folder(inbox), None, 10).unwrap()[0].id;
        assert!(store.want_bodies(&[id]).unwrap().is_empty());
    }

    #[test]
    fn migration_4_counts_existing_messages_as_complete() {
        let conn = schema_1_with_accounts();
        conn.execute_batch(
            "INSERT INTO folders (account_id, name, role) VALUES (1, 'INBOX', 'inbox');
             INSERT INTO messages (account_id, folder_id, uid, thread_id, date) VALUES (1, 1, 7, 't', 1);
             INSERT INTO bodies (message_id, text) VALUES (1, 'hello');",
        )
        .unwrap();
        let store = Store::init(conn).unwrap();
        assert!(store.thread(1).unwrap()[0].body_loaded);
        assert!(store.bodies_needed(1, 0, 10).unwrap().is_empty());
    }
}
