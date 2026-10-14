# Data model

Schema v1 is in `crates/tern-core/src/store.rs`. The groups below are candidate schema additions from
the original work packages, not a mandate to implement them in numeric sprint order. Allocate sequential
migration versions when a milestone slice is implemented; calendar/AI/contacts tables are not required
for core mail. If Gmail API is selected early, its fields/adapters arrive in M2 rather than after Outlook.
Plan stable local identities and remote locations before provider-specific mutations. These schema
ideas must be reconciled with the selected task slice so migrations are planned, not improvised. Migrations are forward-only, numbered, in `store::migrate()`; each one is a
`match version { 1 => …, 2 => … }` arm with its SQL and a test that opens a v(n-1) fixture database.

## v1
`accounts`, `folders`, `messages`, `bodies`, `messages_fts` (contentless), `outbox`.

## v2 — package 01, connection security (implemented 2026-10-13)
```sql
ALTER TABLE accounts ADD COLUMN imap_security TEXT NOT NULL DEFAULT 'tls';      -- 'tls' | 'starttls'
ALTER TABLE accounts ADD COLUMN smtp_security TEXT NOT NULL DEFAULT 'starttls';
UPDATE accounts SET smtp_security = 'tls' WHERE smtp_port = 465;              -- keep what Tern did before
```
`store::migrate()` applies v1 (`SCHEMA`) and each later step in its own transaction with its version, and refuses a
database from a newer Tern. Tests: a v1 database with accounts migrates to the same `accounts` table as a new one.

## v3 — package 01, outbox give-up (implemented 2026-10-14)
```sql
ALTER TABLE outbox ADD COLUMN gave_up_at INTEGER;   -- when retrying stopped; NULL while it is still tried
```
Given-up rows stay (never dropped silently) and keep their UIDs pending for sync until retried or discarded.

## v4 — package 01, headers first (implemented 2026-10-14)
```sql
ALTER TABLE messages ADD COLUMN size INTEGER;                                  -- RFC822.SIZE
ALTER TABLE messages ADD COLUMN body_state TEXT NOT NULL DEFAULT 'full';       -- 'none' | 'wanted' | 'full'
CREATE INDEX messages_bodyless ON messages (folder_id, date DESC) WHERE body_state != 'full';
```
Rows from before v4 have their bodies, hence the default. A headers-only row has no `bodies` row and is in the
search index by subject and sender only, until `fill_bodies` replaces its index entry.

## v5 — package 01, plain text stays plain (implemented 2026-10-14)
```sql
UPDATE bodies SET html = NULL WHERE text IS NOT NULL AND html = '<html><body>' ||
  replace(replace(replace(text, char(13), ''), '<', '&lt;'), char(10), '<br/>') || '</body></html>';
```
mail-parser's `body_html` turns a text-only message into HTML, which the reader showed on white in dark mode. Only
a real `text/html` part is stored as HTML now; this clears exactly the generated HTML already stored.

## v6 — package 00, reliability gate (implemented 2026-10-14)
```sql
ALTER TABLE outbox ADD COLUMN maybe_sent INTEGER NOT NULL DEFAULT 0;   -- a send that may have gone out
```
`outbox.claimed` now has three values: 0 queued, 1 claimed by a pass, 2 handed to the server (`outbox_sending`).
On start, 1 goes back to 0; a send left at 2 becomes a problem with `maybe_sent = 1` rather than being sent again.
Payloads (JSON, no migration needed) gained `validity` (the folder's UIDVALIDITY when queued) and `waiting` (row
ids whose uid in the folder is not known yet), both defaulting for rows queued by older versions.

## Next (planned for package 01: sync v2, threads; version number allocated when implemented)
```sql
ALTER TABLE accounts ADD COLUMN auth_kind TEXT NOT NULL DEFAULT 'password';   -- 'password' | 'oauth'
ALTER TABLE accounts ADD COLUMN provider TEXT;                                 -- 'google' | 'microsoft' | NULL
ALTER TABLE accounts ADD COLUMN caps TEXT NOT NULL DEFAULT '{}';               -- JSON: condstore, qresync, move, idle, gmail_ext
ALTER TABLE accounts ADD COLUMN state TEXT NOT NULL DEFAULT 'ok';              -- 'ok' | 'auth-failed' | 'disabled'

ALTER TABLE messages ADD COLUMN bodystructure TEXT;                            -- JSON
ALTER TABLE messages ADD COLUMN cc_addrs TEXT NOT NULL DEFAULT '';
ALTER TABLE messages ADD COLUMN in_reply_to TEXT;
ALTER TABLE messages ADD COLUMN refs TEXT;                                     -- References header, space-separated
ALTER TABLE messages ADD COLUMN list_unsubscribe TEXT;
ALTER TABLE messages ADD COLUMN list_id TEXT;
ALTER TABLE messages ADD COLUMN gm_msgid INTEGER;                              -- X-GM-MSGID
ALTER TABLE messages ADD COLUMN modseq INTEGER;

CREATE TABLE threads (
    id INTEGER PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    key TEXT NOT NULL,                 -- X-GM-THRID or our derived key
    subject TEXT NOT NULL DEFAULT '',
    subject_norm TEXT NOT NULL DEFAULT '',
    first_date INTEGER NOT NULL,
    last_date INTEGER NOT NULL,
    message_count INTEGER NOT NULL DEFAULT 0,
    unread_count INTEGER NOT NULL DEFAULT 0,
    flagged INTEGER NOT NULL DEFAULT 0,
    has_attachments INTEGER NOT NULL DEFAULT 0,
    participants TEXT NOT NULL DEFAULT '[]',   -- JSON [{name, addr, me}]
    snippet TEXT NOT NULL DEFAULT '',
    in_inbox INTEGER NOT NULL DEFAULT 0,       -- denormalised from labels for the hot query
    UNIQUE (account_id, key)
);
CREATE INDEX threads_inbox ON threads (account_id, in_inbox, last_date DESC, id DESC);
CREATE INDEX threads_subject ON threads (account_id, subject_norm, last_date);
-- messages.thread_id becomes INTEGER REFERENCES threads(id) (was TEXT): rebuild the table in the migration.
```

## v3 — Sprint 2 (settings) and Sprint 3 (compose)
```sql
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);             -- JSON values

CREATE TABLE identities (
    id INTEGER PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    name TEXT NOT NULL, email TEXT NOT NULL, signature TEXT, is_default INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE drafts (
    id INTEGER PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    identity_id INTEGER REFERENCES identities(id),
    thread_id INTEGER REFERENCES threads(id),
    reply_to_message_id INTEGER REFERENCES messages(id),
    kind TEXT NOT NULL,                 -- 'new' | 'reply' | 'reply_all' | 'forward'
    fields TEXT NOT NULL,               -- JSON {to, cc, bcc, subject}
    doc TEXT NOT NULL,                  -- ProseMirror JSON
    server_uid INTEGER, server_folder_id INTEGER,
    send_at INTEGER,                    -- send later
    updated INTEGER NOT NULL
);

CREATE TABLE draft_attachments (
    id INTEGER PRIMARY KEY,
    draft_id INTEGER NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
    filename TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, path TEXT NOT NULL, cid TEXT
);

CREATE TABLE contacts (
    id INTEGER PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    email TEXT NOT NULL COLLATE NOCASE,
    name TEXT NOT NULL DEFAULT '',
    sent_count INTEGER NOT NULL DEFAULT 0,
    received_count INTEGER NOT NULL DEFAULT 0,
    last_seen INTEGER NOT NULL DEFAULT 0,
    source TEXT NOT NULL DEFAULT 'mail',   -- 'mail' | 'carddav'
    UNIQUE (account_id, email)
);
CREATE INDEX contacts_rank ON contacts (account_id, sent_count DESC, received_count DESC);
```

## v4 — Sprint 4 (labels)
```sql
CREATE TABLE labels (
    id INTEGER PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    name TEXT NOT NULL,                 -- server name ("Work/Clients", "\Inbox")
    display TEXT NOT NULL,              -- "Clients"
    role TEXT NOT NULL DEFAULT 'user',  -- inbox|starred|important|sent|drafts|trash|spam|archive|snoozed|user
    color TEXT, sort INTEGER NOT NULL DEFAULT 0, hidden INTEGER NOT NULL DEFAULT 0,
    folder_id INTEGER REFERENCES folders(id),   -- for plain IMAP: 1:1 with a folder
    UNIQUE (account_id, name)
);
CREATE TABLE message_labels (
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    label_id INTEGER NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
    PRIMARY KEY (message_id, label_id)
);
CREATE INDEX message_labels_by_label ON message_labels (label_id, message_id);
-- threads.labels TEXT JSON cache maintained by store methods for chips without a join.
ALTER TABLE threads ADD COLUMN labels TEXT NOT NULL DEFAULT '[]';
```

## v5 — Sprint 5 (triage)
```sql
CREATE TABLE splits (id INTEGER PRIMARY KEY, name TEXT NOT NULL, color TEXT, sort INTEGER NOT NULL, rules TEXT NOT NULL /* JSON */, builtin TEXT /* important|other|calendar|team|NULL */);
CREATE TABLE thread_splits (thread_id INTEGER PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE, split_id INTEGER NOT NULL REFERENCES splits(id) ON DELETE CASCADE);
CREATE INDEX thread_splits_by_split ON thread_splits (split_id, thread_id);
CREATE TABLE sender_overrides (account_id INTEGER NOT NULL, addr TEXT NOT NULL COLLATE NOCASE, split_id INTEGER NOT NULL, PRIMARY KEY (account_id, addr));
CREATE TABLE reminders (id INTEGER PRIMARY KEY, thread_id INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE, kind TEXT NOT NULL /* snooze|followup */, due INTEGER NOT NULL, note TEXT, created INTEGER NOT NULL);
CREATE INDEX reminders_due ON reminders (due);
CREATE TABLE muted_threads (thread_id INTEGER PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE, since INTEGER NOT NULL);
CREATE TABLE blocked_senders (account_id INTEGER NOT NULL, addr TEXT NOT NULL COLLATE NOCASE, PRIMARY KEY (account_id, addr));
```

## v6 — Sprint 7 (attachments, snippets)
```sql
CREATE TABLE attachments (id INTEGER PRIMARY KEY, message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE, part TEXT NOT NULL, filename TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER, cid TEXT, state TEXT NOT NULL DEFAULT 'remote', path TEXT);
CREATE INDEX attachments_by_message ON attachments (message_id);
CREATE TABLE snippets (id INTEGER PRIMARY KEY, shortcut TEXT UNIQUE, name TEXT NOT NULL, doc TEXT NOT NULL, subject TEXT, to_addrs TEXT, cc_addrs TEXT, bcc_addrs TEXT, updated INTEGER NOT NULL);
```

## v7 — Sprint 9 (calendar)
`calendars`, `events`, `event_instances` as in the sprint file.

## v8 — Sprint 10 (AI)
```sql
CREATE TABLE ai_cache (kind TEXT NOT NULL, key_hash TEXT NOT NULL, model TEXT NOT NULL, text TEXT NOT NULL, created INTEGER NOT NULL, PRIMARY KEY (kind, key_hash, model));
CREATE TABLE auto_labels (id INTEGER PRIMARY KEY, label_id INTEGER NOT NULL REFERENCES labels(id) ON DELETE CASCADE, prompt TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1);
```

## v9 — Sprint 12 (Gmail API)
```sql
ALTER TABLE accounts ADD COLUMN backend TEXT NOT NULL DEFAULT 'imap';   -- 'imap' | 'gmail' | 'graph'
ALTER TABLE accounts ADD COLUMN history_id INTEGER;
ALTER TABLE messages ADD COLUMN remote_id TEXT;                          -- API id when not IMAP
```

## Hot queries (keep under 1 ms at 100k messages)

1. Inbox split page: `SELECT … FROM threads t JOIN thread_splits s ON s.thread_id = t.id WHERE t.account_id IN (…) AND t.in_inbox = 1 AND s.split_id = ? AND (t.last_date, t.id) < (?, ?) ORDER BY t.last_date DESC, t.id DESC LIMIT 100`
2. Thread open: `SELECT … FROM messages WHERE thread_id = ? ORDER BY date` + `SELECT text, html FROM bodies WHERE message_id IN (…)`
3. Search: `SELECT rowid FROM messages_fts WHERE messages_fts MATCH ? ORDER BY rank LIMIT 50` joined to threads
4. Label membership for chips: from `threads.labels` JSON (no join)
5. Unread counts per split: `SELECT split_id, SUM(unread_count) FROM threads JOIN thread_splits … GROUP BY split_id` — cached, invalidated by store methods

`EXPLAIN QUERY PLAN` output for each goes here after Sprint 6.
