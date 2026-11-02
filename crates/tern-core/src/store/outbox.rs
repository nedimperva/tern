//! Changes and the outbox: applied here at once, queued for the server, undone on request.

use super::*;

impl Store {
    // MARK: Changes and the outbox

    /// Applies an action here at once and queues it for the server after `delay` seconds (the undo window).
    ///
    /// A draft being written in Tern is kept on the server by the draft sync, not the outbox; until its first copy
    /// is uploaded the server has nothing to act on. So deleting one discards it, and other actions leave it be.
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
        let mut drafts = Vec::new();
        for id in ids {
            let hit = tx
                .query_row(
                    "SELECT m.id, m.account_id, m.folder_id, f.name, m.uid, m.seen, m.flagged, f.uid_validity,
                            CASE WHEN f.role = 'drafts' THEN
                                (SELECT d.id FROM drafts d WHERE d.account_id = m.account_id
                                 AND d.message_id = m.message_id AND d.discarded_at IS NULL AND d.sent_at IS NULL)
                            END
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
                            r.get::<_, Option<i64>>(8)?,
                        ))
                    },
                )
                .optional()?;
            match hit {
                Some((_, _, Some(draft))) => {
                    if matches!(action, Action::Trash) {
                        drafts.push(draft);
                    }
                }
                Some((account_id, hit, None)) => {
                    groups.entry((account_id, hit.folder_id)).or_default().push(hit)
                }
                None => {}
            }
        }
        for draft in &drafts {
            tx.execute("UPDATE drafts SET discarded_at = ?2 WHERE id = ?1", params![draft, now()])?;
            unmirror_draft(&tx, *draft)?;
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
        Ok(Applied { token, accounts: accounts.into_iter().collect(), drafts })
    }

    pub fn queue_send(&self, account_id: i64, draft: Draft, delay: i64) -> Result<i64> {
        self.queue_send_at(account_id, draft, delay, None, None)
    }

    /// `queue_send`, sent at `at` instead (send later; Unix seconds), and with a follow-up reminder due at
    /// `follow_up` unless someone else writes in the conversation first.
    pub fn queue_send_at(
        &self,
        account_id: i64,
        mut draft: Draft,
        delay: i64,
        at: Option<i64>,
        follow_up: Option<i64>,
    ) -> Result<i64> {
        let conn = self.conn();
        // Who the person writes to ranks first in autocomplete, before the copy in Sent is even synced.
        let me = own_addresses(&conn, account_id)?;
        // An address the account no longer has (an alias taken off while this was being written) goes out as the
        // account's own, as smtp::build does.
        let sender = draft.from.as_deref().map(str::to_lowercase).filter(|f| me.contains(f));
        let sender = sender.unwrap_or_else(|| me[0].clone());
        let sent = NewMessage {
            from_addr: sender.clone(),
            to_addrs: draft.to.join(", "),
            cc_addrs: [draft.cc.clone(), draft.bcc.clone()].concat().join(", "),
            date: now(),
            ..Default::default()
        };
        note_people(&conn, &me, &sent)?;
        if draft.message_id.is_none() {
            let domain = sender.rsplit_once('@').map_or("localhost", |(_, d)| d);
            draft.message_id = Some(crate::smtp::new_message_id(domain)?);
        }
        let bare = bare_id(draft.message_id.as_deref().unwrap_or_default());
        let id = enqueue(&conn, account_id, &OutboxOp::Send(draft), delay)?;
        if let Some(at) = at {
            conn.execute("UPDATE outbox SET not_before = ?2, scheduled = 1 WHERE id = ?1", params![id, at])?;
        }
        if let Some(due) = follow_up {
            // Keyed by the Message-ID until the copy in Sent says which conversation it is in.
            conn.execute(
                "INSERT OR REPLACE INTO reminders (account_id, thread_id, kind, due, created, message_id)
                 VALUES (?1, ?2, 'followup', ?3, ?4, ?2)",
                params![account_id, bare, due, at.unwrap_or(now() + delay)],
            )?;
        }
        Ok(id)
    }

    /// Holds scheduled sends whose time passed more than a minute ago, at start: they were due while Tern was
    /// closed, and the person decides whether they still go. Returns how many.
    pub fn hold_overdue(&self, now: i64) -> Result<usize> {
        Ok(self.conn().execute(
            "UPDATE outbox SET held = 1
             WHERE scheduled = 1 AND claimed = 0 AND gave_up_at IS NULL AND attempts = 0 AND not_before < ?1 - 60",
            [now],
        )?)
    }

    /// A scheduled (or held) send goes now. Returns its account, to wake, or None if it is not waiting any more.
    pub fn send_now(&self, outbox_id: i64) -> Result<Option<i64>> {
        Ok(self
            .conn()
            .query_row(
                "UPDATE outbox SET not_before = ?2, held = 0
                 WHERE id = ?1 AND scheduled = 1 AND claimed = 0 AND gave_up_at IS NULL RETURNING account_id",
                params![outbox_id, now()],
                |r| r.get(0),
            )
            .optional()?)
    }

    /// Follow-ups: cancels those answered by someone else, and marks the ones that came due with no answer, which
    /// it returns (their conversation's newest message) for a notification. Waits for the copy in Sent: until it
    /// is here, Tern can't tell which conversation to watch.
    pub fn check_follow_ups(&self, now: i64) -> Result<Vec<NewMail>> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        tx.execute(
            &format!(
                "DELETE FROM reminders AS r WHERE r.kind = 'followup' AND EXISTS (
                     SELECT 1 FROM messages m JOIN accounts a ON a.id = m.account_id
                     WHERE m.account_id = r.account_id AND m.thread_id = {FOLLOW_UP_THREAD}
                       AND m.date > r.created AND NOT {MINE_M})"
            ),
            [],
        )?;
        let due: Vec<(i64, String, String)> = tx
            .prepare(&format!(
                "SELECT r.account_id, r.thread_id, {FOLLOW_UP_THREAD} FROM reminders r
                 WHERE r.kind = 'followup' AND NOT r.fired AND r.due <= ?1 AND {FOLLOW_UP_THREAD} IS NOT NULL"
            ))?
            .query_map([now], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
            .collect::<rusqlite::Result<_>>()?;
        let mut out = Vec::new();
        for (account_id, key, thread_id) in due {
            tx.execute(
                "UPDATE reminders SET fired = 1 WHERE account_id = ?1 AND thread_id = ?2 AND kind = 'followup'",
                params![account_id, key],
            )?;
            let latest = tx
                .query_row(
                    "SELECT id, from_name, from_addr, subject, snippet FROM messages
                     WHERE account_id = ?1 AND thread_id = ?2 ORDER BY date DESC, id DESC LIMIT 1",
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

    /// Done on a follow-up that came due: the reminder goes (the conversation itself is in Sent, not the inbox).
    /// Returns how many there were.
    pub fn dismiss_follow_ups(&self, ids: &[i64]) -> Result<usize> {
        let conn = self.conn();
        let mut stmt = conn.prepare_cached(&format!(
            "DELETE FROM reminders AS r WHERE r.kind = 'followup' AND r.fired
               AND (r.account_id, {FOLLOW_UP_THREAD}) = (SELECT account_id, thread_id FROM messages WHERE id = ?1)"
        ))?;
        let mut gone = 0;
        for id in ids {
            gone += stmt.execute([id])?;
        }
        Ok(gone)
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
            "SELECT id, account_id, payload, not_before, attempts, COALESCE(last_error, ''), claimed, scheduled, held
             FROM outbox WHERE gave_up_at IS NULL ORDER BY id",
        )?;
        type Row = (i64, i64, String, i64, i64, String, i64, bool, bool);
        let rows = stmt
            .query_map([], |r| {
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
                ))
            })?
            .collect::<rusqlite::Result<Vec<Row>>>()?;
        rows.into_iter()
            .map(|(id, account_id, payload, not_before, attempts, last_error, claimed, scheduled, held)| {
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
                    scheduled,
                    held,
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
             WHERE account_id = ?1 AND claimed = 0 AND not_before <= ?2 AND gave_up_at IS NULL AND held = 0
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
            "SELECT MIN(not_before) FROM outbox
             WHERE account_id = ?1 AND claimed = 0 AND gave_up_at IS NULL AND held = 0",
            [account_id],
            |r| r.get(0),
        )?)
    }

    /// Uids in `folder` that queued work or the draft sync is about to change. Sync leaves these alone, so it does
    /// not undo on screen what the person just did.
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
        // A sent or discarded draft's server copy until the draft sync deletes it: its row already left the
        // Drafts folder, and fetching the copy again would bring it back as mail.
        let mut leaving = conn.prepare_cached(
            "SELECT server_uid FROM drafts WHERE account_id = ?1 AND server_folder = ?2 AND server_uid IS NOT NULL
             AND (discarded_at IS NOT NULL OR sent_at IS NOT NULL)",
        )?;
        for uid in leaving.query_map(params![account_id, folder], |r| r.get::<_, u32>(0))? {
            uids.insert(uid?);
        }
        Ok(uids)
    }
}
