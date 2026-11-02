//! Marks and notes made while reading.

use super::*;

impl Store {
    // MARK: Marks (reading)

    /// The marks on these messages, in the order they were made. `message` is the first of the given ids that
    /// carries the marked message.
    pub fn marks(&self, message_ids: &[i64]) -> Result<Vec<Mark>> {
        if message_ids.is_empty() {
            return Ok(Vec::new());
        }
        let conn = self.conn();
        let ids = message_ids.iter().map(|i| i.to_string()).collect::<Vec<_>>().join(",");
        let mut stmt = conn.prepare(&format!(
            "SELECT k.id, MIN(m.id), k.text, k.note, k.created FROM marks k
             JOIN messages m ON m.account_id = k.account_id AND {KEY} = k.message_key
             WHERE m.id IN ({ids}) GROUP BY k.id ORDER BY k.created, k.id"
        ))?;
        let rows = stmt.query_map([], |r| {
            Ok(Mark {
                id: r.get(0)?,
                message: r.get(1)?,
                text: r.get(2)?,
                note: r.get(3)?,
                created: r.get(4)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    pub fn add_mark(&self, message_id: i64, text: &str, note: &str) -> Result<Mark> {
        let conn = self.conn();
        let created = now();
        conn.execute(
            &format!(
                "INSERT INTO marks (account_id, message_key, text, note, created)
                 SELECT m.account_id, {KEY}, ?2, ?3, ?4 FROM messages m WHERE m.id = ?1"
            ),
            params![message_id, text, note, created],
        )?;
        if conn.changes() == 0 {
            bail!("That message is no longer here.");
        }
        Ok(Mark {
            id: conn.last_insert_rowid(),
            message: message_id,
            text: text.into(),
            note: note.into(),
            created,
        })
    }

    pub fn set_mark_note(&self, id: i64, note: &str) -> Result<()> {
        self.conn().execute("UPDATE marks SET note = ?2 WHERE id = ?1", params![id, note])?;
        Ok(())
    }

    pub fn delete_mark(&self, id: i64) -> Result<()> {
        self.conn().execute("DELETE FROM marks WHERE id = ?1", [id])?;
        Ok(())
    }

    /// The text of the newest messages the person sent from the account (by its address or an alias, so Gmail's sent mail,
    /// which lives in All Mail, counts too), each once. Only messages whose text is here.
    pub fn own_texts(&self, account_id: i64, address: &str, limit: usize) -> Result<Vec<String>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT b.text FROM messages m JOIN bodies b ON b.message_id = m.id
             WHERE m.account_id = ?1 AND COALESCE(b.text, '') != ''
               AND (m.from_addr = ?2 COLLATE NOCASE
                    OR lower(m.from_addr) IN (SELECT email FROM account_aliases WHERE account_id = ?1))
               AND NOT EXISTS (SELECT 1 FROM drafts d WHERE d.account_id = m.account_id
                                 AND d.message_id = m.message_id AND d.sent_at IS NULL)
             GROUP BY COALESCE(m.message_id, m.id)
             ORDER BY max(m.date) DESC LIMIT ?3",
        )?;
        let rows = stmt.query_map(params![account_id, address, limit as i64], |r| r.get(0))?;
        Ok(rows.collect::<rusqlite::Result<Vec<String>>>()?)
    }
}
