//! The database on the device. Every list, thread and search the UI shows is answered from here.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::path::Path;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{bail, Result};
use rusqlite::types::Value;
use rusqlite::{params, Connection, OptionalExtension, Row};

use crate::models::*;

const SCHEMA_VERSION: i64 = 17;
/// Seconds a draft rests after its last change before its server copy is replaced, and that a discarded one waits
/// (for Undo) before its server copy goes.
const DRAFT_REST: i64 = 30;
/// Messages with the same normalised subject and a participant in common within this many seconds of each other
/// join one conversation when nothing in their headers links them.
const SUBJECT_WINDOW: i64 = 7 * 86_400;
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
            // Text-only mail was stored with the HTML mail-parser makes from it, which the reader shows on white.
            // Drop exactly that generated HTML; anything a sender wrote stays.
            4 => {
                "UPDATE bodies SET html = NULL WHERE text IS NOT NULL AND html = '<html><body>' ||
                   replace(replace(replace(text, char(13), ''), '<', '&lt;'), char(10), '<br/>') || '</body></html>';"
            }
            // A send that broke off after the message was handed over, so it may have gone out.
            5 => "ALTER TABLE outbox ADD COLUMN maybe_sent INTEGER NOT NULL DEFAULT 0;",
            // From the header fetch: mailing-list headers and the parts (BODYSTRUCTURE as JSON). body_state gains
            // 'snippet': headers plus a snippet read from the text part alone, full body still to come.
            6 => {
                "ALTER TABLE messages ADD COLUMN list_id TEXT;
                 ALTER TABLE messages ADD COLUMN list_unsubscribe TEXT;
                 ALTER TABLE messages ADD COLUMN parts TEXT;"
            }
            // Threading by subject: the normalised subject, filled in for existing rows below.
            7 => {
                "ALTER TABLE messages ADD COLUMN subject_norm TEXT;
                 CREATE INDEX messages_subject ON messages (account_id, subject_norm, date)
                     WHERE subject_norm IS NOT NULL;"
            }
            // The person's settings: one row per key, the value as JSON.
            8 => "CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);",
            // Mail HTML is sanitised when stored from now on; the step cleans what is already there (below).
            9 => "",
            // Muted conversations: new mail in them skips the inbox.
            // People mail goes to and comes from, for recipient autocomplete; filled from existing mail below.
            13 => {
                "CREATE TABLE contacts (
                     email TEXT PRIMARY KEY COLLATE NOCASE,
                     name TEXT NOT NULL DEFAULT '',
                     sent_count INTEGER NOT NULL DEFAULT 0,
                     received_count INTEGER NOT NULL DEFAULT 0,
                     last_seen INTEGER NOT NULL DEFAULT 0
                 );
                 CREATE INDEX contacts_name ON contacts (name COLLATE NOCASE);"
            }
            // Drafts being written: the payload is the Draft JSON; `message_id` (bare) ties it to its row in the
            // Drafts folder and to its copy on the server (`server_*`, each save bumps `version`; the version on
            // the server is `synced_version`).
            12 => {
                "CREATE TABLE drafts (
                     id INTEGER PRIMARY KEY,
                     account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
                     message_id TEXT NOT NULL,
                     payload TEXT NOT NULL,
                     updated_at INTEGER NOT NULL,
                     version INTEGER NOT NULL DEFAULT 1,
                     upload_now INTEGER NOT NULL DEFAULT 0,
                     synced_version INTEGER,
                     server_folder TEXT,
                     server_validity INTEGER,
                     server_uid INTEGER,
                     discarded_at INTEGER,
                     sent_at INTEGER
                 );
                 CREATE INDEX drafts_message ON drafts (account_id, message_id);"
            }
            // What replies need from the original: its Cc, Reply-To, Mail-Followup-To and References.
            11 => {
                "ALTER TABLE messages ADD COLUMN cc_addrs TEXT NOT NULL DEFAULT '';
                 ALTER TABLE messages ADD COLUMN reply_to TEXT NOT NULL DEFAULT '';
                 ALTER TABLE messages ADD COLUMN followup_to TEXT NOT NULL DEFAULT '';
                 ALTER TABLE messages ADD COLUMN refs TEXT NOT NULL DEFAULT '';"
            }
            // Mail downloaded whole before step 6 kept its attachment flag but has no `parts`, so the conversation
            // listed none of its files and none could be opened. Fetching the body again fills `parts` in.
            14 => {
                "UPDATE messages SET body_state = 'wanted'
                 WHERE body_state = 'full' AND parts IS NULL AND has_attachments = 1 AND uid IS NOT NULL;"
            }
            // Triage: which split a message lands in (filled in below for mail already here), the senders the
            // person moved to the other split, and snoozed conversations until they are due.
            15 => {
                "ALTER TABLE messages ADD COLUMN bulk INTEGER NOT NULL DEFAULT 0;
                 CREATE TABLE sender_splits (account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
                                             addr TEXT NOT NULL, other INTEGER NOT NULL,
                                             PRIMARY KEY (account_id, addr));
                 CREATE TABLE reminders (account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
                                         thread_id TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'snooze',
                                         due INTEGER NOT NULL, created INTEGER NOT NULL,
                                         PRIMARY KEY (account_id, thread_id, kind));"
            }
            // Search walks this newest first when a word matches much of the mailbox, instead of sorting every
            // match. Snippets are saved replies, typed after `;` in compose.
            16 => {
                "CREATE INDEX messages_date ON messages (date DESC, id DESC);
                 CREATE TABLE snippets (id INTEGER PRIMARY KEY, shortcut TEXT NOT NULL UNIQUE COLLATE NOCASE,
                                        name TEXT NOT NULL DEFAULT '', body TEXT NOT NULL DEFAULT '',
                                        used INTEGER NOT NULL DEFAULT 0);"
            }
            10 => "CREATE TABLE muted (account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
                                       thread_id TEXT NOT NULL, PRIMARY KEY (account_id, thread_id));",
            _ => unreachable!("no migration from schema {from}"),
        };
        conn.execute_batch(&format!("BEGIN; {step};"))?;
        if from == 7 {
            fill_subject_norm(conn)?;
        }
        if from == 9 {
            sanitize_stored_html(conn)?;
        }
        if from == 13 {
            fill_contacts(conn)?;
        }
        if from == 15 {
            fill_bulk(conn)?;
        }
        conn.execute_batch(&format!("PRAGMA user_version = {}; COMMIT;", from + 1))?;
    }
    Ok(())
}

/// Marks the mail already stored that goes to Other, as `insert_messages` does from now on. Precedence was not
/// kept, so this goes by the list headers and the sender.
fn fill_bulk(conn: &Connection) -> Result<()> {
    let rows: Vec<(i64, NewMessage)> = conn
        .prepare("SELECT id, from_addr, list_id, list_unsubscribe FROM messages")?
        .query_map([], |r| {
            Ok((
                r.get(0)?,
                NewMessage {
                    from_addr: r.get(1)?,
                    list_id: r.get(2)?,
                    list_unsubscribe: r.get(3)?,
                    ..Default::default()
                },
            ))
        })?
        .collect::<rusqlite::Result<_>>()?;
    let mut mark = conn.prepare("UPDATE messages SET bulk = 1 WHERE id = ?1")?;
    for (id, m) in rows {
        if crate::triage::is_bulk(&m) {
            mark.execute([id])?;
        }
    }
    Ok(())
}

/// Counts the people in the mail already stored, as `insert_messages` does from now on.
fn fill_contacts(conn: &Connection) -> Result<()> {
    let rows: Vec<(String, NewMessage)> = conn
        .prepare(
            "SELECT lower(a.email), m.from_name, m.from_addr, m.to_addrs, m.cc_addrs, m.date
             FROM messages m JOIN accounts a ON a.id = m.account_id",
        )?
        .query_map([], |r| {
            Ok((
                r.get(0)?,
                NewMessage {
                    from_name: r.get(1)?,
                    from_addr: r.get(2)?,
                    to_addrs: r.get(3)?,
                    cc_addrs: r.get(4)?,
                    date: r.get(5)?,
                    ..Default::default()
                },
            ))
        })?
        .collect::<rusqlite::Result<_>>()?;
    for (me, m) in rows {
        note_people(conn, &me, &m)?;
    }
    Ok(())
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

fn sanitize_stored_html(conn: &Connection) -> Result<()> {
    let rows: Vec<(i64, String)> = conn
        .prepare("SELECT message_id, html FROM bodies WHERE html IS NOT NULL")?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    let mut update = conn.prepare("UPDATE bodies SET html = ?2 WHERE message_id = ?1")?;
    for (id, html) in rows {
        update.execute(params![id, crate::mime::sanitize_html(&html)])?;
    }
    Ok(())
}

fn fill_subject_norm(conn: &Connection) -> Result<()> {
    let rows: Vec<(i64, String)> = conn
        .prepare("SELECT id, subject FROM messages")?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    let mut update = conn.prepare("UPDATE messages SET subject_norm = ?2 WHERE id = ?1")?;
    for (id, subject) in rows {
        update.execute(params![id, subject_norm(&subject)])?;
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

/// The message goes to Other: its sender was moved there, or (with no choice made) it is bulk mail.
const IS_OTHER: &str = "COALESCE((SELECT s.other FROM sender_splits s
                                  WHERE s.account_id = m.account_id AND s.addr = lower(m.from_addr)), m.bulk)";
/// Its conversation is snoozed.
const IS_SNOOZED: &str = "EXISTS (SELECT 1 FROM reminders r
                                 WHERE r.account_id = m.account_id AND r.thread_id = m.thread_id AND r.kind = 'snooze')";

fn target_filter(target: &ListTarget, n: u8) -> (String, Value) {
    let inbox = format!("m.folder_id IN (SELECT id FROM folders WHERE role = ?{n})");
    let role = match target {
        ListTarget::Folder(id) => return (format!("m.folder_id = ?{n}"), Value::Integer(*id)),
        ListTarget::Role(role) => role.as_str(),
    };
    // Snoozed conversations stay in the inbox folder (snoozing is Tern's alone) but out of its lists.
    let filter = match role {
        "inbox" => format!("{inbox} AND NOT {IS_SNOOZED}"),
        STARRED => format!("m.flagged AND {inbox} AND NOT {IS_SNOOZED}"),
        IMPORTANT => format!("{inbox} AND NOT {IS_SNOOZED} AND NOT {IS_OTHER}"),
        OTHER => format!("{inbox} AND NOT {IS_SNOOZED} AND {IS_OTHER}"),
        SNOOZED => format!("{inbox} AND {IS_SNOOZED}"),
        _ => return (inbox, Value::Text(role.into())),
    };
    (filter, Value::Text("inbox".into()))
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
        // Work claimed by a run that did not finish is free to go again, except a send that had started: it may
        // have gone out, so it waits for the person (claimed = 2, see `outbox_sending`).
        conn.execute("UPDATE outbox SET claimed = 0 WHERE claimed = 1", [])?;
        conn.execute(
            "UPDATE outbox SET claimed = 0, maybe_sent = 1, gave_up_at = ?1, attempts = attempts + 1,
                               last_error = 'Tern stopped while sending this, so it may have been sent'
             WHERE claimed = 2",
            [now()],
        )?;
        Ok(Self { conn: Mutex::new(conn) })
    }

    fn conn(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.conn.lock().unwrap_or_else(|e| e.into_inner())
    }

    // MARK: Settings

    /// Every setting the person changed; the UI knows the defaults for the rest.
    pub fn settings(&self) -> Result<HashMap<String, serde_json::Value>> {
        let conn = self.conn();
        let mut stmt = conn.prepare_cached("SELECT key, value FROM settings")?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        let mut out = HashMap::new();
        for row in rows {
            let (key, value) = row?;
            out.insert(key, serde_json::from_str(&value)?);
        }
        Ok(out)
    }

    pub fn set_setting(&self, key: &str, value: &serde_json::Value) -> Result<()> {
        self.conn().execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2)
             ON CONFLICT (key) DO UPDATE SET value = excluded.value",
            params![key, value.to_string()],
        )?;
        Ok(())
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

    /// Drops the account's folders that are not in `listed` (the server's LIST), with their messages: the folder
    /// was deleted or renamed elsewhere. A folder queued work (other than a sent copy) or a draft still names is
    /// kept, as is one holding a
    /// message not yet on the server (uid NULL); they go once that work is done. Returns the names dropped.
    pub fn forget_folders(&self, account_id: i64, listed: &HashSet<String>) -> Result<Vec<String>> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        let mut named: HashSet<String> = HashSet::new();
        {
            let mut stmt = tx.prepare("SELECT payload FROM outbox WHERE account_id = ?1")?;
            for payload in stmt.query_map([account_id], |r| r.get::<_, String>(0))? {
                match serde_json::from_str::<OutboxOp>(&payload?)? {
                    OutboxOp::Flags { folder, .. } => {
                        named.insert(folder);
                    }
                    // A sent copy goes to whichever folder is Sent when it goes out (see sync::run_op).
                    OutboxOp::Append { .. } => {}
                    OutboxOp::Move { folder, dest, .. } => named.extend([folder, dest]),
                    OutboxOp::Send(draft) => named.extend(draft.forward_of.map(|f| f.folder)),
                }
            }
            let mut stmt = tx.prepare(
                "SELECT server_folder FROM drafts WHERE account_id = ?1 AND server_folder IS NOT NULL",
            )?;
            for folder in stmt.query_map([account_id], |r| r.get::<_, String>(0))? {
                named.insert(folder?);
            }
        }
        let stale: Vec<(i64, String)> = {
            let mut stmt = tx.prepare(
                "SELECT id, name FROM folders f WHERE account_id = ?1
                   AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.folder_id = f.id AND m.uid IS NULL)",
            )?;
            let rows = stmt.query_map([account_id], |r| Ok((r.get(0)?, r.get(1)?)))?;
            rows.collect::<rusqlite::Result<Vec<(i64, String)>>>()?
                .into_iter()
                .filter(|(_, name)| !listed.contains(name) && !named.contains(name))
                .collect()
        };
        for (id, _) in &stale {
            // Messages first, so the search index's delete trigger runs for each.
            tx.execute("DELETE FROM messages WHERE folder_id = ?1", [id])?;
            tx.execute("DELETE FROM folders WHERE id = ?1", [id])?;
        }
        tx.commit()?;
        Ok(stale.into_iter().map(|(_, name)| name).collect())
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

    /// The server renumbered the folder (UIDVALIDITY changed): forget what we know of it. Messages queued work
    /// is about to change stay, without a uid, so what the person did still shows; the folder's next sync finds
    /// them again by Message-ID, and the queued work finds them on the server the same way.
    pub fn reset_folder(&self, folder_id: i64) -> Result<()> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        let account_id: i64 =
            tx.query_row("SELECT account_id FROM folders WHERE id = ?1", [folder_id], |r| r.get(0))?;
        let mut keep = HashSet::new();
        for op in queued(&tx, account_id)? {
            match op {
                OutboxOp::Flags { revert, .. } => keep.extend(revert.iter().map(|r| r.0)),
                OutboxOp::Move { revert, .. } => keep.extend(revert.iter().map(|r| r.0)),
                OutboxOp::Send(_) | OutboxOp::Append { .. } => {}
            }
        }
        for id in &keep {
            tx.execute(
                "UPDATE messages SET uid = NULL WHERE id = ?1 AND folder_id = ?2",
                params![id, folder_id],
            )?;
        }
        tx.execute("DELETE FROM messages WHERE folder_id = ?1 AND uid IS NOT NULL", [folder_id])?;
        tx.execute(
            "UPDATE folders SET uid_validity = NULL, uid_next = NULL, highest_modseq = NULL WHERE id = ?1",
            [folder_id],
        )?;
        tx.commit()?;
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
        let me: String =
            tx.query_row("SELECT lower(email) FROM accounts WHERE id = ?1", [account_id], |r| r.get(0))?;
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
            let parts = m.parts.as_ref().map(serde_json::to_string).transpose()?;
            let inserted = tx.execute(
                "INSERT OR IGNORE INTO messages (account_id, folder_id, uid, message_id, thread_id, subject, from_name,
                                                 from_addr, to_addrs, date, snippet, seen, flagged, has_attachments,
                                                 size, body_state, list_id, list_unsubscribe, parts, subject_norm,
                                                 cc_addrs, reply_to, followup_to, refs, bulk)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20,
                         ?21, ?22, ?23, ?24, ?25)",
                params![
                    account_id, folder_id, m.uid, m.message_id, thread_id, m.subject, m.from_name, m.from_addr,
                    m.to_addrs, m.date, m.snippet, m.seen, m.flagged, m.has_attachments, m.size, body_state,
                    m.list_id, m.list_unsubscribe, parts, subject_norm(&m.subject), m.cc_addrs, m.reply_to,
                    m.followup_to, m.references.join(" "), crate::triage::is_bulk(m)
                ],
            )?;
            if inserted == 0 {
                continue;
            }
            let id = tx.last_insert_rowid();
            // After reading the row id: this inserts too.
            note_people(&tx, &me, m)?;
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
                "UPDATE messages SET snippet = ?2, body_state = 'full',
                        -- BODYSTRUCTURE's answer, where there was one, is the one the list has shown all along.
                        has_attachments = CASE WHEN parts IS NULL THEN ?3 ELSE has_attachments END,
                        parts = COALESCE(parts, ?4)
                 WHERE id = ?1",
                params![id, m.snippet, m.has_attachments, m.parts.as_ref().map(serde_json::to_string).transpose()?],
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
    /// Headers-only rows that still need a snippet, newest first: (uid, the part to read it from). Rows whose parts
    /// have no text are given an empty snippet here and not asked about again.
    pub fn snippets_needed(&self, folder_id: i64, limit: i64) -> Result<Vec<(u32, Part)>> {
        let conn = self.conn();
        let rows: Vec<(u32, String)> = conn
            .prepare_cached(
                "SELECT uid, parts FROM messages
                 WHERE folder_id = ?1 AND body_state = 'none' AND parts IS NOT NULL AND uid IS NOT NULL
                 ORDER BY date DESC LIMIT ?2",
            )?
            .query_map(params![folder_id, limit], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<rusqlite::Result<_>>()?;
        let mut out = Vec::new();
        for (uid, parts) in rows {
            let parts: Vec<Part> = serde_json::from_str(&parts)?;
            match Part::text_part(&parts) {
                Some(part) => out.push((uid, part.clone())),
                None => {
                    conn.execute(
                        "UPDATE messages SET body_state = 'snippet' WHERE folder_id = ?1 AND uid = ?2",
                        params![folder_id, uid],
                    )?;
                }
            }
        }
        Ok(out)
    }

    /// Stores snippets read from text parts: (uid, snippet). Rows that got their body meanwhile are left alone.
    pub fn set_snippets(&self, folder_id: i64, snippets: &[(u32, String)]) -> Result<()> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        for (uid, snippet) in snippets {
            tx.execute(
                "UPDATE messages SET snippet = ?3, body_state = 'snippet'
                 WHERE folder_id = ?1 AND uid = ?2 AND body_state = 'none'",
                params![folder_id, uid, snippet],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

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
                    "UPDATE messages SET body_state = 'wanted' WHERE id = ?1 AND body_state IN ('none', 'snippet')
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
        let (filter, key) = target_filter(target, 1);
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
    /// A page of conversations with a message in `target`, newest first by their newest message there. `before` is
    /// the newest message's (date, id) of the last conversation on the previous page.
    ///
    /// Computed from the messages, not kept in a table: the folder is walked newest first (the list index) until
    /// `limit` conversations are found, and each is summed up through the thread index. Nothing to keep in step
    /// when a message moves or changes flags, and a page costs well under a millisecond (`store_bench`).
    pub fn list_threads(
        &self,
        target: &ListTarget,
        before: Option<Cursor>,
        limit: usize,
    ) -> Result<Vec<ThreadRow>> {
        let (filter, key) = target_filter(target, 1);
        let cursor = before.unwrap_or(Cursor { date: i64::MAX, id: i64::MAX });
        let conn = self.conn();
        let mut scan = conn.prepare_cached(&format!(
            "SELECT {ROW} FROM messages m WHERE {filter} AND (m.date, m.id) < (?2, ?3)
             ORDER BY m.date DESC, m.id DESC LIMIT ?4"
        ))?;
        // A conversation already shown on an earlier page has a newer message here than the cursor.
        let mut shown = conn.prepare_cached(&format!(
            "SELECT EXISTS (SELECT 1 FROM messages m WHERE {filter} AND m.account_id = ?2 AND m.thread_id = ?3
                            AND (m.date, m.id) >= (?4, ?5))"
        ))?;
        let mut sums = conn.prepare_cached(
            "SELECT count(DISTINCT COALESCE(message_id, id)), count(*) FILTER (WHERE NOT seen), max(flagged)
             FROM messages WHERE account_id = ?1 AND thread_id = ?2",
        )?;
        let mut senders = conn.prepare_cached(
            "SELECT m.from_name, m.from_addr, lower(m.from_addr) = lower(a.email)
             FROM messages m JOIN accounts a ON a.id = m.account_id
             WHERE m.account_id = ?1 AND m.thread_id = ?2 ORDER BY m.date, m.id",
        )?;
        let mut snoozed = conn.prepare_cached(
            "SELECT due FROM reminders WHERE account_id = ?1 AND thread_id = ?2 AND kind = 'snooze'",
        )?;
        let mut seen = HashSet::new();
        let mut out = Vec::new();
        // The scan goes in pages with a LIMIT: across several folders (a role) SQLite sorts what it finds, and
        // without a limit it would sort the whole inbox before the first row.
        let chunk = (limit * 4).max(100);
        let mut at = cursor;
        let mut page: Vec<MessageRow> = Vec::new();
        let mut exhausted = false;
        while out.len() < limit {
            if page.is_empty() {
                if exhausted {
                    break;
                }
                page = scan
                    .query_map(params![key, at.date, at.id, chunk as i64], row)?
                    .collect::<rusqlite::Result<_>>()?;
                exhausted = page.len() < chunk;
                page.reverse();
                continue;
            }
            let latest = page.pop().expect("a row");
            at = Cursor { date: latest.date, id: latest.id };
            if !seen.insert((latest.account_id, latest.thread_id.clone())) {
                continue;
            }
            if before.is_some()
                && shown.query_row(
                    params![key, latest.account_id, latest.thread_id, cursor.date, cursor.id],
                    |r| r.get::<_, bool>(0),
                )?
            {
                continue;
            }
            let (count, unread, flagged): (i64, i64, bool) = sums
                .query_row(params![latest.account_id, latest.thread_id], |r| {
                    Ok((r.get(0)?, r.get(1)?, r.get(2)?))
                })?;
            let mut participants: Vec<String> = Vec::new();
            for who in senders.query_map(params![latest.account_id, latest.thread_id], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, bool>(2)?))
            })? {
                let (name, addr, mine) = who?;
                let who = if mine {
                    "me".to_string()
                } else if name.is_empty() {
                    addr
                } else {
                    name
                };
                if participants.len() < 4 && !participants.contains(&who) {
                    participants.push(who);
                }
            }
            let snoozed_until =
                snoozed.query_row(params![latest.account_id, latest.thread_id], |r| r.get(0)).optional()?;
            out.push(ThreadRow { latest, count, unread, flagged, participants, snoozed_until });
        }
        Ok(out)
    }

    /// Mutes the conversations of these messages: they leave the inbox now (see `apply`), and mail that arrives in
    /// them later skips it (`archive_muted`).
    pub fn mute(&self, ids: &[i64], mute: bool) -> Result<()> {
        let conn = self.conn();
        for id in ids {
            let sql = if mute {
                "INSERT OR IGNORE INTO muted (account_id, thread_id) SELECT account_id, thread_id FROM messages WHERE id = ?1"
            } else {
                "DELETE FROM muted WHERE (account_id, thread_id) = (SELECT account_id, thread_id FROM messages WHERE id = ?1)"
            };
            conn.execute(sql, [id])?;
        }
        Ok(())
    }

    /// Whether the conversation of this message is muted.
    pub fn muted(&self, id: i64) -> Result<bool> {
        Ok(self.conn().query_row(
            "SELECT EXISTS (SELECT 1 FROM muted u JOIN messages m USING (account_id, thread_id) WHERE m.id = ?1)",
            [id],
            |r| r.get(0),
        )?)
    }

    /// Mail worth a notification: unread, in an inbox's Important split (or Other too, with `other`), newer than
    /// `after` (a message id) and dated from `since` on (older mail arriving during a first sync or a backfill is
    /// not news). Mail from the account's own address, snoozed and muted conversations are left out. Also returns
    /// the newest message id, for the next `after`.
    pub fn new_mail(&self, after: i64, since: i64, other: bool) -> Result<(i64, Vec<NewMail>)> {
        let conn = self.conn();
        let newest: i64 = conn.query_row("SELECT COALESCE(max(id), 0) FROM messages", [], |r| r.get(0))?;
        let mut stmt = conn.prepare_cached(&format!(
            "SELECT m.id, m.account_id, m.thread_id, m.from_name, m.from_addr, m.subject, m.snippet
             FROM messages m JOIN folders f ON f.id = m.folder_id JOIN accounts a ON a.id = m.account_id
             WHERE m.id > ?1 AND m.id <= ?3 AND m.date >= ?2 AND f.role = 'inbox' AND NOT m.seen
               AND lower(m.from_addr) <> lower(a.email)
               AND NOT EXISTS (SELECT 1 FROM muted u WHERE u.account_id = m.account_id AND u.thread_id = m.thread_id)
               AND (?4 OR NOT {IS_OTHER}) AND NOT {IS_SNOOZED}
             ORDER BY m.id"
        ))?;
        let mail = stmt
            .query_map(params![after, since, newest, other], |r| {
                Ok(NewMail {
                    id: r.get(0)?,
                    account_id: r.get(1)?,
                    thread_id: r.get(2)?,
                    from_name: r.get(3)?,
                    from_addr: r.get(4)?,
                    subject: r.get(5)?,
                    snippet: r.get(6)?,
                })
            })?
            .collect::<rusqlite::Result<_>>()?;
        Ok((newest, mail))
    }

    /// Moves the senders of these messages to Other (or to Important): their mail, past and future, lands there.
    pub fn set_split(&self, ids: &[i64], other: bool) -> Result<()> {
        let conn = self.conn();
        let mut stmt = conn.prepare_cached(
            "INSERT INTO sender_splits (account_id, addr, other)
             SELECT account_id, lower(from_addr), ?2 FROM messages WHERE id = ?1 AND from_addr <> ''
             ON CONFLICT (account_id, addr) DO UPDATE SET other = excluded.other",
        )?;
        for id in ids {
            stmt.execute(params![id, other])?;
        }
        Ok(())
    }

    /// Snoozes the conversations of these messages until `due`: they leave the inbox's lists (not its folder,
    /// so other mail apps still show them there) and come back unread when due, or when someone replies.
    pub fn snooze(&self, ids: &[i64], due: i64, now: i64) -> Result<()> {
        let conn = self.conn();
        let mut stmt = conn.prepare_cached(
            "INSERT INTO reminders (account_id, thread_id, kind, due, created)
             SELECT account_id, thread_id, 'snooze', ?2, ?3 FROM messages WHERE id = ?1
             ON CONFLICT (account_id, thread_id, kind) DO UPDATE SET due = excluded.due, created = excluded.created",
        )?;
        for id in ids {
            stmt.execute(params![id, due, now])?;
        }
        Ok(())
    }

    /// Brings snoozed conversations back now.
    pub fn unsnooze(&self, ids: &[i64]) -> Result<()> {
        let conn = self.conn();
        let mut stmt = conn.prepare_cached(
            "DELETE FROM reminders WHERE kind = 'snooze'
               AND (account_id, thread_id) = (SELECT account_id, thread_id FROM messages WHERE id = ?1)",
        )?;
        for id in ids {
            stmt.execute([id])?;
        }
        Ok(())
    }

    /// Ends the snoozes that are due, or that someone replied to since, and returns the newest inbox message of
    /// each conversation that came back (to mark unread and announce). A conversation archived meanwhile has none
    /// and just stops being snoozed.
    pub fn wake_snoozed(&self, now: i64) -> Result<Vec<NewMail>> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        let due: Vec<(i64, String)> = tx
            .prepare(
                "SELECT r.account_id, r.thread_id FROM reminders r JOIN accounts a ON a.id = r.account_id
                 WHERE r.kind = 'snooze' AND (r.due <= ?1 OR EXISTS (
                     SELECT 1 FROM messages m WHERE m.account_id = r.account_id AND m.thread_id = r.thread_id
                       AND m.date > r.created AND lower(m.from_addr) <> lower(a.email)))",
            )?
            .query_map([now], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<rusqlite::Result<_>>()?;
        let mut out = Vec::new();
        for (account_id, thread_id) in due {
            tx.execute(
                "DELETE FROM reminders WHERE account_id = ?1 AND thread_id = ?2 AND kind = 'snooze'",
                params![account_id, thread_id],
            )?;
            let latest = tx
                .query_row(
                    "SELECT m.id, m.from_name, m.from_addr, m.subject, m.snippet
                     FROM messages m JOIN folders f ON f.id = m.folder_id
                     WHERE m.account_id = ?1 AND m.thread_id = ?2 AND f.role = 'inbox'
                     ORDER BY m.date DESC, m.id DESC LIMIT 1",
                    params![account_id, thread_id],
                    |r| {
                        Ok(NewMail {
                            id: r.get(0)?,
                            account_id,
                            thread_id: thread_id.clone(),
                            from_name: r.get(1)?,
                            from_addr: r.get(2)?,
                            subject: r.get(3)?,
                            snippet: r.get(4)?,
                        })
                    },
                )
                .optional()?;
            out.extend(latest);
        }
        tx.commit()?;
        Ok(out)
    }

    /// Accounts that have any mail here.
    pub fn accounts_with_mail(&self) -> Result<Vec<i64>> {
        let conn = self.conn();
        let mut stmt = conn.prepare_cached(
            "SELECT id FROM accounts a WHERE EXISTS (SELECT 1 FROM messages WHERE account_id = a.id)",
        )?;
        let ids = stmt.query_map([], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?;
        Ok(ids)
    }

    /// Unread messages in the Important and Other splits of every inbox (snoozed ones left out), for their tabs.
    pub fn split_unread(&self) -> Result<(i64, i64)> {
        Ok(self.conn().query_row(
            &format!(
                "SELECT count(*) FILTER (WHERE NOT {IS_OTHER}), count(*) FILTER (WHERE {IS_OTHER})
                 FROM messages m JOIN folders f ON f.id = m.folder_id
                 WHERE f.role = 'inbox' AND NOT m.seen AND NOT {IS_SNOOZED}"
            ),
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?)
    }

    /// Unread messages across every inbox, for the tray.
    pub fn inbox_unread(&self) -> Result<i64> {
        Ok(self.conn().query_row(
            "SELECT count(*) FROM messages m JOIN folders f ON f.id = m.folder_id WHERE f.role = 'inbox' AND NOT m.seen",
            [],
            |r| r.get(0),
        )?)
    }

    /// Archives messages in an inbox folder whose conversation is muted (new replies to it). Returns whether any
    /// were; the move goes to the server through the outbox like any archive.
    pub fn archive_muted(&self, folder_id: i64) -> Result<bool> {
        let ids: Vec<i64> = {
            let conn = self.conn();
            let mut stmt = conn.prepare_cached(
                "SELECT m.id FROM messages m JOIN folders f ON f.id = m.folder_id
                 JOIN muted u ON u.account_id = m.account_id AND u.thread_id = m.thread_id
                 WHERE m.folder_id = ?1 AND f.role = 'inbox' AND m.uid IS NOT NULL",
            )?;
            let ids = stmt.query_map([folder_id], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?;
            ids
        };
        if ids.is_empty() {
            return Ok(false);
        }
        self.apply(&ids, Action::Archive, 0)?;
        Ok(true)
    }

    /// What an action on whole conversations touches. Each id is a message standing for its conversation (the
    /// newest one in a list row). Archive and Trash take the conversation's messages in `target`, the folder the
    /// person is looking at; read and unread take the whole conversation wherever it is; a star goes on that one
    /// message, and unstarring clears every star in the conversation.
    pub fn conversation_ids(&self, ids: &[i64], action: Action, target: &ListTarget) -> Result<Vec<i64>> {
        if action == Action::Star {
            return Ok(ids.to_vec());
        }
        let same_conversation = "SELECT m.id FROM messages m, messages o
             WHERE o.id = ?1 AND m.account_id = o.account_id AND m.thread_id = o.thread_id";
        let (sql, key) = match (action, target) {
            (action, _) if action.moves() => {
                // Done from an inbox split (or the inbox) takes the whole conversation out of the inbox, whichever
                // split each of its messages is in, starred, snoozed or not.
                let in_inbox = matches!(target, ListTarget::Role(r)
                    if ["inbox", STARRED, IMPORTANT, OTHER, SNOOZED].contains(&r.as_str()));
                let (filter, key) = if in_inbox {
                    (
                        "m.folder_id IN (SELECT id FROM folders WHERE role = ?2)".to_string(),
                        Value::Text("inbox".into()),
                    )
                } else {
                    target_filter(target, 2)
                };
                (format!("{same_conversation} AND {filter}"), Some(key))
            }
            (Action::Unstar, _) => (format!("{same_conversation} AND m.flagged"), None),
            _ => (same_conversation.to_string(), None),
        };
        let conn = self.conn();
        let mut stmt = conn.prepare_cached(&sql)?;
        let mut out = Vec::new();
        for id in ids {
            let found = match &key {
                Some(key) => stmt.query_map(params![id, key], |r| r.get::<_, i64>(0))?.collect::<Vec<_>>(),
                None => stmt.query_map(params![id], |r| r.get::<_, i64>(0))?.collect::<Vec<_>>(),
            };
            for found in found {
                let found = found?;
                if !out.contains(&found) {
                    out.push(found);
                }
            }
        }
        Ok(out)
    }

    // MARK: Contacts

    /// People whose name or address starts with `query` (or a word of the name does), best first: written to
    /// counts three times as much as written by, and both fade over months.
    pub fn contacts(&self, query: &str, limit: i64) -> Result<Vec<Contact>> {
        let q = query.trim().replace(['%', '_'], "");
        if q.is_empty() {
            return Ok(Vec::new());
        }
        let conn = self.conn();
        let mut stmt = conn.prepare_cached(
            "SELECT email, name FROM contacts
             WHERE email LIKE ?1 || '%' OR name LIKE ?1 || '%' OR name LIKE '% ' || ?1 || '%'
             ORDER BY (3 * sent_count + received_count) / (1.0 + (?2 - last_seen) / 2592000.0) DESC, email
             LIMIT ?3",
        )?;
        let found = stmt
            .query_map(params![q, now(), limit], |r| Ok(Contact { email: r.get(0)?, name: r.get(1)? }))?
            .collect::<rusqlite::Result<_>>()?;
        Ok(found)
    }

    /// The card for `email`: their name and counts from `contacts`, and the latest `limit` conversations they wrote
    /// or were written to in. Walks the date index newest first, so someone you hear from often costs little.
    pub fn contact_card(&self, email: &str, limit: usize) -> Result<ContactCard> {
        let email = email.trim();
        let conn = self.conn();
        let (name, sent, received) = conn
            .query_row(
                "SELECT name, sent_count, received_count FROM contacts WHERE email = ?1",
                [email],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?
            .unwrap_or_default();
        let like = format!("%{}%", email.replace(['%', '_'], ""));
        let mut stmt = conn.prepare_cached(&format!(
            "SELECT {ROW} FROM messages m INDEXED BY messages_date
             WHERE m.from_addr = ?1 COLLATE NOCASE OR m.to_addrs LIKE ?2
             ORDER BY m.date DESC, m.id DESC LIMIT 200"
        ))?;
        let mut seen = HashSet::new();
        let mut recent = Vec::new();
        for found in stmt.query_map(params![email, like], row)? {
            let found = found?;
            if seen.insert((found.account_id, found.thread_id.clone())) {
                recent.push(found);
                if recent.len() == limit {
                    break;
                }
            }
        }
        Ok(ContactCard { email: email.to_string(), name, sent, received, recent })
    }

    // MARK: Snippets

    /// Every snippet, the most used first.
    pub fn snippets(&self) -> Result<Vec<Snippet>> {
        let conn = self.conn();
        let mut stmt = conn
            .prepare_cached("SELECT id, shortcut, name, body FROM snippets ORDER BY used DESC, shortcut")?;
        let all = stmt
            .query_map([], |r| {
                Ok(Snippet { id: r.get(0)?, shortcut: r.get(1)?, name: r.get(2)?, body: r.get(3)? })
            })?
            .collect::<rusqlite::Result<_>>()?;
        Ok(all)
    }

    /// Adds the snippet (id 0) or changes it. Shortcuts are one word, unique whatever their case.
    pub fn save_snippet(&self, snippet: &Snippet) -> Result<i64> {
        let shortcut = snippet.shortcut.trim().trim_start_matches(';');
        if shortcut.is_empty() || shortcut.chars().any(char::is_whitespace) {
            bail!("A shortcut is one word, such as thanks.");
        }
        let conn = self.conn();
        let taken: Option<i64> = conn
            .query_row(
                "SELECT id FROM snippets WHERE shortcut = ?1 AND id != ?2",
                params![shortcut, snippet.id],
                |r| r.get(0),
            )
            .optional()?;
        if taken.is_some() {
            bail!("Another snippet already uses ;{shortcut}.");
        }
        if snippet.id == 0 {
            conn.execute(
                "INSERT INTO snippets (shortcut, name, body) VALUES (?1, ?2, ?3)",
                params![shortcut, snippet.name.trim(), snippet.body],
            )?;
            Ok(conn.last_insert_rowid())
        } else {
            conn.execute(
                "UPDATE snippets SET shortcut = ?1, name = ?2, body = ?3 WHERE id = ?4",
                params![shortcut, snippet.name.trim(), snippet.body, snippet.id],
            )?;
            Ok(snippet.id)
        }
    }

    pub fn delete_snippet(&self, id: i64) -> Result<()> {
        self.conn().execute("DELETE FROM snippets WHERE id = ?1", [id])?;
        Ok(())
    }

    /// Counts a use, so the snippets used most come first in the picker.
    pub fn snippet_used(&self, id: i64) -> Result<()> {
        self.conn().execute("UPDATE snippets SET used = used + 1 WHERE id = ?1", [id])?;
        Ok(())
    }

    // MARK: Drafts

    /// Saves what compose holds. The first save gives the draft its Message-ID, kept for every later version, its
    /// server copies and the message finally sent. Also keeps the draft's row in the account's Drafts folder up to
    /// date, so it shows there and in its conversation before the server has it. `upload_now` (compose closed)
    /// skips the rest before the server copy is replaced. Saving a sent or discarded draft brings it back.
    pub fn save_draft(
        &self,
        id: Option<i64>,
        account_id: i64,
        mut draft: Draft,
        upload_now: bool,
    ) -> Result<i64> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        let existing: Option<String> = match id {
            Some(id) => {
                tx.query_row("SELECT payload FROM drafts WHERE id = ?1", [id], |r| r.get(0)).optional()?
            }
            None => None,
        };
        if let Some(payload) = &existing {
            draft.message_id = serde_json::from_str::<Draft>(payload)?.message_id;
        }
        if draft.message_id.is_none() {
            let email: String =
                tx.query_row("SELECT email FROM accounts WHERE id = ?1", [account_id], |r| r.get(0))?;
            draft.message_id =
                Some(crate::smtp::new_message_id(email.rsplit_once('@').map_or("localhost", |p| p.1))?);
        }
        let bare = bare_id(draft.message_id.as_deref().unwrap_or_default());
        let payload = serde_json::to_string(&draft)?;
        let id = match (id, existing) {
            (Some(id), Some(_)) => {
                tx.execute(
                    "UPDATE drafts SET payload = ?2, updated_at = ?3, upload_now = upload_now OR ?4, version = version + 1,
                                       discarded_at = NULL, sent_at = NULL
                     WHERE id = ?1",
                    params![id, payload, now(), upload_now],
                )?;
                id
            }
            _ => {
                tx.execute(
                    "INSERT INTO drafts (account_id, message_id, payload, updated_at, upload_now) VALUES (?1, ?2, ?3, ?4, ?5)",
                    params![account_id, bare, payload, now(), upload_now],
                )?;
                tx.last_insert_rowid()
            }
        };
        mirror_draft(&tx, account_id, &draft)?;
        tx.commit()?;
        Ok(id)
    }

    pub fn draft(&self, id: i64) -> Result<Option<DraftRecord>> {
        let row: Option<(i64, String, i64)> = self
            .conn()
            .query_row("SELECT account_id, payload, updated_at FROM drafts WHERE id = ?1", [id], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?))
            })
            .optional()?;
        row.map(|(account_id, payload, updated_at)| {
            Ok(DraftRecord { id, account_id, draft: serde_json::from_str(&payload)?, updated_at })
        })
        .transpose()
    }

    /// The draft a message row stands for (a row in a Drafts folder, or a draft card in a conversation), if it is
    /// one being written in Tern.
    pub fn draft_for_message(&self, message: i64) -> Result<Option<DraftRecord>> {
        let id: Option<i64> = self
            .conn()
            .query_row(
                "SELECT d.id FROM drafts d JOIN messages m ON m.account_id = d.account_id AND m.message_id = d.message_id
                 WHERE m.id = ?1 AND d.discarded_at IS NULL AND d.sent_at IS NULL",
                [message],
                |r| r.get(0),
            )
            .optional()?;
        id.map(|id| self.draft(id)).transpose().map(Option::flatten)
    }

    /// Discards a draft. It leaves the Drafts folder at once; its server copy goes after DRAFT_REST seconds, until
    /// when `undo_discard` brings it all back.
    pub fn discard_draft(&self, id: i64) -> Result<()> {
        let conn = self.conn();
        conn.execute("UPDATE drafts SET discarded_at = ?2 WHERE id = ?1", params![id, now()])?;
        unmirror_draft(&conn, id)
    }

    pub fn undo_discard(&self, id: i64) -> Result<bool> {
        let Some(record) = self.draft(id)? else { return Ok(false) };
        self.save_draft(Some(id), record.account_id, record.draft, false)?;
        Ok(true)
    }

    /// The draft went into the outbox: it leaves the Drafts folder, and its server copy goes once the send is done.
    pub fn draft_sent(&self, id: i64) -> Result<()> {
        let conn = self.conn();
        conn.execute("UPDATE drafts SET sent_at = ?2 WHERE id = ?1", params![id, now()])?;
        unmirror_draft(&conn, id)
    }

    /// Turns a send that was refused into a draft again, for the person to fix and send (problems list "Edit").
    pub fn problem_to_draft(&self, outbox_id: i64) -> Result<DraftRecord> {
        let (account_id, payload): (i64, String) = self.conn().query_row(
            "SELECT account_id, payload FROM outbox WHERE id = ?1 AND gave_up_at IS NOT NULL",
            [outbox_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        let OutboxOp::Send(draft) = serde_json::from_str(&payload)? else {
            bail!("Only a send can be edited")
        };
        let bare = bare_id(draft.message_id.as_deref().unwrap_or_default());
        let existing: Option<i64> = self
            .conn()
            .query_row(
                "SELECT id FROM drafts WHERE account_id = ?1 AND message_id = ?2",
                params![account_id, bare],
                |r| r.get(0),
            )
            .optional()?;
        let id = self.save_draft(existing, account_id, draft, false)?;
        self.conn().execute("DELETE FROM outbox WHERE id = ?1", [outbox_id])?;
        Ok(self.draft(id)?.expect("just saved"))
    }

    /// The server work drafts of this account need now.
    pub fn drafts_due(&self, account_id: i64) -> Result<Vec<DraftSync>> {
        let conn = self.conn();
        let folder: Option<String> = conn
            .query_row(
                "SELECT name FROM folders WHERE account_id = ?1 AND role = 'drafts'",
                [account_id],
                |r| r.get(0),
            )
            .optional()?;
        struct Row {
            id: i64,
            bare: String,
            payload: String,
            updated_at: i64,
            version: i64,
            upload_now: bool,
            synced: Option<i64>,
            server_folder: Option<String>,
            copy: Option<(u32, u32)>,
            discarded: Option<i64>,
            sent: Option<i64>,
        }
        let rows: Vec<Row> = conn
            .prepare_cached(
                "SELECT id, message_id, payload, updated_at, version, upload_now, synced_version, server_folder,
                        server_validity, server_uid, discarded_at, sent_at
                 FROM drafts WHERE account_id = ?1",
            )?
            .query_map([account_id], |r| {
                Ok(Row {
                    id: r.get(0)?,
                    bare: r.get(1)?,
                    payload: r.get(2)?,
                    updated_at: r.get(3)?,
                    version: r.get(4)?,
                    upload_now: r.get(5)?,
                    synced: r.get(6)?,
                    server_folder: r.get(7)?,
                    copy: r.get::<_, Option<u32>>(8)?.zip(r.get::<_, Option<u32>>(9)?),
                    discarded: r.get(10)?,
                    sent: r.get(11)?,
                })
            })?
            .collect::<rusqlite::Result<_>>()?;
        // Outbox payloads are tagged {"kind": "send", ...the draft's fields}.
        let mut sending = conn.prepare_cached(
            "SELECT EXISTS (SELECT 1 FROM outbox WHERE account_id = ?1 AND json_extract(payload, '$.kind') = 'send'
                            AND json_extract(payload, '$.messageId') IN (?2, '<' || ?2 || '>'))",
        )?;
        let mut due = Vec::new();
        for row in rows {
            let gone = match (row.discarded, row.sent) {
                (Some(at), _) => at <= now() - DRAFT_REST,
                // Sent: once the send has left the outbox (it went out).
                (None, Some(_)) => {
                    !sending.query_row(params![account_id, row.bare], |r| r.get::<_, bool>(0))?
                }
                (None, None) => false,
            };
            if gone {
                due.push(DraftSync::Remove { id: row.id, folder: row.server_folder, copy: row.copy });
                continue;
            }
            // Each save bumps the version; timestamps would miss two saves in one second.
            let changed = row.synced.is_none_or(|s| s < row.version);
            let rested = row.upload_now || row.updated_at <= now() - DRAFT_REST;
            if row.discarded.is_none() && row.sent.is_none() && changed && rested {
                if let Some(folder) = &folder {
                    let previous =
                        if row.server_folder.as_deref() == Some(folder.as_str()) { row.copy } else { None };
                    due.push(DraftSync::Upload {
                        id: row.id,
                        draft: Box::new(serde_json::from_str(&row.payload)?),
                        version: row.version,
                        folder: folder.clone(),
                        previous,
                    });
                }
            }
        }
        Ok(due)
    }

    /// `version` of the draft is on the server as `copy` (validity, uid), when the server said. The
    /// draft's row in the Drafts folder takes that uid, or none so the folder's sync claims it by Message-ID.
    pub fn draft_uploaded(
        &self,
        id: i64,
        folder: &str,
        version: i64,
        copy: Option<(u32, u32)>,
    ) -> Result<()> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        tx.execute(
            "UPDATE drafts SET synced_version = ?2, upload_now = 0, server_folder = ?3, server_validity = ?4,
                               server_uid = ?5
             WHERE id = ?1",
            params![id, version, folder, copy.map(|c| c.0), copy.map(|c| c.1)],
        )?;
        let row: Option<(i64, i64)> = tx
            .query_row(
                "SELECT m.id, m.folder_id FROM drafts d
                 JOIN messages m ON m.account_id = d.account_id AND m.message_id = d.message_id
                 JOIN folders f ON f.id = m.folder_id AND f.role = 'drafts'
                 WHERE d.id = ?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        if let Some((message, folder_id)) = row {
            if let Some((_, uid)) = copy {
                tx.execute(
                    "DELETE FROM messages WHERE folder_id = ?1 AND uid = ?2 AND id != ?3",
                    params![folder_id, uid, message],
                )?;
            }
            tx.execute("UPDATE messages SET uid = ?2 WHERE id = ?1", params![message, copy.map(|c| c.1)])?;
        }
        tx.commit()?;
        Ok(())
    }

    /// The draft's server copy is gone (or it never had one): forget the draft.
    pub fn draft_removed(&self, id: i64) -> Result<()> {
        self.conn().execute("DELETE FROM drafts WHERE id = ?1", [id])?;
        Ok(())
    }

    /// How a reply, reply-all or forward to this message starts (recipients, subject, threading, quote).
    ///
    /// Reply goes to Reply-To, else the sender; to a message this account sent, it goes back to its recipients.
    /// Reply-all honours Mail-Followup-To when the message has one, else adds everyone in To and Cc. The
    /// account's own address is never a recipient. References carry the chain on, ending with this message.
    pub fn reply_init(&self, id: i64, kind: ReplyKind) -> Result<ReplyInit> {
        let conn = self.conn();
        type Row = (
            i64,
            String,
            Option<String>,
            String,
            String,
            String,
            String,
            String,
            String,
            String,
            i64,
            String,
        );
        let (account_id, me, message_id, from_name, from_addr, to, cc, reply_to, followup, refs, date, subject): Row =
            conn.query_row(
                "SELECT m.account_id, lower(a.email), m.message_id, m.from_name, m.from_addr, m.to_addrs, m.cc_addrs,
                        m.reply_to, m.followup_to, m.refs, m.date, m.subject
                 FROM messages m JOIN accounts a ON a.id = m.account_id WHERE m.id = ?1",
                [id],
                |r| {
                    Ok((
                        r.get(0)?,
                        r.get(1)?,
                        r.get(2)?,
                        r.get(3)?,
                        r.get(4)?,
                        r.get(5)?,
                        r.get(6)?,
                        r.get(7)?,
                        r.get(8)?,
                        r.get(9)?,
                        r.get(10)?,
                        r.get(11)?,
                    ))
                },
            )?;
        let text: Option<String> = conn
            .query_row("SELECT text FROM bodies WHERE message_id = ?1", [id], |r| r.get(0))
            .optional()?
            .flatten();
        let list = |s: &str| -> Vec<String> {
            s.split(',').map(|a| a.trim().to_string()).filter(|a| !a.is_empty()).collect()
        };
        let mine = |a: &String| a.to_lowercase() == me;
        let mut seen = HashSet::new();
        // Each address once, never this account's.
        let mut keep = |list: Vec<String>| -> Vec<String> {
            list.into_iter().filter(|a| !mine(a) && seen.insert(a.to_lowercase())).collect()
        };
        let from_me = from_addr.to_lowercase() == me;
        let sender = if !reply_to.is_empty() { list(&reply_to) } else { vec![from_addr.clone()] };
        let (to_list, cc_list) = match kind {
            ReplyKind::Forward => (Vec::new(), Vec::new()),
            ReplyKind::Reply if from_me => (keep(list(&to)), Vec::new()),
            ReplyKind::Reply => (keep(sender), Vec::new()),
            ReplyKind::ReplyAll if !followup.is_empty() => (keep(list(&followup)), Vec::new()),
            ReplyKind::ReplyAll if from_me => {
                let first = keep(list(&to));
                (first, keep(list(&cc)))
            }
            ReplyKind::ReplyAll => {
                let first = keep(sender);
                let mut others = list(&to);
                others.extend(list(&cc));
                (first, keep(others))
            }
        };
        let (prefix, already) = match kind {
            ReplyKind::Forward => {
                ("Fwd: ", ["fwd:", "fw:"].iter().any(|p| subject.to_lowercase().starts_with(p)))
            }
            _ => ("Re: ", subject.to_lowercase().starts_with("re:")),
        };
        let threading = kind != ReplyKind::Forward;
        let mut references: Vec<String> = refs.split_whitespace().map(str::to_string).collect();
        if let Some(id) = &message_id {
            if !references.contains(id) {
                references.push(id.clone());
            }
        }
        Ok(ReplyInit {
            account_id,
            to: to_list,
            cc: cc_list,
            subject: if already { subject } else { format!("{prefix}{subject}") },
            in_reply_to: if threading { message_id } else { None },
            references: if threading { references } else { Vec::new() },
            quote_from: if from_name.is_empty() {
                from_addr.clone()
            } else {
                format!("{from_name} <{from_addr}>")
            },
            quote_date: date,
            quote_text: text.unwrap_or_default(),
            quote_to: to,
            quote_cc: cc,
            forward_of: match kind {
                ReplyKind::Forward => conn
                    .query_row(
                        "SELECT f.name, m.uid, f.uid_validity, m.message_id FROM messages m
                         JOIN folders f ON f.id = m.folder_id WHERE m.id = ?1 AND m.uid IS NOT NULL",
                        [id],
                        |r| {
                            Ok(ForwardOf {
                                folder: r.get(0)?,
                                uid: r.get(1)?,
                                validity: r.get(2)?,
                                message_id: r.get(3)?,
                            })
                        },
                    )
                    .optional()?,
                _ => None,
            },
        })
    }

    /// Where a message is on the server (account, place) and the names of the attachments its row lists, for
    /// downloading one. None while the message has no uid there yet.
    pub fn attachment_source(&self, id: i64) -> Result<Option<(i64, ForwardOf, Vec<String>)>> {
        let found = self
            .conn()
            .query_row(
                "SELECT m.account_id, f.name, m.uid, f.uid_validity, m.message_id, m.parts FROM messages m
                 JOIN folders f ON f.id = m.folder_id WHERE m.id = ?1 AND m.uid IS NOT NULL",
                [id],
                |r| {
                    let at = ForwardOf {
                        folder: r.get(1)?,
                        uid: r.get(2)?,
                        validity: r.get(3)?,
                        message_id: r.get(4)?,
                    };
                    Ok((r.get(0)?, at, r.get::<_, Option<String>>(5)?))
                },
            )
            .optional()?;
        Ok(found.map(|(account, at, parts)| {
            (account, at, attachments_of(parts.as_deref()).into_iter().map(|a| a.name).collect())
        }))
    }

    pub fn thread(&self, id: i64) -> Result<Vec<ThreadMessage>> {
        let conn = self.conn();
        let mut stmt = conn.prepare_cached(&format!(
            "SELECT {ROW}, m.message_id, m.to_addrs, b.text, b.html,
                    -- A row fetched again for its parts (migration 15) still has the body it had.
                    m.body_state = 'full' OR b.message_id IS NOT NULL, m.parts,
                    (SELECT d.id FROM drafts d WHERE d.account_id = m.account_id AND d.message_id = m.message_id
                       AND d.discarded_at IS NULL AND d.sent_at IS NULL),
                    m.list_unsubscribe
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
                    attachments: attachments_of(r.get::<_, Option<String>>(17)?.as_deref()),
                    draft_id: r.get(18)?,
                    list_unsubscribe: r.get(19)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(messages)
    }

    /// Search with the search box's language (`query::parse`): words over subject, sender and body as prefixes,
    /// plus filters. Newest first.
    pub fn search(&self, input: &str, limit: i64) -> Result<SearchResult> {
        let q = crate::query::parse(input, now());
        if q.is_empty() {
            return Ok(SearchResult::default());
        }
        let conn = self.conn();
        let mut conditions = Vec::new();
        let mut values: Vec<Value> = Vec::new();
        if !q.fts_not.is_empty() {
            conditions
                .push("m.id NOT IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?)".to_string());
            values.push(Value::Text(q.fts_not.clone()));
        }
        conditions.extend(q.conditions);
        values.extend(q.params);
        let mut rows = None;
        if !q.fts.is_empty() {
            rows = self.newest_matches(&conn, &q.fts, &conditions, &values, limit)?;
            conditions.insert(0, "messages_fts MATCH ?".to_string());
            values.insert(0, Value::Text(q.fts.clone()));
        }
        let rows = match rows {
            Some(rows) => rows,
            None => {
                let mut sql = format!("SELECT {ROW} FROM messages m");
                if !q.fts.is_empty() {
                    sql.push_str(" JOIN messages_fts ON messages_fts.rowid = m.id");
                }
                sql.push_str(&format!(
                    " WHERE {} ORDER BY m.date DESC, m.id DESC LIMIT ?",
                    conditions.join(" AND ")
                ));
                values.push(Value::Integer(limit));
                let mut stmt = conn.prepare_cached(&sql)?;
                let rows = stmt
                    .query_map(rusqlite::params_from_iter(values), row)?
                    .collect::<rusqlite::Result<_>>()?;
                rows
            }
        };
        // Words are only found in bodies that are here; mail older than the download window has headers alone.
        let words = !q.fts.is_empty() || !q.fts_not.is_empty();
        let partial = words
            && conn.query_row(
                "SELECT EXISTS (SELECT 1 FROM messages WHERE body_state != 'full')",
                [],
                |r| r.get(0),
            )?;
        Ok(SearchResult { rows, partial })
    }

    /// Search words found in much of the mailbox. Joining every match and sorting them by date took 70 ms when a
    /// word was in most messages. Instead this takes the newest `window` messages that pass the filters (the date
    /// index), and the word's matches in their id range (the FTS index, without reading the rest). Mail arrives
    /// in batches, so the newest messages sit in a narrow id range. With `limit` hits the window holds the answer,
    /// since everything newer is in it; otherwise it grows. `None` when the word is rare: then sorting its few
    /// matches is quicker.
    fn newest_matches(
        &self,
        conn: &Connection,
        fts: &str,
        conditions: &[String],
        values: &[Value],
        limit: i64,
    ) -> Result<Option<Vec<MessageRow>>> {
        let mut sql = "SELECT m.id FROM messages m INDEXED BY messages_date".to_string();
        if !conditions.is_empty() {
            sql.push_str(&format!(" WHERE {}", conditions.join(" AND ")));
        }
        sql.push_str(" ORDER BY m.date DESC, m.id DESC LIMIT ?");
        let mut walk = conn.prepare_cached(&sql)?;
        let mut matching = conn.prepare_cached(
            "SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?1 AND rowid BETWEEN ?2 AND ?3",
        )?;
        let mut window = (limit * 2).max(200);
        let ids = loop {
            let mut walked = values.to_vec();
            walked.push(Value::Integer(window));
            let newest: Vec<i64> = walk
                .query_map(rusqlite::params_from_iter(walked), |r| r.get(0))?
                .collect::<rusqlite::Result<_>>()?;
            let (Some(lo), Some(hi)) = (newest.iter().min(), newest.iter().max()) else {
                return Ok(Some(Vec::new()));
            };
            let found: HashSet<i64> =
                matching.query_map(params![fts, lo, hi], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?;
            let hits: Vec<i64> =
                newest.iter().copied().filter(|id| found.contains(id)).take(limit as usize).collect();
            let got = hits.len() as i64;
            if got >= limit || (newest.len() as i64) < window {
                break hits;
            }
            // Under one in eight: few enough matches to sort them all.
            if got * 8 < limit {
                return Ok(None);
            }
            window = (window * limit / got * 5 / 4).max(window * 2);
        };
        let mut one = conn.prepare_cached(&format!("SELECT {ROW} FROM messages m WHERE m.id = ?"))?;
        let rows = ids.iter().map(|id| one.query_row([id], row)).collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(Some(rows))
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
            validity: Option<u32>,
        }

        let mut conn = self.conn();
        let tx = conn.transaction()?;
        let mut groups: BTreeMap<(i64, i64), Vec<Hit>> = BTreeMap::new();
        for id in ids {
            let hit = tx
                .query_row(
                    "SELECT m.id, m.account_id, m.folder_id, f.name, m.uid, m.seen, m.flagged, f.uid_validity
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
                                validity: r.get(7)?,
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
            // Moved here by work still queued: their uid here is not known yet.
            let waiting: Vec<i64> = hits.iter().filter(|h| h.uid.is_none()).map(|h| h.id).collect();
            let validity = hits[0].validity;
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
                        validity,
                        waiting,
                    }
                }
                Action::Archive | Action::Trash | Action::Junk | Action::Inbox | Action::MoveTo(_) => {
                    let dest: Option<(i64, String)> = match action {
                        Action::MoveTo(folder) => tx
                            .query_row(
                                "SELECT id, name FROM folders WHERE id = ?1 AND account_id = ?2",
                                params![folder, account_id],
                                |r| Ok((r.get(0)?, r.get(1)?)),
                            )
                            .optional()?,
                        _ => {
                            // Gmail has no Archive folder: archiving there is a move to All Mail.
                            let roles = match action {
                                Action::Archive => ["archive", "all"],
                                Action::Trash => ["trash", "trash"],
                                Action::Junk => ["junk", "junk"],
                                _ => ["inbox", "inbox"],
                            };
                            let found = tx
                                .query_row(
                                    "SELECT id, name FROM folders WHERE account_id = ?1 AND role IN (?2, ?3)
                                     ORDER BY role = ?2 DESC LIMIT 1",
                                    params![account_id, roles[0], roles[1]],
                                    |r| Ok((r.get(0)?, r.get(1)?)),
                                )
                                .optional()?;
                            if found.is_none() {
                                bail!("This account has no {} folder", roles[0]);
                            }
                            found
                        }
                    };
                    // A folder of another account: these messages stay where they are.
                    let Some((dest_id, dest)) = dest else { continue };
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
                        validity,
                        waiting,
                    }
                }
            };
            token.push(enqueue(&tx, account_id, &op, delay)?);
            accounts.insert(account_id);
        }
        tx.commit()?;
        Ok(Applied { token, accounts: accounts.into_iter().collect() })
    }

    pub fn queue_send(&self, account_id: i64, mut draft: Draft, delay: i64) -> Result<i64> {
        let conn = self.conn();
        // Who the person writes to ranks first in autocomplete, before the copy in Sent is even synced.
        let me: String =
            conn.query_row("SELECT lower(email) FROM accounts WHERE id = ?1", [account_id], |r| r.get(0))?;
        let sent = NewMessage {
            from_addr: me.clone(),
            to_addrs: draft.to.join(", "),
            cc_addrs: [draft.cc.clone(), draft.bcc.clone()].concat().join(", "),
            date: now(),
            ..Default::default()
        };
        note_people(&conn, &me, &sent)?;
        if draft.message_id.is_none() {
            let email: String =
                conn.query_row("SELECT email FROM accounts WHERE id = ?1", [account_id], |r| r.get(0))?;
            let domain = email.rsplit_once('@').map_or("localhost", |(_, d)| d);
            draft.message_id = Some(crate::smtp::new_message_id(domain)?);
        }
        enqueue(&conn, account_id, &OutboxOp::Send(draft), delay)
    }

    /// Takes back what `apply` or `queue_send` did, if it has not gone to the server yet.
    pub fn undo(&self, token: &[i64]) -> Result<bool> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        let mut undone = false;
        for id in token {
            undone |= take_back(&tx, *id, false)?;
        }
        tx.commit()?;
        Ok(undone)
    }

    /// Work still waiting to go out (in the undo window, waiting for the connection, or between retries), oldest
    /// first. Given-up work is in `outbox_problems` instead.
    pub fn outbox_waiting(&self) -> Result<Vec<OutboxWaiting>> {
        let conn = self.conn();
        let mut stmt = conn.prepare_cached(
            "SELECT id, account_id, payload, not_before, attempts, COALESCE(last_error, ''), claimed
             FROM outbox WHERE gave_up_at IS NULL ORDER BY id",
        )?;
        type Row = (i64, i64, String, i64, i64, String, i64);
        let rows = stmt
            .query_map([], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?))
            })?
            .collect::<rusqlite::Result<Vec<Row>>>()?;
        rows.into_iter()
            .map(|(id, account_id, payload, not_before, attempts, last_error, claimed)| {
                let op = serde_json::from_str(&payload)?;
                let can_discard = claimed == 0 && !waited_on(&conn, id, &op)?;
                Ok(OutboxWaiting {
                    id,
                    account_id,
                    what: describe(&op),
                    not_before,
                    attempts,
                    last_error,
                    sending: claimed != 0,
                    can_discard,
                })
            })
            .collect()
    }

    /// Drops waiting work and puts the mailbox back as it was, as undo would, even after failed tries. False when
    /// it is already being sent, gone, or later work depends on it.
    pub fn discard_waiting(&self, id: i64) -> Result<bool> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        let done = take_back(&tx, id, true)?;
        tx.commit()?;
        Ok(done)
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

    /// A send went out: it leaves the queue and, in the same step, the copy for Sent (if any) joins it, so a crash
    /// between the two can neither lose the copy nor send twice.
    pub fn outbox_sent(&self, id: i64, copy: Option<OutboxOp>) -> Result<()> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        let account_id: i64 =
            tx.query_row("SELECT account_id FROM outbox WHERE id = ?1", [id], |r| r.get(0))?;
        tx.execute("DELETE FROM outbox WHERE id = ?1", [id])?;
        if let Some(copy) = copy {
            enqueue(&tx, account_id, &copy, 0)?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn outbox_done(&self, id: i64) -> Result<()> {
        self.conn().execute("DELETE FROM outbox WHERE id = ?1", [id])?;
        Ok(())
    }

    /// Puts the work back, to try again later: 20 s, 40 s, … up to an hour. After MAX_ATTEMPTS, or at once when
    /// the server's answer means trying again cannot help (`permanent`), it stops being tried and waits in
    /// `outbox_problems` for the person to retry or discard it. It is never dropped on its own.
    pub fn outbox_failed(&self, id: i64, error: &str, failure: Failure) -> Result<()> {
        let maybe_sent = failure == Failure::MaybeSent;
        let stop = failure != Failure::Retry;
        self.conn().execute(
            "UPDATE outbox SET claimed = 0, attempts = attempts + 1, last_error = ?2, maybe_sent = ?6,
                               not_before = ?3 + MIN(3600, 10 << MIN(attempts + 1, 9)),
                               gave_up_at = CASE WHEN ?4 OR attempts + 1 >= ?5 THEN ?3 END
             WHERE id = ?1",
            params![id, error, now(), stop, MAX_ATTEMPTS, maybe_sent],
        )?;
        Ok(())
    }

    /// One queued op as it stands now. Claimed work is read again just before it runs, since an earlier op in the
    /// same pass may have filled in its uids (`moved`). None if it is gone.
    pub fn outbox_op(&self, id: i64) -> Result<Option<OutboxOp>> {
        let payload: Option<String> = self
            .conn()
            .query_row("SELECT payload FROM outbox WHERE id = ?1", [id], |r| r.get(0))
            .optional()?;
        payload.map(|p| Ok(serde_json::from_str(&p)?)).transpose()
    }

    /// Marks claimed work as handed to the server. A send marked so and never finished (Tern was closed or
    /// crashed) may have gone out: the next start puts it in the problems list instead of sending it again.
    pub fn outbox_sending(&self, id: i64) -> Result<()> {
        self.conn().execute("UPDATE outbox SET claimed = 2 WHERE id = ?1", [id])?;
        Ok(())
    }

    /// Records where a move put its messages: `placed` is (message id, uid in `dest`), from the server's COPYUID.
    /// A message still in `dest` here takes its uid at once, and queued work that waited to learn it (a star, or a
    /// further move, made before this move went out) has it filled in.
    pub fn moved(&self, account_id: i64, dest: &str, placed: &[(i64, u32)]) -> Result<()> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        for &(id, uid) in placed {
            // Only a row still waiting for its uid in `dest`; one moved on again since is left to the later work.
            let folder: Option<i64> = tx
                .query_row(
                    "SELECT m.folder_id FROM messages m JOIN folders f ON f.id = m.folder_id
                     WHERE m.id = ?1 AND m.uid IS NULL AND f.account_id = ?2 AND f.name = ?3",
                    params![id, account_id, dest],
                    |r| r.get(0),
                )
                .optional()?;
            let Some(folder) = folder else { continue };
            // A row for the same uid may already be here (a message without Message-ID that sync could not
            // match): it is this message, so the moved row takes its place.
            tx.execute(
                "DELETE FROM messages WHERE folder_id = ?1 AND uid = ?2 AND id != ?3",
                params![folder, uid, id],
            )?;
            tx.execute("UPDATE messages SET uid = ?2 WHERE id = ?1", params![id, uid])?;
        }
        if !placed.is_empty() {
            let rows: Vec<(i64, String)> = tx
                .prepare("SELECT id, payload FROM outbox WHERE account_id = ?1 AND claimed != 2 ORDER BY id")?
                .query_map([account_id], |r| Ok((r.get(0)?, r.get(1)?)))?
                .collect::<rusqlite::Result<_>>()?;
            for (row, payload) in rows {
                let mut op: OutboxOp = serde_json::from_str(&payload)?;
                let changed = match &mut op {
                    OutboxOp::Flags { folder, uids, waiting, .. }
                    | OutboxOp::Move { folder, uids, waiting, .. }
                        if folder == dest =>
                    {
                        let before = waiting.len();
                        for &(id, uid) in placed {
                            if let Some(i) = waiting.iter().position(|w| *w == id) {
                                waiting.remove(i);
                                uids.push(uid);
                            }
                        }
                        waiting.len() != before
                    }
                    _ => false,
                };
                // A further move also notes where it takes each message from, both to report where that one
                // went and so that undoing it puts the message back with its uid.
                if let (true, OutboxOp::Move { revert, .. }) = (changed, &mut op) {
                    for (id, _, from) in revert.iter_mut() {
                        if let Some(&(_, uid)) = placed.iter().find(|p| p.0 == *id) {
                            from.get_or_insert(uid);
                        }
                    }
                }
                if changed {
                    tx.execute(
                        "UPDATE outbox SET payload = ?2 WHERE id = ?1",
                        params![row, serde_json::to_string(&op)?],
                    )?;
                }
            }
        }
        tx.commit()?;
        Ok(())
    }

    /// The Message-ID of each message, for finding it on the server when its uid cannot be trusted.
    pub fn message_ids(&self, ids: &[i64]) -> Result<Vec<(i64, String)>> {
        let conn = self.conn();
        let mut stmt = conn.prepare_cached("SELECT message_id FROM messages WHERE id = ?1")?;
        let mut out = Vec::new();
        for &id in ids {
            if let Some(Some(mid)) = stmt.query_row([id], |r| r.get::<_, Option<String>>(0)).optional()? {
                out.push((id, mid));
            }
        }
        Ok(out)
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
            "SELECT id, account_id, payload, attempts, COALESCE(last_error, ''), gave_up_at, maybe_sent
             FROM outbox WHERE gave_up_at IS NOT NULL ORDER BY gave_up_at, id",
        )?;
        type Problem = (i64, i64, String, i64, String, i64, bool);
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get(1)?,
                    r.get::<_, String>(2)?,
                    r.get(3)?,
                    r.get(4)?,
                    r.get(5)?,
                    r.get(6)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<Problem>>>()?;
        rows.into_iter()
            .map(|(id, account_id, payload, attempts, last_error, gave_up_at, maybe_sent)| {
                let what = describe(&serde_json::from_str(&payload)?);
                Ok(OutboxProblem { id, account_id, what, attempts, last_error, gave_up_at, maybe_sent })
            })
            .collect()
    }

    /// Tries given-up work again from the start.
    pub fn retry_outbox(&self, id: i64) -> Result<()> {
        self.conn().execute(
            "UPDATE outbox SET gave_up_at = NULL, attempts = 0, not_before = ?2, claimed = 0, maybe_sent = 0
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
    let snippet = crate::mime::snippet(&draft.body);
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
    let html = draft.html.as_deref().map(crate::mime::sanitize_html);
    tx.execute(
        "INSERT OR REPLACE INTO bodies (message_id, text, html) VALUES (?1, ?2, ?3)",
        params![id, draft.body, html],
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
    }
    tx.execute("DELETE FROM outbox WHERE id = ?1", [id])?;
    Ok(true)
}

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
    if let Some(thread) = thread_by_subject(conn, account_id, m)? {
        return Ok(thread);
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
        let hits = store.search("inv acme", 10).unwrap().rows;
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].subject, "Invoice from ACME");
        assert!(store.search("\"", 10).unwrap().rows.is_empty());
    }

    #[test]
    fn search_filters_narrow_by_field_folder_and_state() {
        let (store, account, inbox, archive) = setup();
        let mut from_grace = message(1, "Budget", 100);
        from_grace.from_addr = "grace@navy.mil".into();
        from_grace.has_attachments = true;
        let mut to_me = message(2, "Budget follow-up", 200);
        to_me.to_addrs = "Me <ME@example.com>".into();
        to_me.seen = true;
        store.insert_messages(account, inbox, &[from_grace, to_me]).unwrap();
        store.insert_messages(account, archive, &[message(3, "Old budget", 50)]).unwrap();
        let subjects = |q: &str| -> Vec<String> {
            store.search(q, 10).unwrap().rows.into_iter().map(|r| r.subject).collect()
        };
        assert_eq!(subjects("budget"), ["Budget follow-up", "Budget", "Old budget"]);
        assert_eq!(subjects("budget from:grace"), ["Budget"]);
        assert_eq!(subjects("to:me"), ["Budget follow-up"]);
        assert_eq!(subjects("has:attachment"), ["Budget"]);
        assert_eq!(subjects("in:archive"), ["Old budget"]);
        assert_eq!(subjects("budget -in:archive is:unread"), ["Budget"]);
        assert_eq!(subjects("budget -follow"), ["Budget", "Old budget"]);
        assert_eq!(subjects("before:1970-01-01"), Vec::<String>::new());
        assert_eq!(subjects("after:1970-01-01 is:read"), ["Budget follow-up"]);
        assert!(!store.search("budget", 10).unwrap().partial, "every body is here");
    }

    #[test]
    fn search_finds_the_newest_matches_whatever_order_mail_arrived_in() {
        let (store, account, inbox, archive) = setup();
        // Dates scrambled against arrival order, so ids say nothing about age.
        let mail: Vec<NewMessage> = (1..=1200u32)
            .map(|uid| {
                let mut words = vec!["every"];
                for (n, word) in [(2, "half"), (10, "tenth"), (400, "rare")] {
                    if uid % n == 0 {
                        words.push(word);
                    }
                }
                NewMessage {
                    body_text: Some(words.join(" ")),
                    ..message(uid, "s", (uid as i64 * 7919) % 1000)
                }
            })
            .collect();
        let (first, second) = mail.split_at(700);
        store.insert_messages(account, inbox, first).unwrap();
        store.insert_messages(account, archive, second).unwrap();
        for query in
            ["every", "half", "tenth", "rare", "ever", "half in:inbox", "every -half", "every is:unread"]
        {
            let q = crate::query::parse(query, now());
            let mut conditions = vec!["messages_fts MATCH ?".to_string()];
            let mut values = vec![Value::Text(q.fts.clone())];
            if !q.fts_not.is_empty() {
                conditions
                    .push("m.id NOT IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?)".into());
                values.push(Value::Text(q.fts_not.clone()));
            }
            conditions.extend(q.conditions);
            values.extend(q.params);
            // Every match, sorted: what search used to do.
            let sql = format!(
                "SELECT m.id FROM messages m JOIN messages_fts ON messages_fts.rowid = m.id WHERE {}
                 ORDER BY m.date DESC, m.id DESC LIMIT 50",
                conditions.join(" AND ")
            );
            let conn = store.conn();
            let want: Vec<i64> = conn
                .prepare(&sql)
                .unwrap()
                .query_map(rusqlite::params_from_iter(values), |r| r.get(0))
                .unwrap()
                .collect::<rusqlite::Result<_>>()
                .unwrap();
            drop(conn);
            let got: Vec<i64> = store.search(query, 50).unwrap().rows.iter().map(|r| r.id).collect();
            assert!(!want.is_empty(), "{query}");
            assert_eq!(got, want, "{query}");
        }
    }

    #[test]
    fn snippets_keep_one_word_shortcuts_and_the_most_used_first() {
        let (store, ..) = setup();
        let thanks = Snippet {
            shortcut: ";thanks".into(),
            name: "Thanks".into(),
            body: "Thanks {first_name}!".into(),
            ..Default::default()
        };
        let id = store.save_snippet(&thanks).unwrap();
        let later = store.save_snippet(&Snippet { shortcut: "later".into(), ..Default::default() }).unwrap();
        assert_eq!(store.snippets().unwrap()[0].shortcut, "later", "unused, by shortcut");
        assert!(store.save_snippet(&Snippet { shortcut: "THANKS".into(), ..Default::default() }).is_err());
        assert!(store.save_snippet(&Snippet { shortcut: "two words".into(), ..Default::default() }).is_err());
        store.snippet_used(id).unwrap();
        let all = store.snippets().unwrap();
        assert_eq!(all[0], Snippet { id, shortcut: "thanks".into(), ..thanks });
        store.save_snippet(&Snippet { id: later, shortcut: "soon".into(), ..Default::default() }).unwrap();
        store.delete_snippet(id).unwrap();
        let left: Vec<String> = store.snippets().unwrap().into_iter().map(|s| s.shortcut).collect();
        assert_eq!(left, ["soon"]);
    }

    #[test]
    fn search_says_when_bodies_were_not_all_searched() {
        let (store, account, inbox, _) = setup();
        let headers = NewMessage { headers_only: true, body_text: None, ..message(1, "Plans", 1) };
        store.insert_messages(account, inbox, &[headers]).unwrap();
        assert!(store.search("plans", 10).unwrap().partial);
        assert!(!store.search("is:unread", 10).unwrap().partial, "no words, nothing missed");
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
        store.outbox_failed(due[0].0, "offline", Failure::Retry).unwrap();
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
        store.outbox_failed(work, "550 no such mailbox", Failure::Permanent).unwrap();
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
            store.outbox_failed(work, "timed out", Failure::Retry).unwrap();
            assert!(store.outbox_problems().unwrap().is_empty());
        }
        store.outbox_failed(work, "timed out", Failure::Retry).unwrap();
        assert_eq!(store.outbox_problems().unwrap().len(), 1);
        // Never dropped: the row is still there, just no longer tried.
        let rows: i64 = store.conn().query_row("SELECT COUNT(*) FROM outbox", [], |r| r.get(0)).unwrap();
        assert_eq!(rows, 1);
    }

    #[test]
    fn retry_puts_given_up_work_back_in_the_queue() {
        let (store, account, inbox, _) = setup();
        let work = queued_mark_read(&store, account, inbox);
        store.outbox_failed(work, "550", Failure::Permanent).unwrap();
        store.retry_outbox(work).unwrap();
        assert!(store.outbox_problems().unwrap().is_empty());
        assert_eq!(store.claim_due(account).unwrap()[0].0, work);
    }

    #[test]
    fn discard_drops_given_up_work_and_reverts_the_local_change() {
        let (store, account, inbox, _) = setup();
        let work = queued_mark_read(&store, account, inbox);
        store.outbox_failed(work, "550", Failure::Permanent).unwrap();
        store.discard_outbox(work).unwrap();
        assert!(store.outbox_problems().unwrap().is_empty());
        assert!(!store.list(&ListTarget::Folder(inbox), None, 10).unwrap()[0].seen, "back to unread");
        assert!(store.pending_uids(account, "INBOX").unwrap().is_empty(), "sync may update it again");
    }

    #[test]
    fn waiting_work_is_listed_until_it_goes_or_is_given_up() {
        let (store, account, inbox, _) = setup();
        let work = queued_mark_read(&store, account, inbox);
        let waiting = store.outbox_waiting().unwrap();
        assert_eq!((waiting[0].id, waiting[0].what.as_str()), (work, "Mark read 1 message"));
        assert!(waiting[0].sending && !waiting[0].can_discard, "claimed: in hand, so not discardable");
        store.outbox_failed(work, "timed out", Failure::Retry).unwrap();
        let waiting = store.outbox_waiting().unwrap();
        assert_eq!((waiting[0].attempts, waiting[0].last_error.as_str()), (1, "timed out"));
        assert!(!waiting[0].sending && waiting[0].can_discard);
        assert!(waiting[0].not_before > now(), "waits before the next try");
        store.outbox_failed(work, "550", Failure::Permanent).unwrap();
        assert!(store.outbox_waiting().unwrap().is_empty(), "a problem now, not waiting");
    }

    #[test]
    fn discarding_waiting_work_reverts_it_even_after_a_failed_try() {
        let (store, account, inbox, _) = setup();
        let work = queued_mark_read(&store, account, inbox);
        assert!(!store.discard_waiting(work).unwrap(), "not while it is being sent");
        store.outbox_failed(work, "timed out", Failure::Retry).unwrap();
        assert!(!store.undo(&[work]).unwrap(), "undo is for the undo window only");
        assert!(store.discard_waiting(work).unwrap());
        assert!(store.outbox_waiting().unwrap().is_empty());
        assert!(!store.list(&ListTarget::Folder(inbox), None, 10).unwrap()[0].seen, "back to unread");
    }

    #[test]
    fn waiting_work_that_later_work_depends_on_cannot_be_discarded() {
        let (store, account, inbox, _) = setup();
        store.insert_messages(account, inbox, &[message(1, "a", 1)]).unwrap();
        let id = store.list(&ListTarget::Folder(inbox), None, 1).unwrap()[0].id;
        let archived = store.apply(&[id], Action::Archive, 5).unwrap().token;
        store.apply(&[id], Action::Star, 5).unwrap();
        let waiting = store.outbox_waiting().unwrap();
        assert_eq!(waiting.len(), 2);
        assert!(!waiting[0].can_discard && waiting[1].can_discard, "the star waits for the move");
        assert!(!store.discard_waiting(archived[0]).unwrap());
        assert_eq!(store.outbox_waiting().unwrap().len(), 2);
    }

    #[test]
    fn released_claims_are_handed_out_again() {
        let (store, account, inbox, _) = setup();
        let work = queued_mark_read(&store, account, inbox);
        store.release_claims(account).unwrap();
        assert_eq!(store.claim_due(account).unwrap()[0].0, work);
    }

    #[test]
    fn subjects_compare_without_prefixes_and_tags() {
        assert_eq!(subject_norm("Re: RE: Fwd: Lunch?").as_deref(), Some("lunch?"));
        assert_eq!(subject_norm("AW: [team] Re[2]:  Budget   2027").as_deref(), Some("budget 2027"));
        assert_eq!(subject_norm("Rebooking"), Some("rebooking".into()), "a word, not a prefix");
        assert_eq!(subject_norm("Re: "), None);
        assert_eq!(subject_norm(""), None);
    }

    fn mail(uid: u32, subject: &str, date: i64, from: &str, to: &str) -> NewMessage {
        NewMessage {
            uid,
            message_id: Some(format!("{uid}@example.com")),
            subject: subject.into(),
            from_name: from.split('@').next().unwrap().into(),
            from_addr: from.into(),
            to_addrs: to.into(),
            date,
            ..Default::default()
        }
    }

    #[test]
    fn mail_without_references_joins_by_subject_and_people() {
        let (store, account, inbox, _) = setup();
        let day = 86_400;
        store
            .insert_messages(
                account,
                inbox,
                &[
                    mail(1, "Lunch?", day, "ada@x.com", "me@example.com"),
                    // A reply from a client that sends no References, two days later.
                    mail(2, "Re: Lunch?", 3 * day, "me@example.com", "ada@x.com"),
                    // Same subject, someone else entirely: its own conversation.
                    mail(3, "Lunch?", 3 * day, "bob@y.com", "me@example.com"),
                    // Same people, but weeks later: its own conversation.
                    mail(4, "Re: Lunch?", 30 * day, "ada@x.com", "me@example.com"),
                ],
            )
            .unwrap();
        let rows = store.list(&ListTarget::Folder(inbox), None, 10).unwrap();
        let thread =
            |uid: u32| rows.iter().find(|r| r.subject.contains("Lunch") && r.id == uid as i64).unwrap();
        let t: Vec<&str> = (1..=4).map(|u| thread(u).thread_id.as_str()).collect();
        assert_eq!(t[0], t[1]);
        assert_ne!(t[0], t[2]);
        assert_ne!(t[0], t[3]);
    }

    #[test]
    fn thread_list_pages_by_conversation() {
        let (store, account, inbox, archive) = setup();
        let reply = |uid: u32, parent: u32, date: i64, seen: bool| NewMessage {
            in_reply_to: Some(format!("{parent}@example.com")),
            seen,
            ..message(uid, &format!("re {parent}"), date)
        };
        let batch = vec![
            message(1, "a", 10),
            message(2, "b", 20),
            message(3, "c", 30),
            reply(4, 1, 40, false), // a's conversation becomes the newest
            reply(5, 2, 25, true),
        ];
        store.insert_messages(account, inbox, &batch).unwrap();
        // The archived copy of a still counts once in its conversation, as another message would.
        store.insert_messages(account, archive, &[reply(6, 1, 15, true)]).unwrap();

        let page = store.list_threads(&ListTarget::Folder(inbox), None, 2).unwrap();
        let firsts: Vec<_> = page.iter().map(|t| (t.latest.date, t.count)).collect();
        assert_eq!(firsts, [(40, 3), (30, 1)]);
        assert_eq!(page[0].unread, 2, "the first message and the new reply");
        let cursor = Cursor { date: page[1].latest.date, id: page[1].latest.id };
        let next = store.list_threads(&ListTarget::Folder(inbox), Some(cursor), 2).unwrap();
        let dates: Vec<_> = next.iter().map(|t| (t.latest.date, t.count)).collect();
        assert_eq!(dates, [(25, 2)], "b's conversation, once, by its newest message; a is not repeated");
        assert!(store
            .list_threads(&ListTarget::Folder(inbox), Some(Cursor { date: 25, id: next[0].latest.id }), 2)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn actions_on_a_conversation_reach_the_right_messages() {
        let (store, account, inbox, archive) = setup();
        let reply = |uid: u32, date: i64, flagged: bool| NewMessage {
            in_reply_to: Some("1@example.com".into()),
            flagged,
            ..message(uid, "re a", date)
        };
        store
            .insert_messages(account, inbox, &[message(1, "a", 10), reply(2, 20, true), message(3, "b", 5)])
            .unwrap();
        store.insert_messages(account, archive, &[reply(4, 15, true)]).unwrap();
        let rows = store.list_threads(&ListTarget::Folder(inbox), None, 10).unwrap();
        let newest = rows[0].latest.id;
        let ids = |action| {
            let mut ids = store.conversation_ids(&[newest], action, &ListTarget::Folder(inbox)).unwrap();
            ids.sort();
            ids
        };
        assert_eq!(ids(Action::Archive), [1, 2], "only what is in the inbox");
        assert_eq!(ids(Action::MarkRead), [1, 2, 4], "the whole conversation");
        assert_eq!(ids(Action::Unstar), [2, 4], "every star in it");
        assert_eq!(ids(Action::Star), [newest]);
        assert_eq!(rows[0].participants, ["Ada"]);
    }

    #[test]
    fn migration_10_cleans_stored_html() {
        let store = Store::open_in_memory().unwrap();
        let account = store.add_account(&config()).unwrap().id;
        let inbox = store.upsert_folder(account, "INBOX", "inbox").unwrap();
        store.insert_messages(account, inbox, &[message(1, "a", 1)]).unwrap();
        let conn = store.conn.into_inner().unwrap();
        conn.execute("UPDATE bodies SET html = '<p onclick=\"x()\">hi</p><script>bad()</script>'", [])
            .unwrap();
        wind_back(&conn, 9);
        let store = Store::init(conn).unwrap();
        let html: String = store.conn().query_row("SELECT html FROM bodies", [], |r| r.get(0)).unwrap();
        assert_eq!(html, "<p>hi</p>");
    }

    #[test]
    fn a_conversation_lists_its_attachments() {
        let (store, account, inbox, _) = setup();
        let raw = b"From: a@x.com\r\nSubject: report\r\nMessage-ID: <r@x.com>\r\nMIME-Version: 1.0\r\n\
Content-Type: multipart/mixed; boundary=\"b\"\r\n\r\n--b\r\nContent-Type: text/plain\r\n\r\nSee attached.\r\n\
--b\r\nContent-Type: application/pdf; name=\"q3.pdf\"\r\nContent-Disposition: attachment; filename=\"q3.pdf\"\r\n\
Content-Transfer-Encoding: base64\r\n\r\nJVBERi0xLjQK\r\n--b--\r\n";
        let m = crate::mime::parse(1, raw, false, false).unwrap();
        store.insert_messages(account, inbox, &[m]).unwrap();
        let id = store.list(&ListTarget::Folder(inbox), None, 1).unwrap()[0].id;
        let files = &store.thread(id).unwrap()[0].attachments;
        assert_eq!(files.len(), 1);
        assert_eq!((files[0].name.as_str(), files[0].mime.as_str()), ("q3.pdf", "application/pdf"));
    }

    #[test]
    fn moves_to_any_folder_junk_and_back_to_the_inbox() {
        let (store, account, inbox, archive) = setup();
        let junk = store.upsert_folder(account, "Junk", "junk").unwrap();
        store.insert_messages(account, inbox, &[message(1, "a", 1)]).unwrap();
        let id = store.list(&ListTarget::Folder(inbox), None, 1).unwrap()[0].id;
        store.apply(&[id], Action::Junk, 5).unwrap();
        assert_eq!(store.list(&ListTarget::Folder(junk), None, 5).unwrap().len(), 1);
        store.apply(&[id], Action::MoveTo(archive), 5).unwrap();
        assert_eq!(store.list(&ListTarget::Folder(archive), None, 5).unwrap().len(), 1);
        store.apply(&[id], Action::Inbox, 5).unwrap();
        assert_eq!(store.list(&ListTarget::Folder(inbox), None, 5).unwrap().len(), 1);
        let other = store.add_account(&AccountConfig { email: "b@x".into(), ..config() }).unwrap().id;
        let theirs = store.upsert_folder(other, "Archive", "archive").unwrap();
        let applied = store.apply(&[id], Action::MoveTo(theirs), 5).unwrap();
        assert!(applied.token.is_empty(), "no move across accounts");
    }

    #[test]
    fn muted_conversations_skip_the_inbox() {
        let (store, account, inbox, archive) = setup();
        store.insert_messages(account, inbox, &[message(1, "a", 1)]).unwrap();
        let id = store.list(&ListTarget::Folder(inbox), None, 1).unwrap()[0].id;
        store.mute(&[id], true).unwrap();
        assert!(store.muted(id).unwrap());
        let reply = NewMessage { in_reply_to: Some("1@example.com".into()), ..message(2, "re a", 2) };
        store.insert_messages(account, inbox, &[reply, message(3, "other", 3)]).unwrap();
        assert!(store.archive_muted(inbox).unwrap());
        let left: Vec<String> =
            store.list(&ListTarget::Folder(inbox), None, 9).unwrap().into_iter().map(|r| r.subject).collect();
        assert_eq!(left, ["other"]);
        assert_eq!(store.list(&ListTarget::Folder(archive), None, 9).unwrap().len(), 2);
        store.mute(&[id], false).unwrap();
        assert!(!store.muted(id).unwrap());
    }

    #[test]
    fn new_mail_is_unread_recent_inbox_mail_from_others() {
        let (store, account, inbox, archive) = setup();
        store.insert_messages(account, inbox, &[message(1, "old", 100)]).unwrap();
        let (mark, none) = store.new_mail(0, 1_000, false).unwrap();
        assert!(none.is_empty(), "too old to be news");
        let mine = NewMessage { from_addr: "Me@Example.com".into(), ..message(2, "mine", 2_000) };
        let read = NewMessage { seen: true, ..message(3, "read", 2_000) };
        store.insert_messages(account, inbox, &[message(4, "news", 2_000), mine, read]).unwrap();
        store.insert_messages(account, archive, &[message(5, "elsewhere", 2_000)]).unwrap();
        let (next, mail) = store.new_mail(mark, 1_000, false).unwrap();
        assert_eq!(mail.iter().map(|m| m.subject.as_str()).collect::<Vec<_>>(), ["news"]);
        assert!(store.new_mail(next, 1_000, false).unwrap().1.is_empty(), "each message is news once");
        assert_eq!(store.inbox_unread().unwrap(), 3);
        assert_eq!(store.accounts_with_mail().unwrap(), [account]);
        store.mute(&[mail[0].id], true).unwrap();
        assert!(store.new_mail(mark, 1_000, false).unwrap().1.is_empty(), "muted");
    }

    fn mail_to_me(uid: u32, from: &str, to: &str, cc: &str) -> NewMessage {
        NewMessage {
            uid,
            message_id: Some(format!("{uid}@example.com")),
            references: vec!["0@example.com".into()],
            subject: "Plan".into(),
            from_name: "Ada".into(),
            from_addr: from.into(),
            to_addrs: to.into(),
            cc_addrs: cc.into(),
            date: 100,
            body_text: Some("See you.".into()),
            ..Default::default()
        }
    }

    #[test]
    fn replies_go_to_the_right_people() {
        let (store, account, inbox, _) = setup();
        let me = "me@example.com";
        let mut with_reply_to = mail_to_me(2, "ada@x.com", me, "");
        with_reply_to.reply_to = "list@x.com".into();
        let mut followup = mail_to_me(3, "ada@x.com", &format!("{me}, bob@x.com"), "");
        followup.followup_to = "team@x.com".into();
        store
            .insert_messages(
                account,
                inbox,
                &[
                    mail_to_me(1, "ada@x.com", &format!("{me}, bob@x.com"), "carl@x.com, ME@example.com"),
                    with_reply_to,
                    followup,
                    mail_to_me(4, me, "ada@x.com, bob@x.com", "carl@x.com"),
                ],
            )
            .unwrap();
        let id = |uid: u32| {
            store
                .list(&ListTarget::Folder(inbox), None, 9)
                .unwrap()
                .into_iter()
                .find(|r| r.id == uid as i64)
                .unwrap()
                .id
        };
        let r = |uid, kind| store.reply_init(id(uid), kind).unwrap();

        let reply = r(1, ReplyKind::Reply);
        assert_eq!((reply.to.clone(), reply.cc.clone()), (vec!["ada@x.com".to_string()], vec![]));
        assert_eq!(reply.subject, "Re: Plan");
        assert_eq!(reply.in_reply_to.as_deref(), Some("1@example.com"));
        assert_eq!(reply.references, ["0@example.com", "1@example.com"]);
        assert_eq!(reply.quote_text, "See you.");

        let all = r(1, ReplyKind::ReplyAll);
        assert_eq!(all.to, ["ada@x.com"]);
        assert_eq!(all.cc, ["bob@x.com", "carl@x.com"], "everyone else, never me (any case)");

        assert_eq!(r(2, ReplyKind::Reply).to, ["list@x.com"], "Reply-To wins");
        let f = r(3, ReplyKind::ReplyAll);
        assert_eq!(
            (f.to, f.cc),
            (vec!["team@x.com".to_string()], vec![]),
            "Mail-Followup-To wins for reply-all"
        );

        let mine = r(4, ReplyKind::ReplyAll);
        assert_eq!(
            (mine.to, mine.cc),
            (vec!["ada@x.com".into(), "bob@x.com".into()], vec!["carl@x.com".to_string()])
        );
        assert_eq!(
            r(4, ReplyKind::Reply).to,
            ["ada@x.com", "bob@x.com"],
            "replying to my own mail goes on to them"
        );

        let fwd = r(1, ReplyKind::Forward);
        assert!(fwd.to.is_empty() && fwd.in_reply_to.is_none() && fwd.references.is_empty());
        assert_eq!(fwd.subject, "Fwd: Plan");
    }

    fn draft_to(subject: &str) -> Draft {
        Draft {
            html: None,
            to: vec!["b@x".into()],
            cc: vec![],
            bcc: vec![],
            subject: subject.into(),
            body: "first words".into(),
            in_reply_to: None,
            references: vec![],
            attachments: vec![],
            forward_of: None,
            message_id: None,
        }
    }

    #[test]
    fn a_draft_shows_in_drafts_and_in_its_conversation() {
        let (store, account, inbox, _) = setup();
        let drafts = store.upsert_folder(account, "Drafts", "drafts").unwrap();
        store.insert_messages(account, inbox, &[message(1, "plan", 10)]).unwrap();
        let original = store.list(&ListTarget::Folder(inbox), None, 1).unwrap()[0].id;

        let reply = Draft { in_reply_to: Some("1@example.com".into()), ..draft_to("Re: plan") };
        let id = store.save_draft(None, account, reply.clone(), false).unwrap();
        let again =
            store.save_draft(Some(id), account, Draft { body: "more words".into(), ..reply }, false).unwrap();
        assert_eq!(id, again);
        let rows = store.list(&ListTarget::Folder(drafts), None, 9).unwrap();
        assert_eq!(rows.len(), 1, "one row however often it is saved");
        assert_eq!(rows[0].snippet, "more words");
        let conversation = store.thread(original).unwrap();
        assert_eq!(conversation.len(), 2, "the draft sits in the conversation it answers");
        assert_eq!(conversation[1].draft_id, Some(id));
        assert_eq!(store.draft_for_message(rows[0].id).unwrap().unwrap().id, id);

        store.discard_draft(id).unwrap();
        assert!(store.list(&ListTarget::Folder(drafts), None, 9).unwrap().is_empty());
        assert!(store.undo_discard(id).unwrap());
        assert_eq!(store.list(&ListTarget::Folder(drafts), None, 9).unwrap().len(), 1);
        store.draft_sent(id).unwrap();
        assert!(store.list(&ListTarget::Folder(drafts), None, 9).unwrap().is_empty());
    }

    #[test]
    fn drafts_go_to_the_server_when_they_rest_and_leave_when_sent() {
        let (store, account, _, _) = setup();
        store.upsert_folder(account, "Drafts", "drafts").unwrap();
        let id = store.save_draft(None, account, draft_to("hi"), false).unwrap();
        assert!(store.drafts_due(account).unwrap().is_empty(), "still being typed");
        store.save_draft(Some(id), account, draft_to("hi"), true).unwrap();
        let due = store.drafts_due(account).unwrap();
        let DraftSync::Upload { version, previous, .. } = &due[0] else { panic!("{due:?}") };
        assert!(previous.is_none());
        store.draft_uploaded(id, "Drafts", *version, Some((7, 41))).unwrap();
        assert!(store.drafts_due(account).unwrap().is_empty(), "this version is up");

        let draft = store.draft(id).unwrap().unwrap().draft;
        store.queue_send(account, draft, 5).unwrap();
        store.draft_sent(id).unwrap();
        assert!(store.drafts_due(account).unwrap().is_empty(), "its copy stays while the send waits");
        let work = store.claim_due(account).unwrap();
        assert!(work.is_empty(), "still in the undo window");
        store.conn().execute("DELETE FROM outbox", []).unwrap();
        let due = store.drafts_due(account).unwrap();
        assert!(matches!(&due[0], DraftSync::Remove { copy: Some((7, 41)), .. }), "{due:?}");
    }

    #[test]
    fn undoing_a_send_makes_it_a_draft_again() {
        let (store, account, _, _) = setup();
        let drafts = store.upsert_folder(account, "Drafts", "drafts").unwrap();
        let id = store.save_draft(None, account, draft_to("hi"), false).unwrap();
        let draft = store.draft(id).unwrap().unwrap().draft;
        let token = store.queue_send(account, draft, 5).unwrap();
        store.draft_sent(id).unwrap();
        assert!(store.list(&ListTarget::Folder(drafts), None, 9).unwrap().is_empty());
        assert!(store.undo(&[token]).unwrap());
        assert_eq!(store.list(&ListTarget::Folder(drafts), None, 9).unwrap().len(), 1, "back in Drafts");
        assert!(store.drafts_due(account).unwrap().iter().all(|d| !matches!(d, DraftSync::Remove { .. })));
    }

    #[test]
    fn a_refused_send_comes_back_as_a_draft() {
        let (store, account, _, _) = setup();
        let work = store.queue_send(account, draft_to("oops"), 0).unwrap();
        store.claim_due(account).unwrap();
        store.outbox_failed(work, "550 no such user", Failure::Permanent).unwrap();
        let record = store.problem_to_draft(work).unwrap();
        assert_eq!(record.draft.subject, "oops");
        assert!(store.outbox_problems().unwrap().is_empty());
        assert!(record.draft.message_id.is_some(), "keeps its Message-ID");
    }

    #[test]
    fn autocomplete_ranks_people_written_to_first() {
        let (store, account, inbox, _) = setup();
        let me = "me@example.com";
        let mut batch = vec![
            mail_to_me(1, "anna@x.com", me, ""),
            mail_to_me(2, "anna@x.com", me, ""),
            mail_to_me(3, "noreply@anything.com", me, ""),
        ];
        batch[0].from_name = "Anna Bell".into();
        batch[1].from_name = "Anna Bell".into();
        store.insert_messages(account, inbox, &batch).unwrap();
        store.queue_send(account, Draft { to: vec!["andy@y.com".into()], ..draft_to("hi") }, 5).unwrap();
        let names = |q: &str| store.contacts(q, 5).unwrap().into_iter().map(|c| c.email).collect::<Vec<_>>();
        assert_eq!(names("an"), ["andy@y.com", "anna@x.com"], "one send beats two received");
        assert_eq!(names("bell"), ["anna@x.com"], "a word of the name");
        assert_eq!(store.contacts("anna", 5).unwrap()[0].name, "Anna Bell");
        assert!(names("noreply").is_empty(), "automated senders are left out");
        assert!(names("").is_empty());
    }

    #[test]
    fn a_contact_card_holds_their_latest_conversations_once_each() {
        let (store, account, inbox, archive) = setup();
        let me = "me@example.com";
        store
            .insert_messages(
                account,
                inbox,
                &[
                    mail(1, "Budget", 100, "anna@x.com", me),
                    mail(2, "Re: Budget", 200, "anna@x.com", me),
                    mail(3, "Lunch", 300, "bob@x.com", &format!("{me}, Anna@x.com")),
                    mail(4, "Other", 400, "carl@x.com", me),
                ],
            )
            .unwrap();
        store.insert_messages(account, archive, &[mail(5, "Trip", 50, me, "anna@x.com")]).unwrap();
        let card = store.contact_card("ANNA@x.com", 5).unwrap();
        let subjects: Vec<_> = card.recent.iter().map(|m| m.subject.as_str()).collect();
        assert_eq!(
            subjects,
            ["Lunch", "Re: Budget", "Trip"],
            "newest first, one row a conversation, either way"
        );
        assert_eq!(card.received, 2);
        assert_eq!(store.contact_card("anna@x.com", 1).unwrap().recent.len(), 1);
        assert!(store.contact_card("nobody@x.com", 5).unwrap().recent.is_empty());
    }

    #[test]
    fn settings_keep_their_json() {
        let store = Store::open_in_memory().unwrap();
        store.set_setting("theme", &serde_json::json!("dark")).unwrap();
        store.set_setting("theme", &serde_json::json!("light")).unwrap();
        store.set_setting("readAfterMs", &serde_json::json!(1000)).unwrap();
        let all = store.settings().unwrap();
        assert_eq!(all["theme"], "light");
        assert_eq!(all["readAfterMs"], 1000);
    }

    #[test]
    fn the_starred_split_is_starred_inbox_mail() {
        let (store, account, inbox, archive) = setup();
        let starred = |uid, date| NewMessage { flagged: true, ..message(uid, "s", date) };
        store.insert_messages(account, inbox, &[starred(1, 10), message(2, "plain", 20)]).unwrap();
        store.insert_messages(account, archive, &[starred(3, 30)]).unwrap();
        let split = ListTarget::Role(STARRED.into());
        let rows = store.list_threads(&split, None, 10).unwrap();
        assert_eq!(rows.iter().map(|r| r.latest.id).collect::<Vec<_>>(), [1], "inbox only, starred only");
        assert_eq!(store.conversation_ids(&[1], Action::Archive, &split).unwrap(), [1]);
    }

    #[test]
    fn migration_8_fills_in_normalised_subjects() {
        let store = Store::open_in_memory().unwrap();
        let account = store.add_account(&config()).unwrap().id;
        let inbox = store.upsert_folder(account, "INBOX", "inbox").unwrap();
        store.insert_messages(account, inbox, &[message(1, "Re: Budget", 1)]).unwrap();
        let conn = store.conn.into_inner().unwrap();
        wind_back(&conn, 7);
        let store = Store::init(conn).unwrap();
        let norm: String =
            store.conn().query_row("SELECT subject_norm FROM messages", [], |r| r.get(0)).unwrap();
        assert_eq!(norm, "budget");
    }

    #[test]
    fn snippets_fill_in_before_bodies() {
        let (store, account, inbox, _) = setup();
        let text = Part {
            section: "1.1".into(),
            mime: "text/plain".into(),
            encoding: "7bit".into(),
            charset: None,
            size: 10,
            name: None,
            attachment: false,
        };
        let image = Part { section: "1".into(), mime: "image/png".into(), ..text.clone() };
        let mut with_text = message(1, "a", 2);
        let mut no_text = message(2, "b", 1);
        for (m, parts) in [(&mut with_text, vec![text.clone()]), (&mut no_text, vec![image])] {
            m.headers_only = true;
            m.parts = Some(parts);
        }
        store.insert_messages(account, inbox, &[with_text, no_text]).unwrap();
        assert_eq!(
            store.snippets_needed(inbox, 10).unwrap(),
            [(1, text)],
            "a part without text is not fetched"
        );
        store.set_snippets(inbox, &[(1, "Hi there".into())]).unwrap();
        assert!(store.snippets_needed(inbox, 10).unwrap().is_empty());
        let row = store.list(&ListTarget::Folder(inbox), None, 10).unwrap().remove(0);
        assert_eq!(row.snippet, "Hi there");
        assert_eq!(store.bodies_needed(inbox, 0, 10).unwrap().len(), 2, "both still want their bodies");
    }

    fn draft() -> Draft {
        Draft {
            html: None,
            to: vec!["b@x".into()],
            cc: vec![],
            subject: "Lunch?".into(),
            body: "".into(),
            bcc: vec![],
            in_reply_to: None,
            references: vec![],
            attachments: vec![],
            forward_of: None,
            message_id: None,
        }
    }

    #[test]
    fn a_send_that_may_have_gone_out_waits_for_the_person() {
        let (store, account, _, _) = setup();
        let work = store.queue_send(account, draft(), 0).unwrap();
        store.claim_due(account).unwrap();
        store.outbox_failed(work, "connection reset", Failure::MaybeSent).unwrap();
        assert_eq!(store.next_due(account).unwrap(), None, "not sent again on its own");
        let problems = store.outbox_problems().unwrap();
        assert!(problems[0].maybe_sent);
        let id_before = match store.outbox_op(work).unwrap() {
            Some(OutboxOp::Send(d)) => d.message_id.expect("queued sends get a Message-ID"),
            other => panic!("{other:?}"),
        };
        assert!(id_before.ends_with("@example.com>"), "{id_before}");
        store.retry_outbox(work).unwrap();
        let again = store.claim_due(account).unwrap().remove(0);
        assert_eq!(again.0, work, "the person can send it again");
        assert!(
            matches!(again.1, OutboxOp::Send(d) if d.message_id == Some(id_before)),
            "as the same message"
        );
    }

    /// Tern stopped (closed, crashed, power cut) in the middle of a pass, then starts again on the same file.
    #[test]
    fn restart_recovers_interrupted_work() {
        let path = std::env::temp_dir().join(format!("tern-restart-{}.db", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let (sending, waiting, marking) = {
            let store = Store::open(&path).unwrap();
            let account = store.add_account(&config()).unwrap().id;
            let inbox = store.upsert_folder(account, "INBOX", "inbox").unwrap();
            let marking = queued_mark_read(&store, account, inbox);
            let sending = store.queue_send(account, draft(), 0).unwrap();
            let waiting = store.queue_send(account, draft(), 0).unwrap();
            store.claim_due(account).unwrap();
            store.outbox_sending(sending).unwrap();
            (sending, waiting, marking)
        };
        let store = Store::open(&path).unwrap();
        let problems = store.outbox_problems().unwrap();
        assert_eq!(problems.iter().map(|p| (p.id, p.maybe_sent)).collect::<Vec<_>>(), [(sending, true)]);
        let mut due: Vec<i64> = store.claim_due(1).unwrap().into_iter().map(|(id, _)| id).collect();
        due.sort();
        assert_eq!(due, [marking, waiting], "work that had not started goes again");
        drop(store);
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
        }
    }

    #[test]
    fn renumbering_keeps_messages_queued_work_is_about_to_change() {
        let (store, account, inbox, _) = setup();
        store.insert_messages(account, inbox, &[message(1, "a", 1), message(2, "b", 2)]).unwrap();
        let rows = store.list(&ListTarget::Folder(inbox), None, 10).unwrap();
        let (b, a) = (rows[0].id, rows[1].id);
        store.apply(&[a], Action::Star, 5).unwrap();
        store.reset_folder(inbox).unwrap();
        assert!(store.local_uids(inbox).unwrap().is_empty(), "no uid of the old numbering survives");
        let left: Vec<i64> =
            store.list(&ListTarget::Folder(inbox), None, 10).unwrap().iter().map(|r| r.id).collect();
        assert_eq!(left, [a], "the starred one stays, still starred, until the server has the star");
        assert!(store.list(&ListTarget::Folder(inbox), None, 10).unwrap()[0].flagged);
        assert!(!left.contains(&b));
        // The next sync claims it back by Message-ID under the new numbering.
        let mut again = message(1, "a", 1);
        again.uid = 41;
        store.insert_messages(account, inbox, &[again]).unwrap();
        assert_eq!(store.local_uids(inbox).unwrap(), [41].into());
    }

    /// Undoes the schema steps after `version` on a current database, so a migration test can start from a real
    /// database at that version. Each new migration adds its undo here.
    fn wind_back(conn: &Connection, version: i64) {
        for from in (version..SCHEMA_VERSION).rev() {
            let undo = match from {
                16 => "DROP INDEX messages_date; DROP TABLE snippets;",
                15 => "ALTER TABLE messages DROP COLUMN bulk; DROP TABLE sender_splits; DROP TABLE reminders;",
                // Step 14 only changed data.
                14 => "",
                13 => "DROP TABLE contacts;",
                12 => "DROP TABLE drafts;",
                11 => {
                    "ALTER TABLE messages DROP COLUMN cc_addrs; ALTER TABLE messages DROP COLUMN reply_to;
                     ALTER TABLE messages DROP COLUMN followup_to; ALTER TABLE messages DROP COLUMN refs;"
                }
                10 => "DROP TABLE muted;",
                // Step 9 only changed data.
                9 => "",
                8 => "DROP TABLE settings;",
                7 => "DROP INDEX messages_subject; ALTER TABLE messages DROP COLUMN subject_norm;",
                6 => {
                    "ALTER TABLE messages DROP COLUMN list_id; ALTER TABLE messages DROP COLUMN list_unsubscribe;
                     ALTER TABLE messages DROP COLUMN parts;"
                }
                5 => "ALTER TABLE outbox DROP COLUMN maybe_sent;",
                4 => "",
                _ => panic!("no undo for schema step {from}"),
            };
            conn.execute_batch(undo).unwrap();
        }
        conn.execute_batch(&format!("PRAGMA user_version = {version};")).unwrap();
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
    fn migration_15_fetches_again_mail_whose_files_were_never_listed() {
        let (store, account, inbox, _) = setup();
        let mut with_file = message(1, "a", 1);
        with_file.has_attachments = true;
        store.insert_messages(account, inbox, &[with_file, message(2, "b", 2)]).unwrap();
        let conn = store.conn.into_inner().unwrap();
        // As stored before step 6: the flag from the parsed body, no parts.
        conn.execute_batch("UPDATE messages SET parts = NULL, body_state = 'full';").unwrap();
        wind_back(&conn, 14);
        let store = Store::init(conn).unwrap();
        let states: Vec<(u32, String)> = store
            .conn()
            .prepare("SELECT uid, body_state FROM messages ORDER BY uid")
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        assert_eq!(states, [(1, "wanted".to_string()), (2, "full".to_string())]);
        assert_eq!(store.bodies_needed(inbox, i64::MAX, 10).unwrap(), [(1, None)]);
    }

    #[test]
    fn migration_16_sorts_mail_already_here_into_splits() {
        let (store, account, inbox, _) = setup();
        let news = NewMessage { list_id: Some("<news.example.com>".into()), ..message(2, "news", 2) };
        let robot = NewMessage { from_addr: "noreply@example.com".into(), ..message(3, "robot", 3) };
        store.insert_messages(account, inbox, &[message(1, "person", 1), news, robot]).unwrap();
        let conn = store.conn.into_inner().unwrap();
        wind_back(&conn, 15);
        let store = Store::init(conn).unwrap();
        assert_eq!(subjects(&store, IMPORTANT), ["person"]);
        assert_eq!(subjects(&store, OTHER), ["robot", "news"]);
    }

    #[test]
    fn migration_17_adds_the_date_index_and_snippets() {
        let (store, account, inbox, _) = setup();
        store.insert_messages(account, inbox, &[message(1, "kept", 1)]).unwrap();
        let conn = store.conn.into_inner().unwrap();
        wind_back(&conn, 16);
        let store = Store::init(conn).unwrap();
        assert_eq!(store.search("kept", 10).unwrap().rows.len(), 1);
        assert!(store.snippets().unwrap().is_empty());
    }

    fn subjects(store: &Store, role: &str) -> Vec<String> {
        let rows = store.list_threads(&ListTarget::Role(role.into()), None, 20).unwrap();
        rows.into_iter().map(|r| r.latest.subject).collect()
    }

    #[test]
    fn moving_a_sender_changes_its_split() {
        let (store, account, inbox, archive) = setup();
        let news = NewMessage {
            message_id: Some("n@x".into()),
            precedence_bulk: true,
            from_addr: "News@Shop.example".into(),
            ..message(1, "sale", 1)
        };
        store.insert_messages(account, inbox, &[news, message(2, "hello", 2)]).unwrap();
        assert_eq!(subjects(&store, OTHER), ["sale"]);
        assert_eq!(store.split_unread().unwrap(), (1, 1));
        let sale = store.list_threads(&ListTarget::Role(OTHER.into()), None, 1).unwrap()[0].latest.id;
        store.set_split(&[sale], false).unwrap();
        assert_eq!(subjects(&store, IMPORTANT), ["hello", "sale"]);
        let later = NewMessage {
            from_addr: "news@shop.example".into(),
            precedence_bulk: true,
            ..message(3, "sale 2", 3)
        };
        store.insert_messages(account, inbox, &[later]).unwrap();
        assert!(subjects(&store, OTHER).is_empty(), "the sender's later mail follows");
        store.set_split(&[sale], true).unwrap();
        assert_eq!(subjects(&store, IMPORTANT), ["hello"]);
        let news = |other| -> Vec<String> {
            store.new_mail(0, 0, other).unwrap().1.into_iter().map(|m| m.subject).collect()
        };
        assert_eq!(news(false), ["hello"], "Other stays quiet unless asked");
        assert_eq!(news(true).len(), 3);
        // Archiving from Other takes the conversation out of the inbox.
        store
            .apply(
                &store.conversation_ids(&[sale], Action::Archive, &ListTarget::Role(OTHER.into())).unwrap(),
                Action::Archive,
                0,
            )
            .unwrap();
        assert_eq!(subjects(&store, OTHER), ["sale 2"]);
        assert_eq!(store.list(&ListTarget::Folder(archive), None, 9).unwrap().len(), 1);
    }

    #[test]
    fn snoozed_conversations_leave_the_inbox_until_due_or_answered() {
        let (store, account, inbox, _) = setup();
        store.insert_messages(account, inbox, &[message(1, "later", 100), message(2, "now", 200)]).unwrap();
        let later = store.list_threads(&ListTarget::Role("inbox".into()), None, 9).unwrap()[1].latest.id;
        store.snooze(&[later], 5_000, 1_000).unwrap();
        assert_eq!(subjects(&store, "inbox"), ["now"]);
        assert_eq!(subjects(&store, IMPORTANT), ["now"]);
        let snoozed = store.list_threads(&ListTarget::Role(SNOOZED.into()), None, 9).unwrap();
        assert_eq!((snoozed[0].latest.subject.as_str(), snoozed[0].snoozed_until), ("later", Some(5_000)));
        assert!(store.wake_snoozed(4_999).unwrap().is_empty());
        assert!(
            store.new_mail(0, 0, false).unwrap().1.iter().all(|m| m.subject == "now"),
            "no notice while snoozed"
        );
        let woke = store.wake_snoozed(5_000).unwrap();
        assert_eq!(woke.iter().map(|m| m.id).collect::<Vec<_>>(), [later]);
        assert_eq!(subjects(&store, "inbox"), ["now", "later"]);

        // A reply brings it back early.
        store.snooze(&[later], 9_000, 1_000).unwrap();
        let reply =
            NewMessage { in_reply_to: Some("1@example.com".into()), ..message(3, "Re: later", 2_000) };
        store.insert_messages(account, inbox, &[reply]).unwrap();
        assert_eq!(store.wake_snoozed(1_500).unwrap().len(), 1);
        store.snooze(&[later], 9_000, 3_000).unwrap();
        store.unsnooze(&[later]).unwrap();
        assert!(subjects(&store, SNOOZED).is_empty());
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
    fn migration_5_drops_only_generated_html() {
        // A current database with two bodies in it, wound back to schema 4.
        let store = Store::open_in_memory().unwrap();
        let account = store.add_account(&config()).unwrap().id;
        let folder = store.upsert_folder(account, "INBOX", "inbox").unwrap();
        store.insert_messages(account, folder, &[message(1, "a", 1), message(2, "b", 2)]).unwrap();
        let conn = store.conn.into_inner().unwrap();
        conn.execute_batch("DELETE FROM bodies;").unwrap();
        wind_back(&conn, 4);
        let generated = mail_parser::MessageParser::default()
            .parse(b"Subject: x\r\n\r\na < b\r\nline two\r\n".as_slice())
            .unwrap()
            .body_html(0)
            .unwrap()
            .into_owned();
        conn.execute(
            "INSERT INTO bodies (message_id, text, html) VALUES (1, ?1, ?2), (2, 'hi', '<p>hi</p>')",
            params!["a < b\r\nline two\r\n", generated],
        )
        .unwrap();
        let store = Store::init(conn).unwrap();
        let html: Vec<Option<String>> = store
            .conn()
            .prepare("SELECT html FROM bodies ORDER BY message_id")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        assert_eq!(html, [None, Some("<p>hi</p>".to_string())]);
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
        assert_eq!(store.search("lunch", 10).unwrap().rows.len(), 1, "headers are searchable at once");
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
        assert_eq!(store.search("friday", 10).unwrap().rows.len(), 1, "the body is in the index now");
        assert_eq!(store.search("lunch", 10).unwrap().rows.len(), 1, "and the headers still are");
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
