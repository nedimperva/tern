//! Contacts, snippets and signatures, for writing mail.

use super::*;

impl Store {
    // MARK: Contacts

    /// People whose name or address starts with `query` (or a word of the name does), best first: written to
    /// counts three times as much as written by, and both fade over months.
    pub fn contacts(&self, query: &str, limit: i64) -> Result<Vec<Contact>> {
        let q = query.trim().replace(['%', '_'], "");
        if q.is_empty() {
            return Ok(Vec::new());
        }
        let conn = self.reader();
        let mut stmt = conn.prepare_cached(
            "SELECT email, name FROM contacts
             WHERE email LIKE ?1 || '%' OR name LIKE ?1 || '%' OR name LIKE '% ' || ?1 || '%'
             ORDER BY (3 * sent_count + received_count) / (1.0 + (?2 - last_seen) / 2592000.0) DESC, email
             LIMIT ?3",
        )?;
        let found = stmt
            .query_map(params![q, now(), limit], |r| Ok(Contact { email: r.get(0)?, name: r.get(1)? }))?
            .collect::<rusqlite::Result<_>>()?;
        Ok(found)
    }

    /// The card for `email`: their name and counts from `contacts`, and the latest `limit` conversations they wrote
    /// or were written to in. Walks the date index newest first, so someone you hear from often costs little.
    pub fn contact_card(&self, email: &str, limit: usize) -> Result<ContactCard> {
        let email = email.trim();
        let conn = self.reader();
        let (name, sent, received) = conn
            .query_row(
                "SELECT name, sent_count, received_count FROM contacts WHERE email = ?1",
                [email],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?
            .unwrap_or_default();
        let like = format!("%{}%", email.replace(['%', '_'], ""));
        let mut stmt = conn.prepare_cached(&format!(
            "SELECT {ROW} FROM messages m INDEXED BY messages_date
             WHERE m.from_addr = ?1 COLLATE NOCASE OR m.to_addrs LIKE ?2
             ORDER BY m.date DESC, m.id DESC LIMIT 200"
        ))?;
        let mut seen = HashSet::new();
        let mut recent = Vec::new();
        for found in stmt.query_map(params![email, like], row)? {
            let found = found?;
            if seen.insert((found.account_id, found.thread_id.clone())) {
                recent.push(found);
                if recent.len() == limit {
                    break;
                }
            }
        }
        Ok(ContactCard { email: email.to_string(), name, sent, received, recent })
    }

    // MARK: Snippets

    /// Every snippet, the most used first.
    pub fn snippets(&self) -> Result<Vec<Snippet>> {
        let conn = self.conn();
        let mut stmt = conn.prepare_cached(
            "SELECT id, shortcut, name, body, account_id, subject, cc, used, last_used
             FROM snippets ORDER BY used DESC, shortcut",
        )?;
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    Snippet {
                        id: r.get(0)?,
                        shortcut: r.get(1)?,
                        name: r.get(2)?,
                        body: r.get(3)?,
                        account_id: r.get(4)?,
                        subject: r.get(5)?,
                        cc: Vec::new(),
                        used: r.get(7)?,
                        last_used: r.get(8)?,
                    },
                    r.get::<_, String>(6)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows.into_iter().map(|(s, cc)| Ok(Snippet { cc: serde_json::from_str(&cc)?, ..s })).collect()
    }

    /// Adds the snippet (id 0) or changes it. Shortcuts are one word, unique whatever their case. An empty subject
    /// is none; the use count is the store's own and stays as it was.
    pub fn save_snippet(&self, snippet: &Snippet) -> Result<i64> {
        let shortcut = snippet.shortcut.trim().trim_start_matches(';');
        if shortcut.is_empty() || shortcut.chars().any(char::is_whitespace) {
            bail!("A shortcut is one word, such as thanks.");
        }
        let conn = self.conn();
        let taken: Option<i64> = conn
            .query_row(
                "SELECT id FROM snippets WHERE shortcut = ?1 AND id != ?2",
                params![shortcut, snippet.id],
                |r| r.get(0),
            )
            .optional()?;
        if taken.is_some() {
            bail!("Another snippet already uses ;{shortcut}.");
        }
        let subject = snippet.subject.as_deref().map(str::trim).filter(|s| !s.is_empty());
        let cc: Vec<&str> = snippet.cc.iter().map(|a| a.trim()).filter(|a| !a.is_empty()).collect();
        let cc = serde_json::to_string(&cc)?;
        if snippet.id == 0 {
            conn.execute(
                "INSERT INTO snippets (shortcut, name, body, account_id, subject, cc) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![shortcut, snippet.name.trim(), snippet.body, snippet.account_id, subject, cc],
            )?;
            Ok(conn.last_insert_rowid())
        } else {
            conn.execute(
                "UPDATE snippets SET shortcut = ?1, name = ?2, body = ?3, account_id = ?4, subject = ?5, cc = ?6
                 WHERE id = ?7",
                params![shortcut, snippet.name.trim(), snippet.body, snippet.account_id, subject, cc, snippet.id],
            )?;
            Ok(snippet.id)
        }
    }

    pub fn delete_snippet(&self, id: i64) -> Result<()> {
        self.conn().execute("DELETE FROM snippets WHERE id = ?1", [id])?;
        Ok(())
    }

    /// Counts a use, so the snippets used most come first in the picker, and settings can say when it was last.
    pub fn snippet_used(&self, id: i64) -> Result<()> {
        self.conn().execute(
            "UPDATE snippets SET used = used + 1, last_used = ?2 WHERE id = ?1",
            params![id, now()],
        )?;
        Ok(())
    }

    // MARK: Signatures

    /// Every account's signatures, each account's in the order they were made.
    pub fn signatures(&self) -> Result<Vec<Signature>> {
        let conn = self.conn();
        let mut stmt = conn.prepare_cached(
            "SELECT id, account_id, name, body, html, custom, for_new, for_reply FROM signatures
             ORDER BY account_id, id",
        )?;
        let all = stmt
            .query_map([], |r| {
                Ok(Signature {
                    id: r.get(0)?,
                    account_id: r.get(1)?,
                    name: r.get(2)?,
                    body: r.get(3)?,
                    html: r.get(4)?,
                    custom: r.get(5)?,
                    for_new: r.get(6)?,
                    for_reply: r.get(7)?,
                })
            })?
            .collect::<rusqlite::Result<_>>()?;
        Ok(all)
    }

    /// Adds the signature (id 0) or changes its name and text. Which mail it goes on is `set_signature_default`'s;
    /// an account's first signature goes on both new mail and replies.
    pub fn save_signature(&self, signature: &Signature) -> Result<i64> {
        let conn = self.conn();
        let name = signature.name.trim();
        // The person's own HTML is cleaned like any mail: it shows in Tern, and it goes to everyone written to.
        let html = match (&signature.html, signature.custom) {
            (Some(html), true) => Some(crate::mime::sanitize_html(html)),
            (html, _) => html.clone(),
        };
        if signature.id == 0 {
            let first: bool = conn.query_row(
                "SELECT NOT EXISTS (SELECT 1 FROM signatures WHERE account_id = ?1)",
                [signature.account_id],
                |r| r.get(0),
            )?;
            conn.execute(
                "INSERT INTO signatures (account_id, name, body, html, custom, for_new, for_reply)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
                params![signature.account_id, name, signature.body, html, signature.custom, first],
            )?;
            Ok(conn.last_insert_rowid())
        } else {
            conn.execute(
                "UPDATE signatures SET name = ?2, body = ?3, html = ?4, custom = ?5 WHERE id = ?1",
                params![signature.id, name, signature.body, html, signature.custom],
            )?;
            Ok(signature.id)
        }
    }

    /// The account's signature for new mail (or, with `reply`, for replies and forwards): `id`, or none.
    pub fn set_signature_default(&self, account_id: i64, reply: bool, id: Option<i64>) -> Result<()> {
        let column = if reply { "for_reply" } else { "for_new" };
        self.conn().execute(
            &format!("UPDATE signatures SET {column} = (id IS ?2) WHERE account_id = ?1"),
            params![account_id, id],
        )?;
        Ok(())
    }

    pub fn delete_signature(&self, id: i64) -> Result<()> {
        self.conn().execute("DELETE FROM signatures WHERE id = ?1", [id])?;
        Ok(())
    }
}
