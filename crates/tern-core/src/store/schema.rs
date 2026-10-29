//! The schema and its migrations: v1 as `SCHEMA`, then numbered steps in `migrate`, each tested from the
//! version before it (tests.rs).

use super::*;

/// Version 1, the starting point. Later versions are steps on top of it in `migrate`, so a new database and an
/// upgraded one go through the same SQL.
pub(super) const SCHEMA: &str = r#"
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

/// Before a newer Tern migrates the database, a copy of it as it was: migrations only go forward, so this copy is
/// how someone goes back to the version they had (docs/beta.md, "Going back"). Saved next to it as
/// `mail.db.before-v<old version>`; the two newest are kept.
pub(super) fn backup_before_migrating(conn: &Connection, path: &Path) -> Result<()> {
    let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    if version == 0 || version >= SCHEMA_VERSION {
        return Ok(());
    }
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("mail.db");
    let copy = path.with_file_name(format!("{name}.before-v{version}"));
    let _ = std::fs::remove_file(&copy);
    // VACUUM INTO writes a consistent, compact copy, WAL included, without closing the database.
    conn.execute("VACUUM INTO ?1", [copy.to_string_lossy()]).with_context(|| {
        format!("Could not save a copy of the mail database before upgrading it ({})", copy.display())
    })?;
    log::info!("saved the mail database as it was (schema {version}) to {}", copy.display());
    let dir = path.parent().unwrap_or(Path::new("."));
    let prefix = format!("{name}.before-v");
    let mut copies: Vec<(i64, std::path::PathBuf)> = std::fs::read_dir(dir)?
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let v = e.file_name().to_str()?.strip_prefix(&prefix)?.parse().ok()?;
            Some((v, e.path()))
        })
        .collect();
    copies.sort_by_key(|(v, _)| std::cmp::Reverse(*v));
    for (_, old) in copies.into_iter().skip(2) {
        let _ = std::fs::remove_file(old);
    }
    Ok(())
}

/// Brings the database up to SCHEMA_VERSION one step at a time, each step in its own transaction together with
/// its version number, so a crash leaves the database at a whole version. Forward only.
pub(super) fn migrate(conn: &Connection) -> Result<()> {
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
            // How many messages the server said a folder holds at its last SELECT, for download progress. NULL
            // until the folder is first checked.
            17 => "ALTER TABLE folders ADD COLUMN server_count INTEGER;",
            // Send later: a scheduled send, and one held because its time passed while Tern was closed. Follow-ups:
            // the sent message a reminder waits on (its bare Message-ID, which finds the conversation once the copy
            // in Sent is here), and whether it has come due and been announced.
            18 => {
                "ALTER TABLE outbox ADD COLUMN scheduled INTEGER NOT NULL DEFAULT 0;
                 ALTER TABLE outbox ADD COLUMN held INTEGER NOT NULL DEFAULT 0;
                 ALTER TABLE reminders ADD COLUMN message_id TEXT;
                 ALTER TABLE reminders ADD COLUMN fired INTEGER NOT NULL DEFAULT 0;"
            }
            // Snippets for one account only, that can also fill in the subject and Cc, and when each was last used.
            // Signatures move out of settings into their own table: several per account, one for new mail and one
            // for replies. The plain-text one each account had becomes both.
            19 => {
                "ALTER TABLE snippets ADD COLUMN account_id INTEGER REFERENCES accounts(id) ON DELETE CASCADE;
                 ALTER TABLE snippets ADD COLUMN subject TEXT;
                 ALTER TABLE snippets ADD COLUMN cc TEXT NOT NULL DEFAULT '[]';
                 ALTER TABLE snippets ADD COLUMN last_used INTEGER;
                 CREATE TABLE signatures (id INTEGER PRIMARY KEY,
                                          account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
                                          name TEXT NOT NULL DEFAULT '', body TEXT NOT NULL DEFAULT '', html TEXT,
                                          for_new INTEGER NOT NULL DEFAULT 0, for_reply INTEGER NOT NULL DEFAULT 0);
                 INSERT INTO signatures (account_id, name, body, for_new, for_reply)
                     SELECT a.id, 'Signature', trim(j.value), 1, 1
                     FROM settings s JOIN json_each(s.value) j JOIN accounts a ON a.id = CAST(j.key AS INTEGER)
                     WHERE s.key = 'signatures' AND trim(j.value) != '';
                 DELETE FROM settings WHERE key = 'signatures';"
            }
            // How each account signs in: a password (every account so far) or Google in the browser.
            20 => "ALTER TABLE accounts ADD COLUMN auth TEXT NOT NULL DEFAULT 'password';",
            // Gmail labels: which messages (by bare Message-ID) a label folder holds. Label folders keep no message
            // rows of their own; their messages are All Mail's.
            21 => {
                "CREATE TABLE message_labels (folder_id INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
                                              message_id TEXT NOT NULL, PRIMARY KEY (folder_id, message_id))
                     WITHOUT ROWID;
                 CREATE INDEX message_labels_message ON message_labels (message_id);"
            }
            // A signature's HTML can be the person's own, pasted from another mail app (Signature::custom).
            22 => "ALTER TABLE signatures ADD COLUMN custom INTEGER NOT NULL DEFAULT 0;",
            // A flag change the server sent during a body fetch was stored as an empty body, so that message showed
            // its subject and nothing else, for good. Every empty body is fetched once more; one that really is
            // empty comes back empty.
            23 => {
                "UPDATE messages SET body_state = 'none'
                 WHERE body_state = 'full' AND uid IS NOT NULL AND id IN (
                     SELECT message_id FROM bodies WHERE COALESCE(text, '') = '' AND COALESCE(html, '') = '');
                 DELETE FROM bodies WHERE message_id IN (SELECT id FROM messages WHERE body_state = 'none');"
            }
            // Optional AI (package 10): summaries kept by what was sent (`key_hash`, a SHA-256 of the prompt and the
            // mail it carried) and the model that answered, so the same conversation is never paid for twice; and
            // the tokens spent each day (UTC day number), for the daily limit.
            24 => {
                "CREATE TABLE ai_cache (kind TEXT NOT NULL, key_hash TEXT NOT NULL, model TEXT NOT NULL,
                                        account_id INTEGER REFERENCES accounts(id) ON DELETE CASCADE,
                                        text TEXT NOT NULL, created INTEGER NOT NULL,
                                        PRIMARY KEY (kind, key_hash, model));
                 CREATE TABLE ai_usage (day INTEGER PRIMARY KEY, tokens INTEGER NOT NULL DEFAULT 0);"
            }
            // How the person writes from an account, learned from their sent mail when they asked (ai::learn_style),
            // for Write with AI and suggested replies. One note per account, editable.
            25 => {
                "CREATE TABLE ai_styles (account_id INTEGER PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
                                         note TEXT NOT NULL, samples INTEGER NOT NULL DEFAULT 0,
                                         updated INTEGER NOT NULL);"
            }
            // Passages the person marked while reading (package 05, reading R5), each with an optional note. Kept
            // by the message's Message-ID, so a message in two folders (Gmail labels) shows the same marks.
            26 => {
                "CREATE TABLE marks (id INTEGER PRIMARY KEY,
                                     account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
                                     message_key TEXT NOT NULL, text TEXT NOT NULL,
                                     note TEXT NOT NULL DEFAULT '', created INTEGER NOT NULL);
                 CREATE INDEX marks_by_message ON marks (account_id, message_key);"
            }
            // The Read later shelf (package 05, reading R6): conversations kept to read later, out of the inbox's
            // lists until taken off or answered. Tern's alone, like snooze.
            27 => {
                "CREATE TABLE read_later (account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
                                          thread_id TEXT NOT NULL, added INTEGER NOT NULL,
                                          PRIMARY KEY (account_id, thread_id));"
            }
            // Data only: mail joined into a conversation by its subject alone, though it was no reply, gets its own
            // again (see `split_subject_threads`).
            28 => "",
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
        if from == 28 {
            split_subject_threads(conn)?;
        }
        conn.execute_batch(&format!("PRAGMA user_version = {}; COMMIT;", from + 1))?;
    }
    Ok(())
}

/// Undoes the subject joins `thread_for` no longer makes: a message with no References and no "Re:" in its subject
/// that sits in a conversation not its own gets its own back, and then, oldest first, each message that names others
/// goes with the first of them it can find, as `thread_for` does. Nothing else changes; no row goes away.
pub(super) fn split_subject_threads(conn: &Connection) -> Result<()> {
    let roots: Vec<(i64, String)> = conn
        .prepare(
            "SELECT id, coalesce(message_id, 'id:' || id), subject FROM messages
             WHERE refs = '' AND thread_id <> coalesce(message_id, '')",
        )?
        .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?)))?
        .filter_map(|r| r.ok())
        .filter(|(_, _, subject)| !super::is_reply_subject(subject))
        .map(|(id, own, _)| (id, own))
        .collect();
    if roots.is_empty() {
        return Ok(());
    }
    let mut own = conn.prepare("UPDATE messages SET thread_id = ?2 WHERE id = ?1")?;
    for (id, thread) in &roots {
        own.execute(params![id, thread])?;
    }
    // Replies follow what they name, oldest first, so a reply to a reply lands with its conversation.
    let replies: Vec<(i64, i64, String)> = conn
        .prepare("SELECT id, account_id, refs FROM messages WHERE refs <> '' ORDER BY date, id")?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
        .collect::<rusqlite::Result<_>>()?;
    let mut find =
        conn.prepare("SELECT thread_id FROM messages WHERE account_id = ?1 AND message_id = ?2 LIMIT 1")?;
    for (id, account, refs) in replies {
        for named in refs.split_whitespace() {
            if let Some(thread) =
                find.query_row(params![account, named], |r| r.get::<_, String>(0)).optional()?
            {
                own.execute(params![id, thread])?;
                break;
            }
        }
    }
    Ok(())
}

/// Marks the mail already stored that goes to Other, as `insert_messages` does from now on. Precedence was not
/// kept, so this goes by the list headers and the sender.
pub(super) fn fill_bulk(conn: &Connection) -> Result<()> {
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
pub(super) fn fill_contacts(conn: &Connection) -> Result<()> {
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

pub(super) fn sanitize_stored_html(conn: &Connection) -> Result<()> {
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

pub(super) fn fill_subject_norm(conn: &Connection) -> Result<()> {
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
