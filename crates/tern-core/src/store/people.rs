//! What the companion knows about the person a conversation is with, beyond their card: how much they write, who
//! you know at their domain, your note on them, and the files you exchanged. All from this computer.

use super::*;

/// About a month, for counting mail by month without a calendar.
const MONTH: i64 = 2_629_800;

impl Store {
    /// The companion's facts about `email`, as mail to `account_id` sees them.
    pub fn person(&self, account_id: i64, email: &str) -> Result<PersonFacts> {
        let email = email.trim().to_lowercase();
        let conn = self.reader();
        let now = now();
        let mut months = vec![0; 12];
        let mut stmt = conn.prepare_cached(
            "SELECT (?2 - date) / ?3, count(*) FROM messages INDEXED BY messages_from
             WHERE from_addr = ?1 COLLATE NOCASE AND date > ?2 - 12 * ?3 GROUP BY 1",
        )?;
        for found in
            stmt.query_map(params![email, now, MONTH], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)))?
        {
            let (ago, n) = found?;
            if (0..12).contains(&ago) {
                months[11 - ago as usize] = n;
            }
        }
        let (since, conversations): (Option<i64>, i64) = conn.query_row(
            "SELECT min(date), count(DISTINCT account_id || ':' || thread_id) FROM messages INDEXED BY messages_from
             WHERE from_addr = ?1 COLLATE NOCASE",
            [&email],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        // Someone else at their domain you have written to: a stranger from a colleague's company is less strange.
        // Webmail domains say nothing about anyone, so they are left out.
        let domain = email.rsplit_once('@').map(|(_, d)| d.to_string()).unwrap_or_default();
        let known_at_domain = if domain.is_empty() || WEBMAIL.contains(&domain.as_str()) {
            None
        } else {
            conn.query_row(
                "SELECT CASE WHEN name <> '' THEN name ELSE email END FROM contacts
                 WHERE email LIKE '%@' || ?1 AND email <> ?2 AND sent_count > 0
                 ORDER BY sent_count DESC LIMIT 1",
                params![domain, email],
                |r| r.get(0),
            )
            .optional()?
        };
        // A list's latest issues and how many of them were opened.
        let latest: Vec<(bool, bool)> = conn
            .prepare_cached(
                "SELECT seen, list_id IS NOT NULL OR list_unsubscribe IS NOT NULL FROM messages INDEXED BY messages_from
                 WHERE from_addr = ?1 COLLATE NOCASE ORDER BY date DESC LIMIT 10",
            )?
            .query_map([&email], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<rusqlite::Result<_>>()?;
        let list = latest.first().is_some_and(|&(_, list)| list);
        let opened = latest.iter().filter(|&&(seen, _)| seen).count() as i64;
        // Their unread conversations still in an inbox: one message of each, to archive them in one go.
        let unopened = conn
            .prepare_cached(
                "SELECT min(m.id) FROM messages m INDEXED BY messages_from JOIN folders f ON f.id = m.folder_id
                 WHERE m.from_addr = ?1 COLLATE NOCASE AND m.account_id = ?2 AND m.seen = 0 AND f.role = 'inbox'
                 GROUP BY m.thread_id",
            )?
            .query_map(params![email, account_id], |r| r.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        let note = conn
            .query_row("SELECT body FROM person_notes WHERE email = ?1", [&email], |r| r.get(0))
            .optional()?
            .unwrap_or_default();
        Ok(PersonFacts {
            email,
            months,
            since: since.unwrap_or(0),
            conversations,
            known_at_domain,
            list,
            latest: latest.len() as i64,
            opened,
            unopened,
            note,
        })
    }

    /// Keeps the person's note on `email`; an empty note is none.
    pub fn set_person_note(&self, email: &str, body: &str) -> Result<()> {
        let email = email.trim().to_lowercase();
        let conn = self.conn();
        if body.trim().is_empty() {
            conn.execute("DELETE FROM person_notes WHERE email = ?1", [&email])?;
        } else {
            conn.execute(
                "INSERT INTO person_notes (email, body, updated) VALUES (?1, ?2, ?3)
                 ON CONFLICT (email) DO UPDATE SET body = excluded.body, updated = excluded.updated",
                params![email, body, now()],
            )?;
        }
        Ok(())
    }

    /// The files exchanged with `email`, newest first: those they sent (by the sender index), and those the
    /// account sent them (walking the date index, as far as the newest 50 such messages).
    pub fn person_files(&self, email: &str, limit: usize) -> Result<Vec<PersonFile>> {
        let email = email.trim().to_lowercase();
        let clean = email.replace(['%', '_'], "");
        if clean.is_empty() {
            return Ok(Vec::new());
        }
        let like = format!("%{clean}%");
        let conn = self.reader();
        type Found = (MessageRow, bool, Option<String>, Option<String>);
        let pick =
            |r: &Row, mine: bool| -> rusqlite::Result<Found> { Ok((row(r)?, mine, r.get(12)?, r.get(13)?)) };
        let mut found: Vec<Found> = conn
            .prepare_cached(&format!(
                "SELECT {ROW}, m.parts, m.message_id FROM messages m INDEXED BY messages_from
                 WHERE m.from_addr = ?1 COLLATE NOCASE AND m.has_attachments = 1
                 ORDER BY m.date DESC LIMIT 100"
            ))?
            .query_map([&email], |r| pick(r, false))?
            .collect::<rusqlite::Result<_>>()?;
        let sent = conn
            .prepare_cached(&format!(
                "SELECT {ROW}, m.parts, m.message_id FROM messages m INDEXED BY messages_date JOIN accounts a ON a.id = m.account_id
                 WHERE m.has_attachments = 1 AND m.to_addrs LIKE ?1 AND {MINE_M}
                 ORDER BY m.date DESC, m.id DESC LIMIT 50"
            ))?
            .query_map([&like], |r| pick(r, true))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        found.extend(sent);
        found.sort_by(|a, b| {
            b.0.date.cmp(&a.0.date).then(b.2.is_some().cmp(&a.2.is_some())).then(b.0.id.cmp(&a.0.id))
        });
        // The same message can be in two folders (a copy in Sent and in a label): its files once.
        let mut seen = HashSet::new();
        let mut files = Vec::new();
        for (m, mine, parts, mid) in found {
            let attachments = attachments_of(parts.as_deref());
            if attachments.is_empty() {
                continue;
            }
            let key = mid.unwrap_or_else(|| format!("{}\0{}", m.subject, m.date));
            if !seen.insert((m.account_id, key)) {
                continue;
            }
            for (index, a) in attachments.into_iter().enumerate() {
                files.push(PersonFile {
                    message_id: m.id,
                    account_id: m.account_id,
                    thread_id: m.thread_id.clone(),
                    subject: m.subject.clone(),
                    date: m.date,
                    mine,
                    index,
                    name: a.name,
                    mime: a.mime,
                    size: a.size,
                    from: if m.from_name.is_empty() { m.from_addr.clone() } else { m.from_name.clone() },
                });
                if files.len() == limit {
                    return Ok(files);
                }
            }
        }
        Ok(files)
    }

    /// Mail that looks like a receipt, an invoice, an order or a booking since `since` (Paper trail, idea 115): the
    /// rows and up to 6,000 characters of their text, newest first. The amounts and numbers in it are read by the
    /// window (`src/paper.ts`); this only narrows by subject.
    pub fn paper_candidates(&self, since: i64) -> Result<Vec<(MessageRow, String)>> {
        let conn = self.reader();
        let words = [
            "receipt",
            "invoice",
            "order",
            "booking",
            "reservation",
            "ticket",
            "payment",
            "paid",
            "purchase",
            "subscription",
            "renewal",
            "račun",
            "faktur",
            "narudžb",
            "uplat",
            "plaćanj",
            "potvrd",
            "rezervacij",
            "rechnung",
            "bestellung",
            "quittung",
        ];
        // SQLite's lower() only folds ASCII, so non-ASCII letters use `_` in SQL and are checked in Rust.
        let like: Vec<String> = words
            .iter()
            .map(|w| {
                let pattern: String = w.chars().map(|c| if c.is_ascii() { c } else { '_' }).collect();
                format!("lower(m.subject) LIKE '%{pattern}%'")
            })
            .collect();
        let sql = format!(
            "SELECT {ROW}, b.text, b.html, m.message_id FROM messages m INDEXED BY messages_date
               JOIN folders f ON f.id = m.folder_id
               LEFT JOIN bodies b ON b.message_id = m.id
             WHERE m.date >= ?1
               AND f.role NOT IN ('trash', 'junk', 'drafts', 'sent')
               AND (m.in_reply_to IS NULL OR m.in_reply_to = '')
               AND ({})
             ORDER BY m.date DESC, (b.message_id IS NOT NULL) DESC, m.id DESC LIMIT 1500",
            like.join(" OR ")
        );
        let mut stmt = conn.prepare(&sql)?;
        let found = stmt
            .query_map([since], |r| {
                Ok((
                    row(r)?,
                    r.get::<_, Option<String>>(12)?,
                    r.get::<_, Option<String>>(13)?,
                    r.get::<_, Option<String>>(14)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut seen = HashSet::new();
        Ok(found
            .into_iter()
            .filter(|(m, _, _, _)| {
                let trimmed = m.subject.trim_start();
                let lower = trimmed.to_lowercase();
                // Replies and forwards are conversations about a bill, not new receipts or invoices.
                let is_reply_or_fwd = ["re:", "fwd:", "fw:", "aw:", "wg:", "odg:", "sv:", "tr:"]
                    .iter()
                    .any(|p| lower.starts_with(p));
                !is_reply_or_fwd && words.iter().any(|w| lower.contains(w))
            })
            .filter(|(m, _, _, mid)| {
                let key = mid.clone().unwrap_or_else(|| format!("{}\0{}", m.subject, m.date));
                seen.insert((m.account_id, key))
            })
            .map(|(m, text, html, _)| {
                let words = match (text, html) {
                    (Some(t), _) if !t.trim().is_empty() => t,
                    (_, Some(h)) => crate::ai::html_text(&h),
                    _ => m.snippet.clone(),
                };
                (m, words.chars().take(6000).collect())
            })
            .collect())
    }

    /// Every file received or sent, newest first (All files, idea 108), up to `limit`, from mail dated in
    /// `since..until` (seconds; the Files screen's date filter, so an old month is reached past the newest
    /// `limit`). Mail in Trash, Spam and Drafts is left out; a message kept in two folders gives its files once.
    pub fn all_files(&self, limit: usize, since: i64, until: i64) -> Result<Vec<PersonFile>> {
        let conn = self.reader();
        let mut stmt = conn.prepare_cached(&format!(
            "SELECT {ROW}, m.parts, {MINE_M}, m.message_id FROM messages m INDEXED BY messages_date
               JOIN folders f ON f.id = m.folder_id JOIN accounts a ON a.id = m.account_id
             WHERE m.has_attachments = 1 AND m.date >= ?2 AND m.date < ?3 AND f.role NOT IN ('trash', 'junk', 'drafts')
             ORDER BY m.date DESC, (m.parts IS NOT NULL) DESC, m.id DESC LIMIT ?1"
        ))?;
        let found = stmt
            .query_map(rusqlite::params![limit as i64 * 2, since, until], |r| {
                Ok((
                    row(r)?,
                    r.get::<_, Option<String>>(12)?,
                    r.get::<_, bool>(13)?,
                    r.get::<_, Option<String>>(14)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut seen = HashSet::new();
        let mut files = Vec::new();
        for (m, parts, mine, mid) in found {
            let attachments = attachments_of(parts.as_deref());
            if attachments.is_empty() {
                continue;
            }
            let key = mid.unwrap_or_else(|| format!("{}\0{}", m.subject, m.date));
            if !seen.insert((m.account_id, key)) {
                continue;
            }
            for (index, a) in attachments.into_iter().enumerate() {
                files.push(PersonFile {
                    message_id: m.id,
                    account_id: m.account_id,
                    thread_id: m.thread_id.clone(),
                    subject: m.subject.clone(),
                    date: m.date,
                    mine,
                    index,
                    name: a.name,
                    mime: a.mime,
                    size: a.size,
                    from: if m.from_name.is_empty() { m.from_addr.clone() } else { m.from_name.clone() },
                });
                if files.len() == limit {
                    return Ok(files);
                }
            }
        }
        Ok(files)
    }
}

impl Store {
    // MARK: Todoist tasks

    /// Queues a Todoist task made from the conversation of message `id`, with the usual undo: it shows in the
    /// conversation at once and goes out after the undo window. The description names the mail (who sent it, its
    /// subject); no mail text. Returns the account (whose worker sends it) and the undo token.
    pub fn queue_task(&self, id: i64, input: &TaskInput, delay: i64) -> Result<(i64, Vec<i64>)> {
        let title = input.title.trim();
        if title.is_empty() {
            bail!("A task needs a title");
        }
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        let (account_id, thread_id, name, addr, subject, message_id): (i64, String, String, String, String, Option<String>) =
            tx.query_row(
                "SELECT account_id, thread_id, from_name, from_addr, subject, message_id FROM messages WHERE id = ?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)),
            )
            .optional()?
            .ok_or_else(|| anyhow::anyhow!("That message is gone"))?;
        let due = input.due.as_deref().map(str::trim).filter(|d| !d.is_empty()).map(str::to_string);
        tx.execute(
            "INSERT INTO tasks (account_id, thread_id, title, due, created, source) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![account_id, thread_id, title, due, now(), input.source],
        )?;
        let local = tx.last_insert_rowid();
        let who = if name.is_empty() { addr } else { name };
        let task = crate::todoist::NewTask {
            content: title.to_string(),
            description: {
                let from = if subject.is_empty() {
                    format!("From {who}")
                } else {
                    format!("From {who} · {subject}")
                };
                // The way back: a link Tern opens at that conversation, by the message's own Message-ID.
                let from = match message_id.as_deref() {
                    Some(mid) => format!("{from}\n[Open in Tern]({})", open_link(mid)),
                    None => from,
                };
                match input.note.as_deref().map(str::trim).filter(|n| !n.is_empty()) {
                    Some(note) => format!("{note}\n\n{from}"),
                    None => from,
                }
            },
            due_string: due,
            project_id: input.project_id.clone().filter(|p| !p.is_empty()),
            labels: input
                .label
                .iter()
                .map(|l| l.trim().trim_start_matches('@').to_string())
                .filter(|l| !l.is_empty())
                .collect(),
        };
        let token = vec![enqueue(&tx, account_id, &OutboxOp::Task { local, task }, delay)?];
        tx.commit()?;
        Ok((account_id, token))
    }

    /// Todoist made the task: its id goes on the row, for the link to it.
    pub fn task_created(&self, local: i64, todoist_id: &str) -> Result<()> {
        self.conn().execute("UPDATE tasks SET todoist_id = ?2 WHERE id = ?1", params![local, todoist_id])?;
        Ok(())
    }

    /// The tasks made from the conversation of message `id`, oldest first.
    pub fn tasks_of(&self, id: i64) -> Result<Vec<TaskRow>> {
        let conn = self.reader();
        let mut stmt = conn.prepare_cached(
            "SELECT DISTINCT t.id, t.title, t.due, t.todoist_id, t.done, t.source, t.created FROM tasks t
             JOIN messages m ON m.account_id = t.account_id AND m.thread_id = t.thread_id
             WHERE m.id = ?1 ORDER BY t.created, t.id",
        )?;
        let rows = stmt
            .query_map([id], |r| {
                let todoist_id: Option<String> = r.get(3)?;
                Ok(TaskRow {
                    id: r.get(0)?,
                    title: r.get(1)?,
                    due: r.get(2)?,
                    url: todoist_id.as_deref().map(crate::todoist::task_url),
                    done: r.get(4)?,
                    source: r.get(5)?,
                })
            })?
            .collect::<rusqlite::Result<_>>()?;
        Ok(rows)
    }

    /// Ticks a task off (or opens it again) here at once, and queues the same for Todoist with the usual undo.
    /// A task not made in Todoist yet changes only here: its creation is still in the outbox.
    pub fn queue_task_done(&self, local: i64, done: bool, delay: i64) -> Result<(i64, Vec<i64>)> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        let (account_id, todoist_id): (i64, Option<String>) = tx
            .query_row("SELECT account_id, todoist_id FROM tasks WHERE id = ?1", [local], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .optional()?
            .ok_or_else(|| anyhow::anyhow!("That task is gone"))?;
        tx.execute("UPDATE tasks SET done = ?2 WHERE id = ?1", params![local, done])?;
        let token = match todoist_id {
            Some(todoist_id) => {
                vec![enqueue(&tx, account_id, &OutboxOp::TaskDone { local, todoist_id, done }, delay)?]
            }
            None => Vec::new(),
        };
        tx.commit()?;
        Ok((account_id, token))
    }

    /// The conversation's tasks that Todoist has and that aren't done here: what opening it asks Todoist about.
    pub fn open_todoist_tasks(&self, id: i64) -> Result<Vec<(i64, String)>> {
        let conn = self.reader();
        let mut stmt = conn.prepare_cached(
            "SELECT DISTINCT t.id, t.todoist_id FROM tasks t
             JOIN messages m ON m.account_id = t.account_id AND m.thread_id = t.thread_id
             WHERE m.id = ?1 AND t.todoist_id IS NOT NULL AND NOT t.done",
        )?;
        let rows = stmt.query_map([id], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<rusqlite::Result<_>>()?;
        Ok(rows)
    }

    /// What Todoist said about a task: done there, or gone (deleted), which takes it off the conversation.
    pub fn task_state(&self, local: i64, state: crate::todoist::TaskState) -> Result<()> {
        let conn = self.conn();
        match state {
            crate::todoist::TaskState::Open => {}
            crate::todoist::TaskState::Done => {
                conn.execute("UPDATE tasks SET done = 1 WHERE id = ?1", [local])?;
            }
            crate::todoist::TaskState::Gone => {
                conn.execute("DELETE FROM tasks WHERE id = ?1", [local])?;
            }
        }
        Ok(())
    }

    /// The message with this Message-ID (from a `tern://` link), for opening its conversation.
    pub fn message_by_message_id(&self, message_id: &str) -> Result<Option<NewMail>> {
        let bare = bare_id(message_id);
        let conn = self.reader();
        Ok(conn
            .query_row(
                "SELECT m.id, m.account_id, m.thread_id, m.from_name, m.from_addr, m.subject, m.snippet
                 FROM messages m WHERE m.message_id = ?1 ORDER BY m.date DESC LIMIT 1",
                [bare],
                |r| {
                    Ok(NewMail {
                        id: r.get(0)?,
                        account_id: r.get(1)?,
                        thread_id: r.get(2)?,
                        from_name: r.get(3)?,
                        from_addr: r.get(4)?,
                        subject: r.get(5)?,
                        snippet: r.get(6)?,
                        other: false,
                    })
                },
            )
            .optional()?)
    }
}

/// `tern://open/<Message-ID>`, percent-encoded: what a task's description links back to. Registered beside `mailto`.
pub fn open_link(message_id: &str) -> String {
    let mut out = String::from("tern://open/");
    for b in bare_id(message_id).bytes() {
        if b.is_ascii_alphanumeric() || b"@.-_~".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// The Message-ID in a `tern://open/…` link, or None for any other link.
pub fn parse_open_link(link: &str) -> Option<String> {
    let rest = link.strip_prefix("tern://open/")?.trim_end_matches('/');
    let bytes = rest.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 3 <= bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    let id = String::from_utf8(out).ok()?;
    (!id.is_empty()).then_some(id)
}

/// Domains anyone can have an address at.
const WEBMAIL: &[&str] = &[
    "gmail.com",
    "googlemail.com",
    "outlook.com",
    "hotmail.com",
    "live.com",
    "yahoo.com",
    "icloud.com",
    "me.com",
    "proton.me",
    "protonmail.com",
    "gmx.com",
    "gmx.net",
    "aol.com",
    "fastmail.com",
];
