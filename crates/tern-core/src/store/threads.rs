//! Splitting and joining conversations by hand (idea 110). Local only: the server has no conversations to tell.
//! Each moved message is recorded by Message-ID in `thread_moves`, which `thread_for` reads first, so the shape
//! survives a resync and new replies follow the message they answer.

use super::*;
use anyhow::anyhow;
use serde::Deserialize;

/// Where messages were before a split or join, for Undo.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadUndo {
    pub moves: Vec<(i64, String)>,
    /// After a split, the new conversation and the one it came from: replies that arrived in between go back too.
    #[serde(default)]
    pub split: Option<(String, String)>,
}

impl Store {
    /// Takes message `id` and everything after it in its conversation into a conversation of their own.
    pub fn split_conversation(&self, id: i64) -> Result<ThreadUndo> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        let (account, thread, date, own): (i64, String, i64, Option<String>) = tx
            .query_row(
                "SELECT account_id, thread_id, date, message_id FROM messages WHERE id = ?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .optional()?
            .ok_or_else(|| anyhow!("That message is gone."))?;
        let ids: Vec<i64> = tx
            .prepare(
                "SELECT id FROM messages WHERE account_id = ?1 AND thread_id = ?2
                   AND (date > ?3 OR (date = ?3 AND id >= ?4))",
            )?
            .query_map(params![account, thread, date, id], |r| r.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        let earlier: bool = tx.query_row(
            "SELECT EXISTS (SELECT 1 FROM messages WHERE account_id = ?1 AND thread_id = ?2
               AND (date < ?3 OR (date = ?3 AND id < ?4)))",
            params![account, thread, date, id],
            |r| r.get(0),
        )?;
        if !earlier {
            bail!("This is where the conversation starts already.");
        }
        let new = format!("split:{}", own.unwrap_or_else(|| format!("#{id}")));
        let mut undo = move_to(&tx, account, &ids, &new)?;
        undo.split = Some((new, thread));
        tx.commit()?;
        Ok(undo)
    }

    /// Puts the conversations of messages `ids` together, into the conversation of the first.
    pub fn join_conversations(&self, ids: &[i64]) -> Result<ThreadUndo> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        let Some(first) = ids.first() else { bail!("Pick the conversations to join.") };
        let (account, target): (i64, String) =
            tx.query_row("SELECT account_id, thread_id FROM messages WHERE id = ?1", [first], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })?;
        let mut moving = Vec::new();
        for id in &ids[1..] {
            let (a, t): (i64, String) =
                tx.query_row("SELECT account_id, thread_id FROM messages WHERE id = ?1", [id], |r| {
                    Ok((r.get(0)?, r.get(1)?))
                })?;
            if a != account {
                bail!("Conversations from two accounts can't be joined.");
            }
            if t == target {
                continue;
            }
            let mut stmt = tx.prepare("SELECT id FROM messages WHERE account_id = ?1 AND thread_id = ?2")?;
            for m in stmt.query_map(params![a, t], |r| r.get::<_, i64>(0))? {
                moving.push(m?);
            }
        }
        if moving.is_empty() {
            bail!("Those are one conversation already.");
        }
        let undo = move_to(&tx, account, &moving, &target)?;
        tx.commit()?;
        Ok(undo)
    }

    /// Puts messages back where a split or join found them, and forgets that they were moved.
    pub fn undo_thread_moves(&self, undo: &ThreadUndo) -> Result<()> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        if let Some((new, old)) = &undo.split {
            tx.execute("DELETE FROM thread_moves WHERE thread_id = ?1", [new])?;
            tx.execute("UPDATE messages SET thread_id = ?2 WHERE thread_id = ?1", params![new, old])?;
        }
        for (id, thread) in &undo.moves {
            tx.execute("UPDATE messages SET thread_id = ?2 WHERE id = ?1", params![id, thread])?;
            tx.execute(
                "DELETE FROM thread_moves WHERE (account_id, message_id) =
                   (SELECT account_id, message_id FROM messages WHERE id = ?1)",
                [id],
            )?;
        }
        tx.commit()?;
        Ok(())
    }
}

fn move_to(tx: &Connection, account: i64, ids: &[i64], thread: &str) -> Result<ThreadUndo> {
    let mut moves = Vec::with_capacity(ids.len());
    for id in ids {
        let (was, message_id): (String, Option<String>) =
            tx.query_row("SELECT thread_id, message_id FROM messages WHERE id = ?1", [id], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })?;
        tx.execute("UPDATE messages SET thread_id = ?2 WHERE id = ?1", params![id, thread])?;
        if let Some(mid) = message_id {
            tx.execute(
                "INSERT INTO thread_moves (account_id, message_id, thread_id) VALUES (?1, ?2, ?3)
                 ON CONFLICT (account_id, message_id) DO UPDATE SET thread_id = excluded.thread_id",
                params![account, mid, thread],
            )?;
        }
        moves.push((*id, was));
    }
    Ok(ThreadUndo { moves, split: None })
}
