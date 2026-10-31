//! What the window reads: lists, conversations, search and the start of the day.

use super::*;

impl Store {
    // MARK: Reading

    /// One page of a list, newest first, starting after `before`.
    pub fn list(&self, target: &ListTarget, before: Option<Cursor>, limit: i64) -> Result<Vec<MessageRow>> {
        let (filter, key) = target_filter(target, 1);
        let before = before.unwrap_or(Cursor { date: i64::MAX, id: i64::MAX });
        let sql = format!(
            "SELECT {ROW} FROM messages m WHERE {filter} AND (m.date, m.id) < (?2, ?3)
             ORDER BY m.date DESC, m.id DESC LIMIT ?4"
        );
        let conn = self.reader();
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
        let conn = self.reader();
        let mut scan = conn.prepare_cached(&format!(
            "SELECT {ROW} FROM messages m WHERE {filter} AND (m.date, m.id) < (?2, ?3)
             ORDER BY m.date DESC, m.id DESC LIMIT ?4"
        ))?;
        // A conversation already shown on an earlier page has a newer message here than the cursor.
        let mut shown = conn.prepare_cached(&format!(
            "SELECT EXISTS (SELECT 1 FROM messages m WHERE {filter} AND m.account_id = ?2 AND m.thread_id = ?3
                            AND (m.date, m.id) >= (?4, ?5))"
        ))?;
        let mut seen = HashSet::new();
        let mut latests: Vec<MessageRow> = Vec::new();
        // The scan goes in pages with a LIMIT: across several folders (a role) SQLite sorts what it finds, and
        // without a limit it would sort the whole inbox before the first row.
        let chunk = (limit * 4).max(100);
        let mut at = cursor;
        let mut page: Vec<MessageRow> = Vec::new();
        let mut exhausted = false;
        while latests.len() < limit {
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
            latests.push(latest);
        }
        let mut rows = conversations(&conn, latests)?;
        // On the Marks list a conversation reads as what was marked in it and the notes, newest first.
        if matches!(target, ListTarget::Role(r) if r == MARKED) {
            let mut stmt = conn.prepare_cached(
                "SELECT k.text, k.note FROM marks k
                 WHERE k.account_id = ?1 AND k.message_key IN (
                     SELECT COALESCE(x.message_id, '#' || x.id) FROM messages x WHERE x.account_id = ?1 AND x.thread_id = ?2)
                 ORDER BY k.created DESC, k.id DESC",
            )?;
            for t in &mut rows {
                let marks: Vec<String> = stmt
                    .query_map(params![t.latest.account_id, t.latest.thread_id], |r| {
                        let (text, note): (String, String) = (r.get(0)?, r.get(1)?);
                        Ok(if note.is_empty() {
                            format!("\u{201c}{text}\u{201d}")
                        } else {
                            format!("\u{201c}{text}\u{201d} {note}")
                        })
                    })?
                    .collect::<rusqlite::Result<_>>()?;
                t.latest.snippet = marks.join("  \u{b7}  ");
            }
        }
        // Follow-ups that came due sit at the top of the inbox (and Important) until done or answered.
        let inbox = matches!(target, ListTarget::Role(r) if r == "inbox" || r == IMPORTANT);
        if inbox && before.is_none() {
            let mut stmt = conn.prepare_cached(&format!(
                "SELECT {ROW} FROM reminders r JOIN messages m ON m.id = (
                     SELECT id FROM messages WHERE account_id = r.account_id AND thread_id = {FOLLOW_UP_THREAD}
                     ORDER BY date DESC, id DESC LIMIT 1)
                 WHERE r.kind = 'followup' AND r.fired ORDER BY r.due"
            ))?;
            let due: Vec<MessageRow> = stmt.query_map([], row)?.collect::<rusqlite::Result<_>>()?;
            if !due.is_empty() {
                let keys: HashSet<(i64, String)> =
                    due.iter().map(|m| (m.account_id, m.thread_id.clone())).collect();
                rows.retain(|t| !keys.contains(&(t.latest.account_id, t.latest.thread_id.clone())));
                let mut pinned = conversations(&conn, due)?;
                for t in &mut pinned {
                    t.follow_up = true;
                }
                pinned.append(&mut rows);
                rows = pinned;
            }
        }
        Ok(rows)
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
            "SELECT m.id, m.account_id, m.thread_id, m.from_name, m.from_addr, m.subject, m.snippet, {IS_OTHER}
             FROM messages m JOIN folders f ON f.id = m.folder_id JOIN accounts a ON a.id = m.account_id
             WHERE m.id > ?1 AND m.id <= ?3 AND m.date >= ?2 AND f.role = 'inbox' AND NOT m.seen
               AND NOT {MINE_M}
               AND NOT EXISTS (SELECT 1 FROM muted u WHERE u.account_id = m.account_id AND u.thread_id = m.thread_id)
               AND (?4 OR NOT {IS_OTHER}) AND NOT {IS_SNOOZED} AND NOT {IS_LATER}
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
                    other: r.get(7)?,
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

    /// Puts the conversations of these messages on the Read later shelf, or takes them off it.
    pub fn read_later(&self, ids: &[i64], on: bool, now: i64) -> Result<()> {
        let conn = self.conn();
        let mut stmt = conn.prepare_cached(if on {
            // Counted from the newest message there too: one dated ahead of this computer's clock (a sender's wrong
            // clock or time zone) is not someone writing after it was shelved.
            "INSERT INTO read_later (account_id, thread_id, added)
             SELECT m.account_id, m.thread_id,
                    MAX(?2, (SELECT MAX(x.date) FROM messages x
                             WHERE x.account_id = m.account_id AND x.thread_id = m.thread_id))
             FROM messages m WHERE m.id = ?1
             ON CONFLICT (account_id, thread_id) DO UPDATE SET added = excluded.added"
        } else {
            "DELETE FROM read_later
             WHERE (account_id, thread_id) = (SELECT account_id, thread_id FROM messages WHERE id = ?1) AND ?2 = ?2"
        })?;
        for id in ids {
            stmt.execute(params![id, now])?;
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
        tx.execute("DELETE FROM reminders WHERE kind = 'woke' AND due < ?1", [now - 2 * 86_400])?;
        let due: Vec<(i64, String)> = tx
            .prepare(&format!(
                "SELECT r.account_id, r.thread_id FROM reminders r JOIN accounts a ON a.id = r.account_id
                 WHERE r.kind = 'snooze' AND (r.due <= ?1 OR EXISTS (
                     SELECT 1 FROM messages m WHERE m.account_id = r.account_id AND m.thread_id = r.thread_id
                       AND m.date > r.created AND NOT {MINE_M}))"
            ))?
            .query_map([now], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<rusqlite::Result<_>>()?;
        let mut out = Vec::new();
        for (account_id, thread_id) in due {
            tx.execute(
                "DELETE FROM reminders WHERE account_id = ?1 AND thread_id = ?2 AND kind = 'snooze'",
                params![account_id, thread_id],
            )?;
            // That it came back, and when: the start of the day lists what came back since the person was last
            // here. Kept two days.
            tx.execute(
                "INSERT OR REPLACE INTO reminders (account_id, thread_id, kind, due, created)
                 VALUES (?1, ?2, 'woke', ?3, ?3)",
                params![account_id, thread_id, now],
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
                            other: false,
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
        Ok(self.reader().query_row(
            &format!(
                "SELECT count(*) FILTER (WHERE NOT {IS_OTHER}), count(*) FILTER (WHERE {IS_OTHER})
                 FROM messages m JOIN folders f ON f.id = m.folder_id
                 WHERE f.role = 'inbox' AND NOT m.seen AND NOT {IS_SNOOZED} AND NOT {IS_LATER}"
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

    /// The unread messages in a list, for "Mark all read": every page of it, not only what the window has loaded.
    pub fn unread_ids(&self, target: &ListTarget) -> Result<Vec<i64>> {
        let (filter, value) = target_filter(target, 1);
        let conn = self.conn();
        let mut stmt = conn.prepare(&format!("SELECT m.id FROM messages m WHERE {filter} AND NOT m.seen"))?;
        let ids = stmt.query_map([value], |r| r.get(0))?.collect::<rusqlite::Result<Vec<i64>>>()?;
        Ok(ids)
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
}
