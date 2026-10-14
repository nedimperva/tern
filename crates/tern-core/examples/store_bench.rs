//! Times what the UI asks the store for, on a mailbox of 50,000 messages.
//!
//!     cargo run --release -p tern-core --example store_bench
//!
//! Targets: a list page under 1 ms, search under 5 ms, archiving 50 under 20 ms, a conversation list page under
//! 1 ms, opening a conversation under 50 ms. About a third of the messages are replies, so conversations have
//! one to a dozen messages.

use std::time::{Duration, Instant};

use tern_core::{AccountConfig, Action, Cursor, ListTarget, NewMessage, Store};

const MESSAGES: u32 = 50_000;
const WORDS: &[&str] = &[
    "invoice", "meeting", "lunch", "release", "budget", "travel", "report", "design", "review", "contract",
    "launch", "offer", "update", "receipt", "schedule", "draft", "feedback", "question", "deadline",
    "weekend",
];

fn main() -> anyhow::Result<()> {
    let path = std::env::temp_dir().join("tern-bench.db");
    for suffix in ["", "-wal", "-shm"] {
        let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
    }
    let store = Store::open(&path)?;
    let account = store.add_account(&AccountConfig {
        email: "bench@example.com".into(),
        display_name: "Bench".into(),
        username: "bench@example.com".into(),
        imap_host: "imap.example.com".into(),
        imap_port: 993,
        imap_security: tern_core::Security::Tls,
        smtp_host: "smtp.example.com".into(),
        smtp_port: 465,
        smtp_security: tern_core::Security::Tls,
    })?;
    let inbox = store.upsert_folder(account.id, "INBOX", "inbox")?;
    store.upsert_folder(account.id, "Archive", "archive")?;

    let started = Instant::now();
    let mut rng = 0x2545_f491_4f6c_dd1du64;
    let mut next = move || {
        rng ^= rng << 13;
        rng ^= rng >> 7;
        rng ^= rng << 17;
        rng
    };
    for chunk in (1..=MESSAGES).collect::<Vec<_>>().chunks(1000) {
        let batch: Vec<NewMessage> = chunk
            .iter()
            .map(|&uid| {
                let word = |n: u64| WORDS[(n % WORDS.len() as u64) as usize];
                let subject = format!("{} {} #{uid}", word(next()), word(next()));
                let body = (0..60).map(|_| word(next())).collect::<Vec<_>>().join(" ");
                // A reply to one of the last 200 messages, a third of the time.
                let parent = (uid > 200 && next() % 3 == 0)
                    .then(|| format!("{}@bench", uid - 1 - (next() % 200) as u32));
                NewMessage {
                    uid,
                    message_id: Some(format!("{uid}@bench")),
                    in_reply_to: parent,
                    subject,
                    from_name: format!("Sender {}", next() % 500),
                    from_addr: format!("s{}@example.com", next() % 500),
                    date: 1_700_000_000 + uid as i64 * 60,
                    snippet: body.chars().take(140).collect(),
                    seen: next() % 4 != 0,
                    body_text: Some(body),
                    ..Default::default()
                }
            })
            .collect();
        store.insert_messages(account.id, inbox, &batch)?;
    }
    println!("seeded {MESSAGES} messages in {:.1} s", started.elapsed().as_secs_f64());

    let target = ListTarget::Folder(inbox);
    report("first page (100 rows)", 200, || {
        store.list(&target, None, 100).unwrap();
    });
    let deep = store.list(&target, None, 25_000)?.last().map(|r| Cursor { date: r.date, id: r.id });
    report("page 250 (100 rows)", 200, || {
        store.list(&target, deep, 100).unwrap();
    });
    report("unified inbox page", 200, || {
        store.list(&ListTarget::Role("inbox".into()), None, 100).unwrap();
    });
    report("search one word", 100, || {
        store.search("invoice", 100).unwrap();
    });
    report("search two prefixes", 100, || {
        store.search("inv bud", 100).unwrap();
    });
    report("conversation page (50)", 200, || {
        store.list_threads(&target, None, 50).unwrap();
    });
    let mut cursor = None;
    for _ in 0..100 {
        let page = store.list_threads(&target, cursor, 50)?;
        cursor = page.last().map(|t| Cursor { date: t.latest.date, id: t.latest.id });
    }
    report("conversation page 101 (50)", 200, || {
        store.list_threads(&target, cursor, 50).unwrap();
    });
    let biggest = store.list_threads(&target, None, 500)?.into_iter().max_by_key(|t| t.count).unwrap();
    println!("largest conversation in the first 500: {} messages", biggest.count);
    report("open conversation", 200, || {
        store.thread(biggest.latest.id).unwrap();
    });
    report("folders + unread counts", 100, || {
        store.folders().unwrap();
    });
    report("archive 50 + undo", 50, || {
        let ids: Vec<i64> = store.list(&target, None, 50).unwrap().iter().map(|r| r.id).collect();
        let applied = store.apply(&ids, Action::Archive, 5).unwrap();
        store.undo(&applied.token).unwrap();
    });
    Ok(())
}

fn report(name: &str, runs: usize, mut f: impl FnMut()) {
    f();
    let mut times: Vec<Duration> = (0..runs)
        .map(|_| {
            let t = Instant::now();
            f();
            t.elapsed()
        })
        .collect();
    times.sort();
    let ms = |d: Duration| d.as_secs_f64() * 1000.0;
    println!(
        "{name:<26} median {:>7.3} ms   p95 {:>7.3} ms",
        ms(times[runs / 2]),
        ms(times[runs * 95 / 100])
    );
}
