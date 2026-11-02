//! What the sync worker writes: new mail, flags, bodies and what the server dropped.

use super::*;

impl Store {
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
        let me = own_addresses(&tx, account_id)?;
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
             WHERE m.account_id = ?1 AND m.body_state = 'wanted' AND m.uid IS NOT NULL",
        )?;
        let rows = stmt.query_map([account_id], |r| Ok((r.get(0)?, r.get(1)?)))?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// Opened messages whose body the server did not give (`uids`, or all of the folder's when None) stop being
    /// wanted. While one is wanted, snippets and the body prefetch wait for it in every folder; one that never
    /// comes would hold them up for good. Opening the message again asks once more.
    pub fn unwant_bodies(&self, folder_id: i64, uids: Option<&[u32]>) -> Result<usize> {
        let conn = self.conn();
        let sql = "UPDATE messages SET body_state = 'none'
                   WHERE folder_id = ?1 AND body_state = 'wanted' AND (?2 IS NULL OR uid = ?2)";
        Ok(match uids {
            None => conn.execute(sql, params![folder_id, None::<u32>])?,
            Some(uids) => {
                let mut n = 0;
                for uid in uids {
                    n += conn.execute(sql, params![folder_id, uid])?;
                }
                n
            }
        })
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
}
