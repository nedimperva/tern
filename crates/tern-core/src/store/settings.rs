//! Settings and AI: what the person chose, kept in the database.

use super::*;

impl Store {
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

    /// What the start of the day shows: how many conversations got mail since `since` (when the person was last
    /// here), the ones that need them (Important, the newest message someone else's, waiting longest first), the
    /// snoozed ones that came back since then, follow-ups still without an answer, and how many of the new are in
    /// Other. All from this computer.
    pub fn day_start(&self, since: i64) -> Result<DayStart> {
        /// The tide's To read column shows this many at most.
        const TO_READ: usize = 6;
        let conn = self.reader();
        let (important, imp_value) = target_filter(&ListTarget::Role(IMPORTANT.into()), 1);
        let need: Vec<MessageRow> = conn
            .prepare(&format!(
                "SELECT {ROW} FROM messages m JOIN accounts a ON a.id = m.account_id
                 WHERE {important}
                   AND m.id = (SELECT x.id FROM messages x WHERE x.account_id = m.account_id
                                 AND x.thread_id = m.thread_id ORDER BY x.date DESC, x.id DESC LIMIT 1)
                   AND lower(m.from_addr) <> lower(a.email)
                 ORDER BY m.date, m.id LIMIT 200"
            ))?
            .query_map([imp_value], row)?
            .collect::<rusqlite::Result<_>>()?;
        let back: Vec<MessageRow> = conn
            .prepare(&format!(
                "SELECT {ROW} FROM reminders r JOIN messages m ON m.id = (
                     SELECT x.id FROM messages x JOIN folders f ON f.id = x.folder_id
                     WHERE x.account_id = r.account_id AND x.thread_id = r.thread_id AND f.role = 'inbox'
                     ORDER BY x.date DESC, x.id DESC LIMIT 1)
                 WHERE r.kind = 'woke' AND r.due > ?1 ORDER BY r.due"
            ))?
            .query_map([since], row)?
            .collect::<rusqlite::Result<_>>()?;
        let waiting: Vec<MessageRow> = conn
            .prepare(&format!(
                "SELECT {ROW} FROM reminders r JOIN messages m ON m.id = (
                     SELECT id FROM messages WHERE account_id = r.account_id AND thread_id = {FOLLOW_UP_THREAD}
                     ORDER BY date DESC, id DESC LIMIT 1)
                 WHERE r.kind = 'followup' AND r.fired ORDER BY r.due"
            ))?
            .query_map([], row)?
            .collect::<rusqlite::Result<_>>()?;
        let count = |role: &str| -> Result<i64> {
            let (filter, value) = target_filter(&ListTarget::Role(role.into()), 1);
            Ok(conn.query_row(
                &format!(
                    "SELECT count(*) FROM (SELECT DISTINCT m.account_id, m.thread_id FROM messages m
                     WHERE {filter} AND m.date > ?2)"
                ),
                params![value, since],
                |r| r.get(0),
            )?)
        };
        let new_since = count("inbox")?;
        let rest = count(OTHER)?;
        let newest = |filter: &str, extra: &str| -> String {
            format!(
                "SELECT {ROW} FROM messages m WHERE {filter} {extra}
                   AND m.id = (SELECT x.id FROM messages x WHERE x.account_id = m.account_id
                                 AND x.thread_id = m.thread_id ORDER BY x.date DESC, x.id DESC LIMIT 1)
                 ORDER BY m.date DESC, m.id DESC LIMIT {TO_READ}"
            )
        };
        let (later, later_value) = target_filter(&ListTarget::Role(LATER.into()), 1);
        let mut reading: Vec<MessageRow> = conn
            .prepare(&newest(&later, ""))?
            .query_map([later_value], row)?
            .collect::<rusqlite::Result<_>>()?;
        let (inbox, inbox_value) = target_filter(&ListTarget::Role("inbox".into()), 1);
        let lists: Vec<MessageRow> = conn
            .prepare(&newest(
                &inbox,
                "AND m.date > ?2 AND (m.list_id IS NOT NULL OR m.list_unsubscribe IS NOT NULL)",
            ))?
            .query_map(params![inbox_value, since], row)?
            .collect::<rusqlite::Result<_>>()?;
        reading.extend(lists);
        reading.truncate(TO_READ);
        let mut minutes = conn.prepare_cached("SELECT length(text) FROM bodies WHERE message_id = ?1")?;
        let to_read = conversations(&conn, reading)?
            .into_iter()
            .map(|thread| {
                let chars: Option<i64> =
                    minutes.query_row([thread.latest.id], |r| r.get(0)).optional()?.flatten();
                // About 6 characters a word with its space, 230 words a minute; never "0 min".
                let minutes = chars.filter(|&c| c > 0).map(|c| (c / (6 * 230)).max(1));
                Ok(ToRead { thread, minutes })
            })
            .collect::<Result<_>>()?;
        Ok(DayStart {
            since,
            new_since,
            need_you: conversations(&conn, need)?,
            back: conversations(&conn, back)?,
            waiting: conversations(&conn, waiting)?,
            rest,
            to_read,
        })
    }

    /// When each message from someone else arrived since `since` (Unix seconds), wherever it is now: the tide
    /// report counts the week's mail, archived or not. A message in two folders (Gmail labels) counts once.
    pub fn arrivals(&self, since: i64) -> Result<Vec<i64>> {
        let conn = self.reader();
        let mut stmt = conn.prepare_cached(
            "SELECT min(m.date) FROM messages m
             JOIN folders f ON f.id = m.folder_id JOIN accounts a ON a.id = m.account_id
             WHERE m.date > ?1 AND f.role NOT IN ('sent', 'drafts', 'junk')
               AND lower(m.from_addr) <> lower(a.email)
             GROUP BY m.account_id, coalesce(m.message_id, m.id)",
        )?;
        let dates = stmt.query_map([since], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?;
        Ok(dates)
    }

    /// The senders who wrote most since `since`, most first: who fills the inbox.
    pub fn senders(&self, since: i64, limit: i64) -> Result<Vec<SenderVolume>> {
        let conn = self.reader();
        let mut stmt = conn.prepare_cached(
            "SELECT m.account_id, lower(m.from_addr), max(m.from_name), count(DISTINCT coalesce(m.message_id, m.id)),
                    max(m.id),
                    -- From their mail in the window: a lookup across all their mail took a second per page.
                    max(m.list_unsubscribe),
                    COALESCE((SELECT s.other FROM sender_splits s
                               WHERE s.account_id = m.account_id AND s.addr = lower(m.from_addr)), max(m.bulk))
             FROM messages m JOIN folders f ON f.id = m.folder_id JOIN accounts a ON a.id = m.account_id
             WHERE m.date > ?1 AND f.role NOT IN ('sent', 'drafts', 'junk') AND m.from_addr <> ''
               AND lower(m.from_addr) <> lower(a.email)
             GROUP BY m.account_id, lower(m.from_addr)
             ORDER BY 4 DESC, 2 LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![since, limit], |r| {
            Ok(SenderVolume {
                account_id: r.get(0)?,
                addr: r.get(1)?,
                name: r.get(2)?,
                count: r.get(3)?,
                newest: r.get(4)?,
                list_unsubscribe: r.get(5)?,
                other: r.get(6)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    // MARK: AI

    /// A kept AI answer for exactly this request (see `ai::key_hash`).
    pub fn ai_cached(&self, kind: &str, key_hash: &str, model: &str) -> Result<Option<String>> {
        Ok(self
            .conn()
            .query_row(
                "SELECT text FROM ai_cache WHERE kind = ?1 AND key_hash = ?2 AND model = ?3",
                params![kind, key_hash, model],
                |r| r.get(0),
            )
            .optional()?)
    }

    pub fn ai_keep(
        &self,
        kind: &str,
        key_hash: &str,
        model: &str,
        account_id: Option<i64>,
        text: &str,
    ) -> Result<()> {
        self.conn().execute(
            "INSERT OR REPLACE INTO ai_cache (kind, key_hash, model, account_id, text, created)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![kind, key_hash, model, account_id, text, now()],
        )?;
        Ok(())
    }

    /// Settings → AI → "Delete AI cache". Returns how many answers were dropped.
    pub fn ai_clear_cache(&self) -> Result<usize> {
        Ok(self.conn().execute("DELETE FROM ai_cache", [])?)
    }

    /// Tokens (sent and received) spent on the UTC day `day` (Unix seconds / 86400).
    pub fn ai_tokens(&self, day: i64) -> Result<i64> {
        Ok(self
            .conn()
            .query_row("SELECT tokens FROM ai_usage WHERE day = ?1", [day], |r| r.get(0))
            .optional()?
            .unwrap_or(0))
    }

    /// How many kept answers there are of each kind ("summary", "replies"), for Settings → AI.
    pub fn ai_kept(&self) -> Result<HashMap<String, i64>> {
        let conn = self.conn();
        let mut stmt = conn.prepare("SELECT kind, count(*) FROM ai_cache GROUP BY kind")?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?;
        let mut out: HashMap<String, i64> = rows.collect::<rusqlite::Result<_>>()?;
        let styles: i64 = conn.query_row("SELECT count(*) FROM ai_styles", [], |r| r.get(0))?;
        out.insert("style".into(), styles);
        Ok(out)
    }

    pub fn ai_spend(&self, day: i64, tokens: i64) -> Result<()> {
        self.conn().execute(
            "INSERT INTO ai_usage (day, tokens) VALUES (?1, ?2)
             ON CONFLICT (day) DO UPDATE SET tokens = tokens + excluded.tokens",
            params![day, tokens],
        )?;
        Ok(())
    }

    /// The row of the account's message with this Message-ID (with or without its angle brackets), if it is here.
    pub fn message_row(&self, account_id: i64, message_id: &str) -> Result<Option<i64>> {
        Ok(self
            .conn()
            .query_row(
                "SELECT id FROM messages WHERE account_id = ?1 AND message_id = ?2 ORDER BY date DESC LIMIT 1",
                params![account_id, bare_id(message_id)],
                |r| r.get(0),
            )
            .optional()?)
    }

    /// The account's style note, if one was learned (or written by hand).
    pub fn ai_style(&self, account_id: i64) -> Result<Option<AiStyle>> {
        Ok(self
            .conn()
            .query_row(
                "SELECT account_id, note, samples, updated FROM ai_styles WHERE account_id = ?1",
                [account_id],
                |r| {
                    Ok(AiStyle {
                        account_id: r.get(0)?,
                        note: r.get(1)?,
                        samples: r.get(2)?,
                        updated: r.get(3)?,
                    })
                },
            )
            .optional()?)
    }

    /// Saves the note; `samples` is how many sent messages it was learned from (kept when the person edits it).
    pub fn set_ai_style(&self, account_id: i64, note: &str, samples: i64) -> Result<()> {
        self.conn().execute(
            "INSERT INTO ai_styles (account_id, note, samples, updated) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT (account_id) DO UPDATE SET note = excluded.note, samples = excluded.samples,
                                                    updated = excluded.updated",
            params![account_id, note, samples, now()],
        )?;
        Ok(())
    }

    pub fn delete_ai_style(&self, account_id: i64) -> Result<()> {
        self.conn().execute("DELETE FROM ai_styles WHERE account_id = ?1", [account_id])?;
        Ok(())
    }
}
