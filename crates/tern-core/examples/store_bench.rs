//! Times what the UI asks the store for, on a generated mailbox of 100,000 messages (`common/mailbox.rs`), and
//! exits with an error when a median misses its target (docs/PLAN.md, "Performance evidence"):
//!
//!     cargo run --release -p tern-core --example store_bench
//!
//! TERN_BENCH_MESSAGES changes the size; TERN_BENCH_SLACK multiplies every target, for slower machines such as CI
//! runners (CI uses 3). Rows without a target are measured and printed only.

#[path = "common/mailbox.rs"]
mod mailbox;

use std::time::{Duration, Instant};

use tern_core::{Action, Cursor, ListTarget, Store};

/// List pages (messages or conversations) and a conversation page deep in the list.
const LIST: Option<f64> = Some(1.0);
/// Other scans inbox rows for the few that are bulk mail or from senders moved there (about 1 in 12 here); an
/// index for it waits (docs/sprints/sprint-06-search-and-speed.md, Decisions).
const OTHER_LIST: Option<f64> = Some(5.0);
const SEARCH: Option<f64> = Some(10.0);
const OPEN: Option<f64> = Some(50.0);
const ARCHIVE: Option<f64> = Some(20.0);
const NONE: Option<f64> = None;

fn main() -> anyhow::Result<()> {
    let messages: u32 =
        std::env::var("TERN_BENCH_MESSAGES").ok().and_then(|n| n.parse().ok()).unwrap_or(100_000);
    let slack: f64 = std::env::var("TERN_BENCH_SLACK").ok().and_then(|n| n.parse().ok()).unwrap_or(1.0);
    let path = std::env::temp_dir().join("tern-bench.db");
    for suffix in ["", "-wal", "-shm"] {
        let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
    }
    let store = Store::open(&path)?;
    let started = Instant::now();
    let inbox = mailbox::generate(&store, messages)?;
    println!("seeded {messages} messages in {:.1} s", started.elapsed().as_secs_f64());
    let mut bench = Bench { slack, missed: Vec::new() };

    let target = ListTarget::Folder(inbox);
    bench.report("first page (100 rows)", 200, LIST, || {
        store.list(&target, None, 100).unwrap();
    });
    let deep = store.list(&target, None, 25_000)?.last().map(|r| Cursor { date: r.date, id: r.id });
    bench.report("page 250 (100 rows)", 200, LIST, || {
        store.list(&target, deep, 100).unwrap();
    });
    bench.report("unified inbox page", 200, LIST, || {
        store.list(&ListTarget::Role("inbox".into()), None, 100).unwrap();
    });
    bench.report("unified inbox, conversations (50)", 200, LIST, || {
        store.list_threads(&ListTarget::Role("inbox".into()), None, 50).unwrap();
    });
    bench.report("Important split, conversations (50)", 200, LIST, || {
        store.list_threads(&ListTarget::Role("important".into()), None, 50).unwrap();
    });
    bench.report("Other split, conversations (50)", 200, OTHER_LIST, || {
        store.list_threads(&ListTarget::Role("bulk".into()), None, 50).unwrap();
    });
    bench.report("split unread counts", 100, NONE, || {
        store.split_unread().unwrap();
    });
    bench.report("search one word", 100, SEARCH, || {
        store.search("invoice", 100).unwrap();
    });
    bench.report("search a rare word", 100, SEARCH, || {
        store.search("4999", 100).unwrap();
    });
    bench.report("search two prefixes", 100, SEARCH, || {
        store.search("inv bud", 100).unwrap();
    });
    bench.report("search with filters", 100, SEARCH, || {
        store.search("inv is:unread in:inbox", 100).unwrap();
    });
    bench.report("conversation page (50)", 200, LIST, || {
        store.list_threads(&target, None, 50).unwrap();
    });
    let mut cursor = None;
    for _ in 0..100 {
        let page = store.list_threads(&target, cursor, 50)?;
        cursor = page.last().map(|t| Cursor { date: t.latest.date, id: t.latest.id });
    }
    bench.report("conversation page 101 (50)", 200, LIST, || {
        store.list_threads(&target, cursor, 50).unwrap();
    });
    let biggest = store.list_threads(&target, None, 500)?.into_iter().max_by_key(|t| t.count).unwrap();
    println!("largest conversation in the first 500: {} messages", biggest.count);
    bench.report("open conversation", 200, OPEN, || {
        store.thread(biggest.latest.id).unwrap();
    });
    bench.report("autocomplete \"s\" (5)", 200, NONE, || {
        store.contacts("s", 5).unwrap();
    });
    bench.report("autocomplete \"sender 4\" (5)", 200, NONE, || {
        store.contacts("sender 4", 5).unwrap();
    });
    bench.report("folders + unread counts", 100, NONE, || {
        store.folders().unwrap();
    });
    bench.report("archive 50 + undo", 50, ARCHIVE, || {
        let ids: Vec<i64> = store.list(&target, None, 50).unwrap().iter().map(|r| r.id).collect();
        let applied = store.apply(&ids, Action::Archive, 5).unwrap();
        store.undo(&applied.token).unwrap();
    });
    bench.report("download progress", 100, NONE, || {
        store.sync_progress().unwrap();
    });
    if !bench.missed.is_empty() {
        anyhow::bail!("missed {} target(s): {}", bench.missed.len(), bench.missed.join(", "));
    }
    println!("every target met");
    Ok(())
}

struct Bench {
    slack: f64,
    missed: Vec<String>,
}

impl Bench {
    fn report(&mut self, name: &str, runs: usize, target: Option<f64>, mut f: impl FnMut()) {
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
        let median = ms(times[runs / 2]);
        let verdict = match target.map(|t| t * self.slack) {
            Some(limit) if median > limit => {
                self.missed.push(name.to_string());
                format!("MISSED (< {limit} ms)")
            }
            Some(limit) => format!("ok (< {limit} ms)"),
            None => String::new(),
        };
        println!(
            "{name:<36} median {median:>8.3} ms   p95 {:>8.3} ms   {verdict}",
            ms(times[runs * 95 / 100])
        );
    }
}
