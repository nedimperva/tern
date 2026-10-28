//! Drafts and sending.

use super::*;

impl Store {
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

    /// A draft in the Drafts folder that Tern did not write (another app's, or one whose record is gone), taken
    /// over so it opens in compose: its server copy becomes the draft's, replaced by the next save and deleted by
    /// a discard. None while its text has not come yet, or when it has attachments, which Tern cannot carry over.
    pub fn adopt_draft(&self, message: i64) -> Result<Option<DraftRecord>> {
        type Row =
            (i64, Option<u32>, Option<String>, String, String, String, String, bool, String, Option<u32>);
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        let row: Option<Row> = tx
            .query_row(
                "SELECT m.account_id, m.uid, m.message_id, m.to_addrs, m.cc_addrs, m.subject, m.refs,
                        m.has_attachments, f.name, f.uid_validity
                 FROM messages m JOIN folders f ON f.id = m.folder_id AND f.role = 'drafts'
                 WHERE m.id = ?1 AND m.body_state = 'full'",
                [message],
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
                    ))
                },
            )
            .optional()?;
        let Some((account_id, Some(uid), Some(bare), to, cc, subject, refs, false, folder, validity)) = row
        else {
            return Ok(None);
        };
        // A record of any kind, even one on its way out, is that draft's: never a second one.
        let known: bool = tx.query_row(
            "SELECT EXISTS (SELECT 1 FROM drafts WHERE account_id = ?1 AND message_id = ?2)",
            params![account_id, bare],
            |r| r.get(0),
        )?;
        let body: Option<(Option<String>, Option<String>)> = tx
            .query_row("SELECT text, html FROM bodies WHERE message_id = ?1", [message], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .optional()?;
        let Some((text, html)) = body.filter(|_| !known) else { return Ok(None) };
        let list = |s: &str| -> Vec<String> {
            s.split(',').map(|a| a.trim().to_string()).filter(|a| !a.is_empty()).collect()
        };
        let references: Vec<String> = refs.split_whitespace().map(str::to_string).collect();
        let draft = Draft {
            to: list(&to),
            cc: list(&cc),
            subject,
            body: text.unwrap_or_default(),
            html,
            in_reply_to: references.last().cloned(),
            references,
            message_id: Some(format!("<{bare}>")),
            ..Default::default()
        };
        tx.execute(
            "INSERT INTO drafts (account_id, message_id, payload, updated_at, synced_version, server_folder,
                                 server_validity, server_uid)
             VALUES (?1, ?2, ?3, ?4, 1, ?5, ?6, ?7)",
            params![account_id, bare, serde_json::to_string(&draft)?, now(), folder, validity, uid],
        )?;
        let id = tx.last_insert_rowid();
        tx.commit()?;
        Ok(Some(DraftRecord { id, account_id, draft, updated_at: now() }))
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
            "SELECT account_id, payload FROM outbox
             WHERE id = ?1 AND (gave_up_at IS NOT NULL OR (scheduled = 1 AND claimed = 0))",
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
        let conn = self.reader();
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
        let conn = self.reader();
        let mut conditions = Vec::new();
        let mut values: Vec<Value> = Vec::new();
        if !q.fts_not.is_empty() {
            conditions
                .push("m.id NOT IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?)".to_string());
            values.push(Value::Text(q.fts_not.clone()));
        }
        conditions.extend(q.conditions);
        values.extend(q.params);
        let noted = self.noted(&conn, &q.words, &conditions, &values, limit)?;
        let mut rows = None;
        if !q.fts.is_empty() {
            rows = self.newest_matches(&conn, &q.fts, &conditions, &values, limit)?;
            conditions.insert(0, "messages_fts MATCH ?".to_string());
            values.insert(0, Value::Text(q.fts.clone()));
        }
        let mut rows = match rows {
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
        // Messages whose marks or notes hold the words, among what the words found in the mail itself.
        if !noted.is_empty() {
            let found: HashSet<i64> = rows.iter().map(|r| r.id).collect();
            rows.extend(noted.into_iter().filter(|r| !found.contains(&r.id)));
            rows.sort_by_key(|a| std::cmp::Reverse((a.date, a.id)));
            rows.truncate(limit as usize);
        }
        // Words are only found in bodies that are here; mail older than the download window has headers alone.
        let words = !q.fts.is_empty() || !q.fts_not.is_empty();
        let partial = words
            && conn.query_row(
                "SELECT EXISTS (SELECT 1 FROM messages WHERE body_state != 'full')",
                [],
                |r| r.get(0),
            )?;
        // One message kept in several folders (Gmail's inbox and All Mail, a copy in Sent) is one result.
        let mut ids = conn.prepare_cached("SELECT message_id FROM messages WHERE id = ?1")?;
        let mut seen = HashSet::new();
        let mut kept = Vec::with_capacity(rows.len());
        for r in rows {
            let message_id: Option<String> = ids.query_row([r.id], |x| x.get(0))?;
            if message_id.is_none_or(|m| seen.insert((r.account_id, m))) {
                kept.push(r);
            }
        }
        Ok(SearchResult { rows: kept, partial })
    }

    /// Messages with a mark or note that holds every word (as typed, any case), and that pass the filters. Empty
    /// without words, or when the words are joined with OR.
    pub(super) fn noted(
        &self,
        conn: &Connection,
        words: &[String],
        conditions: &[String],
        values: &[Value],
        limit: i64,
    ) -> Result<Vec<MessageRow>> {
        if words.is_empty() {
            return Ok(Vec::new());
        }
        let found = vec!["instr(lower(k.text || ' ' || k.note), ?) > 0"; words.len()].join(" AND ");
        let mut wheres = vec![format!(
            "m.id IN (SELECT x.id FROM marks k JOIN messages x
                      ON x.account_id = k.account_id AND COALESCE(x.message_id, '#' || x.id) = k.message_key
                      WHERE {found})"
        )];
        wheres.extend(conditions.iter().cloned());
        let mut all: Vec<Value> = words.iter().map(|w| Value::Text(w.to_lowercase())).collect();
        all.extend(values.iter().cloned());
        all.push(Value::Integer(limit));
        let mut stmt = conn.prepare(&format!(
            "SELECT {ROW} FROM messages m WHERE {} ORDER BY m.date DESC, m.id DESC LIMIT ?",
            wheres.join(" AND ")
        ))?;
        let rows = stmt.query_map(rusqlite::params_from_iter(all), row)?.collect::<rusqlite::Result<_>>()?;
        Ok(rows)
    }

    /// Search words found in much of the mailbox. Joining every match and sorting them by date took 70 ms when a
    /// word was in most messages. Instead this takes the newest `window` messages that pass the filters (the date
    /// index), and the word's matches in their id range (the FTS index, without reading the rest). Mail arrives
    /// in batches, so the newest messages sit in a narrow id range. With `limit` hits the window holds the answer,
    /// since everything newer is in it; otherwise it grows. `None` when the word is rare: then sorting its few
    /// matches is quicker.
    pub(super) fn newest_matches(
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
}
