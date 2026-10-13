//! Times what the UI asks the store for, on a mailbox of 50,000 messages.
//!
//!     cargo run --release -p kite-core --example store_bench
//!
//! Targets: a list page under 1 ms, search under 5 ms, archiving 50 under 20 ms.

use std::time::{Duration, Instant};

use kite_core::{Action, AccountConfig, Cursor, ListTarget, NewMessage, Store};

const MESSAGES: u32 = 50_000;
const WORDS: &[&str] = &[
    "invoice", "meeting", "lunch", "release", "budget", "travel", "report", "design", "review", "contract", "launch",
    "offer", "update", "receipt", "schedule", "draft", "feedback", "question", "deadline", "weekend",
];

fn main() -> anyhow::Result<()> {
    let path = std::env::temp_dir().join("kite-bench.db");
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
        smtp_host: "smtp.example.com".into(),
        smtp_port: 465,
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
                NewMessage {
                    uid,
                    message_id: Some(format!("{uid}@bench")),
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
    let first = store.list(&target, None, 1)?[0].id;
    report("open thread", 200, || {
        store.thread(first).unwrap();
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
