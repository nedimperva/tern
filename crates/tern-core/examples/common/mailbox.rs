//! A generated mailbox shaped like a real one, for `store_bench` and for trying the UI on a big store
//! (`gen_mailbox`). Deterministic: the same count gives the same mailbox.
//!
//! Three years of mail across Inbox (30 %), Archive (60 %) and Sent (10 %). Senders follow a Zipf curve over 2,000
//! addresses, so a few people write most of the mail; one sender in seven is a newsletter (List-Unsubscribe, so it
//! lands in Other). About a third of the messages reply to a recent one. A fifth are HTML, one in twelve has an
//! attachment. Mail older than 90 days mostly has headers and a snippet only, as sync leaves it.

use anyhow::Result;
use tern_core::{AccountConfig, NewMessage, Store};

const WORDS: &[&str] = &[
    "invoice", "meeting", "lunch", "release", "budget", "travel", "report", "design", "review", "contract",
    "launch", "offer", "update", "receipt", "schedule", "draft", "feedback", "question", "deadline",
    "weekend",
];
const SENDERS: usize = 2_000;
const SPAN: i64 = 3 * 365 * 86_400;
const END: i64 = 1_792_000_000;

/// xorshift64: fast, and the same sequence every run.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }

    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }

    fn chance(&mut self, percent: u64) -> bool {
        self.below(100) < percent
    }

    fn word(&mut self) -> &'static str {
        WORDS[self.below(WORDS.len() as u64) as usize]
    }
}

/// Fills `store` with `messages` messages in a new account; returns the inbox's folder id.
pub fn generate(store: &Store, messages: u32) -> Result<i64> {
    let account = store.add_account(&AccountConfig {
        email: "me@example.com".into(),
        display_name: "Me".into(),
        username: "me@example.com".into(),
        // Nothing answers here, so a UI pointed at this store shows it offline and never touches a real server.
        imap_host: "imap.invalid".into(),
        imap_port: 993,
        imap_security: tern_core::Security::Tls,
        smtp_host: "smtp.invalid".into(),
        smtp_port: 465,
        smtp_security: tern_core::Security::Tls,
    })?;
    let folders = [
        store.upsert_folder(account.id, "INBOX", "inbox")?,
        store.upsert_folder(account.id, "Archive", "archive")?,
        store.upsert_folder(account.id, "Sent", "sent")?,
    ];

    // Zipf weights 1/rank: cumulative, for a binary search on a uniform draw.
    let mut cumulative = Vec::with_capacity(SENDERS);
    let mut sum = 0.0;
    for rank in 1..=SENDERS {
        sum += 1.0 / rank as f64;
        cumulative.push(sum);
    }
    let mut rng = Rng(0x2545_f491_4f6c_dd1d);
    let mut uids = [0u32; 3];
    let mut batches: [Vec<NewMessage>; 3] = Default::default();
    for i in 1..=messages {
        let date = END - SPAN + SPAN * i as i64 / messages as i64;
        let old = END - date > 90 * 86_400;
        let which = match rng.below(10) {
            0..=2 => 0,
            9 => 2,
            _ => 1,
        };
        uids[which] += 1;
        let draw = rng.next() as f64 / u64::MAX as f64 * sum;
        let rank = cumulative.partition_point(|&c| c < draw) + 1;
        let newsletter = rank % 7 == 0;
        let (from_name, from_addr) = if which == 2 {
            ("Me".to_string(), "me@example.com".to_string())
        } else if newsletter {
            (format!("News {rank}"), format!("news{rank}@list.example"))
        } else {
            (format!("Sender {rank}"), format!("s{rank}@example.com"))
        };
        let subject = format!("{} {} #{i}", rng.word(), rng.word());
        let body = (0..60).map(|_| rng.word()).collect::<Vec<_>>().join(" ");
        // A reply to one of the 300 messages before it, a third of the time.
        let parent = (i > 300 && rng.chance(33)).then(|| format!("{}@gen", i - 1 - rng.below(300) as u32));
        let headers_only = old && rng.chance(70);
        let html = rng.chance(20);
        batches[which].push(NewMessage {
            uid: uids[which],
            message_id: Some(format!("{i}@gen")),
            in_reply_to: parent.clone(),
            references: parent.into_iter().collect(),
            subject,
            from_name,
            from_addr,
            to_addrs: "me@example.com".into(),
            date,
            snippet: body.chars().take(140).collect(),
            // Old mail is read; recent mail is a quarter unread.
            seen: old || !rng.chance(25),
            flagged: rng.chance(2),
            has_attachments: rng.chance(8),
            body_html: (html && !headers_only).then(|| format!("<html><body><p>{body}</p></body></html>")),
            body_text: (!headers_only).then_some(body),
            size: Some(2_000 + rng.below(40_000) as u32),
            headers_only,
            list_unsubscribe: newsletter.then(|| format!("<mailto:leave@list{rank}.example>")),
            ..Default::default()
        });
        if batches[which].len() == 1_000 {
            store.insert_messages(account.id, folders[which], &std::mem::take(&mut batches[which]))?;
        }
    }
    for (which, batch) in batches.iter().enumerate() {
        store.insert_messages(account.id, folders[which], batch)?;
        // As if every folder had been checked: download progress reads as complete.
        store.set_server_count(folders[which], uids[which])?;
    }
    Ok(folders[0])
}
