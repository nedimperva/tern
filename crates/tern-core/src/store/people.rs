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
        let like = format!("%{}%", email.replace(['%', '_'], ""));
        let conn = self.reader();
        let pick = |r: &Row, mine: bool| -> rusqlite::Result<(MessageRow, bool, Option<String>)> {
            Ok((row(r)?, mine, r.get(12)?))
        };
        let mut found: Vec<(MessageRow, bool, Option<String>)> = conn
            .prepare_cached(&format!(
                "SELECT {ROW}, m.parts FROM messages m INDEXED BY messages_from
                 WHERE m.from_addr = ?1 COLLATE NOCASE AND m.has_attachments = 1
                 ORDER BY m.date DESC LIMIT 100"
            ))?
            .query_map([&email], |r| pick(r, false))?
            .collect::<rusqlite::Result<_>>()?;
        let sent = conn
            .prepare_cached(&format!(
                "SELECT {ROW}, m.parts FROM messages m INDEXED BY messages_date JOIN accounts a ON a.id = m.account_id
                 WHERE m.has_attachments = 1 AND m.to_addrs LIKE ?1 AND {MINE_M}
                 ORDER BY m.date DESC, m.id DESC LIMIT 50"
            ))?
            .query_map([&like], |r| pick(r, true))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        found.extend(sent);
        found.sort_by(|a, b| b.0.date.cmp(&a.0.date).then(b.0.id.cmp(&a.0.id)));
        // The same message can be in two folders (a copy in Sent and in a label): its files once.
        let mut seen = HashSet::new();
        let mut files = Vec::new();
        for (m, mine, parts) in found {
            if !seen.insert((m.account_id, m.subject.clone(), m.date)) {
                continue;
            }
            for (index, a) in attachments_of(parts.as_deref()).into_iter().enumerate() {
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
                });
                if files.len() == limit {
                    return Ok(files);
                }
            }
        }
        Ok(files)
    }
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
