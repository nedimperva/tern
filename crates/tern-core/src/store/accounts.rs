//! Accounts and their folders.

use super::*;

impl Store {
    // MARK: Accounts and folders

    pub fn add_account(&self, c: &AccountConfig) -> Result<Account> {
        let conn = self.conn();
        conn.execute(
            "INSERT INTO accounts (email, display_name, username, imap_host, imap_port, imap_security,
                                   smtp_host, smtp_port, smtp_security, auth)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                c.email,
                c.display_name,
                c.username,
                c.imap_host,
                c.imap_port,
                c.imap_security.as_str(),
                c.smtp_host,
                c.smtp_port,
                c.smtp_security.as_str(),
                c.auth.as_str()
            ],
        )?;
        Ok(Account { id: conn.last_insert_rowid(), config: c.clone() })
    }

    /// The name put on mail sent from the account (the From line's "Ada Lovelace <ada@…>"). Empty sends the
    /// address alone.
    pub fn set_display_name(&self, id: i64, name: &str) -> Result<()> {
        self.conn()
            .execute("UPDATE accounts SET display_name = ?2 WHERE id = ?1", params![id, name.trim()])?;
        Ok(())
    }

    /// Switches how the account signs in (an app-password Gmail account moving to Google sign-in).
    pub fn set_auth(&self, id: i64, auth: Auth) -> Result<()> {
        self.conn().execute("UPDATE accounts SET auth = ?2 WHERE id = ?1", params![id, auth.as_str()])?;
        Ok(())
    }

    pub fn account(&self, id: i64) -> Result<Option<Account>> {
        Ok(self.accounts()?.into_iter().find(|a| a.id == id))
    }

    pub fn remove_account(&self, id: i64) -> Result<()> {
        self.conn().execute("DELETE FROM accounts WHERE id = ?1", [id])?;
        Ok(())
    }

    pub fn accounts(&self) -> Result<Vec<Account>> {
        let conn = self.conn();
        let mut stmt = conn.prepare_cached(
            "SELECT id, email, display_name, username, imap_host, imap_port, imap_security,
                    smtp_host, smtp_port, smtp_security, auth
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
                        auth: if r.get::<_, String>(10)? == "google" { Auth::Google } else { Auth::Password },
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
                    OutboxOp::Label { folder, label, .. } => named.extend([folder, label]),
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
        let conn = self.reader();
        let mut stmt = conn.prepare_cached(
            "SELECT f.id, f.account_id, f.name, f.role,
                    CASE f.role WHEN 'label' THEN
                        (SELECT COUNT(*) FROM message_labels l
                         JOIN messages m ON m.account_id = f.account_id AND m.message_id = l.message_id
                         JOIN folders a ON a.id = m.folder_id AND a.role = 'all'
                         WHERE l.folder_id = f.id AND m.seen = 0)
                    ELSE (SELECT COUNT(*) FROM messages m WHERE m.folder_id = f.id AND m.seen = 0) END
             FROM folders f WHERE f.role != 'hidden'
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

    /// The folders sync keeps, inbox first. An All Mail folder repeats every other folder and is left out, except on
    /// Gmail, where it is the archive and its labels are only read for membership (`label_folders`). Gmail's
    /// Important and Starred (`hidden`) are not synced at all.
    pub fn folders_to_sync(&self, account_id: i64) -> Result<Vec<(i64, String)>> {
        let conn = self.conn();
        let mut stmt = conn.prepare_cached(
            "SELECT id, name FROM folders WHERE account_id = ?1 AND role NOT IN ('label', 'hidden')
               AND (role != 'all' OR (SELECT imap_host FROM accounts WHERE id = ?1) = 'imap.gmail.com')
             ORDER BY role = 'inbox' DESC, role = 'all' DESC, name",
        )?;
        let folders = stmt
            .query_map([account_id], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(folders)
    }

    /// Gmail: whether the account is one (Workspace accounts share the host).
    pub fn is_gmail(&self, account_id: i64) -> Result<bool> {
        Ok(self.conn().query_row(
            "SELECT imap_host = 'imap.gmail.com' FROM accounts WHERE id = ?1",
            [account_id],
            |r| r.get(0),
        )?)
    }

    /// Adds a Gmail label to the conversations of these messages, or takes it off: here at once, on the server
    /// after `delay` (undo takes it back). Gmail labels conversations, so every message of each one that All Mail
    /// holds changes. Returns the undo token; empty when nothing changes.
    pub fn label(&self, ids: &[i64], label_folder: i64, add: bool, delay: i64) -> Result<Applied> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        let (account_id, label): (i64, String) = tx.query_row(
            "SELECT account_id, name FROM folders WHERE id = ?1 AND role = 'label'",
            [label_folder],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        let (all, validity): (String, Option<u32>) = tx.query_row(
            "SELECT name, uid_validity FROM folders WHERE account_id = ?1 AND role = 'all'",
            [account_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        let mut stmt = tx.prepare_cached(
            "SELECT DISTINCT m.id, m.uid, m.message_id FROM messages m JOIN folders f ON f.id = m.folder_id
             WHERE f.account_id = ?1 AND f.role = 'all' AND m.uid IS NOT NULL AND m.message_id IS NOT NULL
               AND (m.account_id, m.thread_id) IN (SELECT account_id, thread_id FROM messages WHERE id = ?2)
               AND EXISTS (SELECT 1 FROM message_labels l WHERE l.folder_id = ?3 AND l.message_id = m.message_id) = ?4",
        )?;
        let mut rows: Vec<(i64, u32, String)> = Vec::new();
        for id in ids {
            for row in stmt.query_map(params![account_id, id, label_folder, !add], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?))
            })? {
                let row = row?;
                if !rows.iter().any(|(_, _, m)| *m == row.2) {
                    rows.push(row);
                }
            }
        }
        drop(stmt);
        if rows.is_empty() {
            return Ok(Applied { token: Vec::new(), accounts: Vec::new(), drafts: Vec::new() });
        }
        let op = OutboxOp::Label {
            folder: all,
            uids: rows.iter().map(|r| r.1).collect(),
            label,
            label_folder,
            add,
            message_ids: rows.iter().map(|r| r.2.clone()).collect(),
            ids: rows.iter().map(|r| r.0).collect(),
            validity,
        };
        // What the list shows changes now; `revert` puts it back.
        let sql = if add {
            "INSERT OR IGNORE INTO message_labels (folder_id, message_id) VALUES (?1, ?2)"
        } else {
            "DELETE FROM message_labels WHERE folder_id = ?1 AND message_id = ?2"
        };
        for (_, _, message_id) in &rows {
            tx.execute(sql, params![label_folder, message_id])?;
        }
        let token = enqueue(&tx, account_id, &op, delay)?;
        tx.commit()?;
        Ok(Applied { token: vec![token], accounts: vec![account_id], drafts: Vec::new() })
    }

    /// Whether queued work changes this label: until it is sent, reading the label folder would undo it on screen.
    pub fn label_pending(&self, account_id: i64, label_folder: i64) -> Result<bool> {
        let conn = self.conn();
        let mut stmt =
            conn.prepare_cached("SELECT payload FROM outbox WHERE account_id = ?1 AND gave_up_at IS NULL")?;
        let payloads =
            stmt.query_map([account_id], |r| r.get::<_, String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
        for payload in payloads {
            if let OutboxOp::Label { label_folder: f, .. } = serde_json::from_str(&payload)? {
                if f == label_folder {
                    return Ok(true);
                }
            }
        }
        Ok(false)
    }

    /// Gmail's label folders, read for their members only.
    pub fn label_folders(&self, account_id: i64) -> Result<Vec<(i64, String)>> {
        let conn = self.conn();
        let mut stmt = conn.prepare_cached(
            "SELECT id, name FROM folders WHERE account_id = ?1 AND role = 'label' ORDER BY name",
        )?;
        let folders =
            stmt.query_map([account_id], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<rusqlite::Result<_>>()?;
        Ok(folders)
    }

    /// What a label folder holds now, by bare Message-ID; replaces what it held.
    pub fn set_label_members(&self, folder_id: i64, message_ids: &[String]) -> Result<()> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        tx.execute("DELETE FROM message_labels WHERE folder_id = ?1", [folder_id])?;
        {
            let mut add = tx.prepare_cached(
                "INSERT OR IGNORE INTO message_labels (folder_id, message_id) VALUES (?1, ?2)",
            )?;
            for id in message_ids {
                add.execute(params![folder_id, id])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    /// Drops the message rows of folders that keep none (Gmail labels and hidden folders), from before they were
    /// recognised as such, and resets them so their membership is read afresh. Waits while the account has queued
    /// work, which may name those rows. Returns how many rows went.
    pub fn retire_label_rows(&self, account_id: i64) -> Result<usize> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        let busy: bool = tx.query_row(
            "SELECT EXISTS (SELECT 1 FROM outbox WHERE account_id = ?1 AND gave_up_at IS NULL)",
            [account_id],
            |r| r.get(0),
        )?;
        if busy {
            return Ok(0);
        }
        let folders = "SELECT id FROM folders WHERE account_id = ?1 AND role IN ('label', 'hidden')";
        let gone = tx.execute(
            &format!("DELETE FROM messages WHERE folder_id IN ({folders}) AND uid IS NOT NULL"),
            [account_id],
        )?;
        if gone > 0 {
            tx.execute(
                &format!(
                    "UPDATE folders SET uid_validity = NULL, uid_next = NULL, highest_modseq = NULL, server_count = NULL
                     WHERE id IN ({folders})"
                ),
                [account_id],
            )?;
        }
        tx.commit()?;
        Ok(gone)
    }

    /// After All Mail syncs: a message archived here moved its row into All Mail without a uid, while All Mail
    /// already had the message. Once nothing is queued, that moved copy is a duplicate and goes. Returns how many.
    pub fn drop_moved_duplicates(&self, folder_id: i64) -> Result<usize> {
        Ok(self.conn().execute(
            "DELETE FROM messages AS d WHERE d.folder_id = ?1 AND d.uid IS NULL AND d.message_id IS NOT NULL
               AND (SELECT role FROM folders WHERE id = ?1) = 'all'
               AND EXISTS (SELECT 1 FROM messages o WHERE o.folder_id = ?1 AND o.uid IS NOT NULL
                           AND o.message_id = d.message_id)
               AND NOT EXISTS (SELECT 1 FROM outbox WHERE account_id = d.account_id AND gave_up_at IS NULL)",
            [folder_id],
        )?)
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

    /// What the server said the folder holds, at its latest SELECT.
    pub fn set_server_count(&self, folder_id: i64, count: u32) -> Result<()> {
        self.conn()
            .execute("UPDATE folders SET server_count = ?2 WHERE id = ?1", params![folder_id, count])?;
        Ok(())
    }

    /// How far each account's download has come: messages here against the server's counts (only folders checked
    /// at least once), and how many of the messages here have their text, which is what search reads. The folders
    /// counted are the ones sync stores rows for (`folders_to_sync`): on Gmail All Mail, never labels or hidden ones.
    pub fn sync_progress(&self) -> Result<Vec<SyncProgress>> {
        let conn = self.conn();
        // Both counts per folder read an index: `messages_list` for all rows, the partial `messages_bodyless` for
        // rows without their text.
        let mut stmt = conn.prepare_cached(
            "SELECT f.account_id, f.server_count,
                    (SELECT count(*) FROM messages m WHERE m.folder_id = f.id),
                    (SELECT count(*) FROM messages m WHERE m.folder_id = f.id AND m.body_state != 'full')
             FROM folders f JOIN accounts a ON a.id = f.account_id
             WHERE f.role NOT IN ('label', 'hidden') AND (f.role != 'all' OR a.imap_host = 'imap.gmail.com')
             ORDER BY f.account_id",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, Option<i64>>(1)?, r.get::<_, i64>(2)?, r.get::<_, i64>(3)?))
        })?;
        let mut out: Vec<SyncProgress> = Vec::new();
        for row in rows {
            let (account_id, server, local, bodyless) = row?;
            if out.last().is_none_or(|p| p.account_id != account_id) {
                out.push(SyncProgress { account_id, ..Default::default() });
            }
            let p = out.last_mut().expect("pushed above");
            match server {
                // A row moved here and not yet seen on the server can make `local` run ahead for a moment.
                Some(server) => {
                    p.total += server;
                    p.have += local.min(server);
                }
                None => p.unchecked += 1,
            }
            p.messages += local;
            p.with_text += local - bodyless;
        }
        Ok(out)
    }

    /// body_state of one message, for tests.
    #[cfg(test)]
    pub(crate) fn body_state_of(&self, folder_id: i64, uid: u32) -> Option<String> {
        self.conn()
            .query_row(
                "SELECT body_state FROM messages WHERE folder_id = ?1 AND uid = ?2",
                params![folder_id, uid],
                |r| r.get(0),
            )
            .ok()
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
                OutboxOp::Label { ids, .. } => keep.extend(ids.iter().copied()),
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
}
