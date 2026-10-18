# Sprint 6 — Search and speed

**Status:** in progress (sync/search progress slice) · started 2026-10-15

## Delivery scope

**M1 search basics; M2 scale/refinement.** Local search and honest coverage indicators belong in the alpha. Advanced operators, optimizations and warm-cache startup are separate slices. Measure first useful page separately from complete backfill, and engine latency separately from visible response; the roadmap performance section controls release evidence.

Package number is a stable ID, not a delivery week. [PLAN.md](../PLAN.md) defines order and release gates.

## Overview

Make the speed table true at 100,000 messages, and make search the fastest way to get anywhere.

## Goal

Aim for local engine search under 10 ms at 100k messages; record end-to-end response and packaged
cold-start separately. Measure first useful page and full backfill separately with provider-specific
limits; no universal 100k-message/60-second full-sync guarantee. Cached interactions do not wait on network.

## Tasks

### Test mailbox
- [x] `examples/gen_mailbox.rs`: generate 100,000 realistic messages (Zipfian senders, threads, 20 % HTML, attachments) straight into a store file. Use it in `store_bench` and in the UI dev mode (`TERN_DB=path`).
- [x] `store_bench` prints a table and exits non-zero if any target is missed (so it can run in CI later).

### Search
- [x] Query language → FTS5 + SQL: free text (FTS, prefix on the last token), `from:`, `to:`, `cc:`, `subject:`, `has:attachment`, `is:unread|starred|snoozed`, `in:inbox|archive|sent|drafts|trash|spam|<label>`, `label:`, `before:`/`after:`/`newer_than:7d`, `larger:`/`smaller:`, quoted phrases, `-` negation, `OR`.
- [ ] Results as you type; `↓` enters the results; `Enter` opens; `Esc` back to the query. Search is a split-like view, so `e`/`s`/`#` work on results.
- [ ] Highlight matches using stored source text and a tested strategy; contentless FTS cannot reconstruct body snippets by itself. Use external-content FTS or stored text/offsets if needed; measure before changing the index.
- [ ] Suggestions row: contacts matching the token, labels matching, "Search Gmail for …" when the account is Gmail.
- [ ] FTS: index `to_addrs` and `cc` too; add a `trigram` secondary index? Measure first; only if prefix search on body is too slow.

### Body download policy
- [ ] Setting: full bodies for the last `30 | 90 | 365 | all` days; everything else headers + snippet. Default 90.
- [ ] Opening an unsynced body: fetch, show a skeleton for up to 300 ms, then a spinner. Cache forever once fetched.
- [ ] FTS of bodies covers only what is downloaded; the search UI says so when results might be partial, with "Search on server". (The note now gives the numbers; "Search on server" is not built.)
- [ ] Attachment bytes are never fetched until opened or forwarded.

### Store
- [ ] `PRAGMA journal_mode=WAL, synchronous=NORMAL, mmap_size=256MB, cache_size=-64000, temp_store=MEMORY`; one writer connection, a pool of readers so list queries never wait on a sync write.
- [ ] Prepared statement cache (`rusqlite::CachedStatement`) for the hot queries.
- [ ] Covering indexes for the thread list per split and for `message_labels` lookups; `EXPLAIN QUERY PLAN` checked into `docs/research/data-model.md` for the five hot queries.
- [ ] Vacuum/optimize on idle once a week (`PRAGMA optimize`).

### UI
- [ ] Startup: render the list from the first page before any IPC completes (persist the first page as JSON in `localStorage` as a warm cache; replace once SQLite answers).
- [ ] Virtual list: measure and keep steady 60 fps while holding `j`; batch signal updates with `batch()`.
- [ ] IPC: coalesce events from the sync worker (`messages-changed` at most every 100 ms with a list of thread ids), the UI patches rows in place instead of refetching the page.
- [ ] Images in HTML mail decoded off the main thread by the iframe; cap iframe height growth to avoid layout storms.

### Instrumentation
- [ ] `tracing` in Rust with a `TERN_LOG` filter; spans for sync phases with durations in the log.
- [ ] Perf overlay from Sprint 2 shows p50/p95 of the last 100 keypress → paint.

## Cut first
Trigram index, warm-cache startup (keep if it is under a day).

## Acceptance
- Generated 100k mailbox: every row of the speed table green on the Omarchy machine, numbers recorded here.
- Typing `from:ali has:att` renders results between keystrokes without visible lag.
- `cargo run --example store_bench` exits 0.

## Decisions

- 2026-10-15 — **Common words read the newest mail first.** A word in most of the mailbox matched about 48,000 of
  50,000 messages, and joining and sorting them all by date took 73 ms; reading the matching ids alone took 8.
  Schema v17 adds a date index (`messages_date`). Search takes the newest messages that pass the filters (200
  first), asks FTS5 only for matches in their id range (`rowid BETWEEN`, which skips the rest of the index),
  and stops when it has enough; the window grows by the hit rate it saw. Mail arrives in batches, so the newest
  messages sit in a narrow id range; when they do not, it is as slow as before, not wrong. Below one hit in eight
  it falls back to sorting the matches, which are few then. A test compares the results with the old query on
  mail whose dates are scrambled against arrival.

- 2026-10-18 — **Sync/search progress slice selected by the owner** (M2: "accurate partial-search/sync progress").
  In it: download progress in the status strip, numbers in the search note, the 100k generator, `store_bench`
  with targets and an exit code, and a CI step. Not in it: "Search on server", the body-download setting.
- 2026-10-18 — **Progress counts against the server's own numbers.** Each SELECT stores the folder's EXISTS
  (schema v18, `folders.server_count`); `Store::sync_progress` compares it with the rows here per account, and
  counts the rows with their text for the search note. The worker now reports "syncing" until a backfill pass
  says there is nothing more, and the strip shows "Downloading mail: X of Y" only for syncing accounts missing at
  least 100 messages: a few new messages are not a download, and a message the parser can't read (it stays
  missing) must not keep the sentence up forever. Folders not checked yet add "…".
- 2026-10-18 — **Conversation lists fill in a page at a time.** At 100k messages the conversation pages missed
  the 1 ms list target (1.08–1.17 ms): three small queries per conversation (counts, senders, snooze). They are
  now two queries per page (`json_each` over the page's conversations), 0.6–0.8 ms. The "shown on an earlier
  page" check stays per row, since it decides which rows count.
- 2026-10-18 — **Other has a 5 ms target for now (measured 2.25 ms).** It scans inbox rows and keeps the ~1 in 12
  that are bulk mail or from senders moved there, with a sender lookup per row. A partial index on bulk mail
  can't serve it alone, because moving a sender overrides `bulk` both ways; the fix is a rewrite of the split
  filter, worth its own slice. **Owner (2026-10-18): keep 5 ms.**
- 2026-10-18 — **CI runs `store_bench` with targets ×3** (`TERN_BENCH_SLACK=3`, Linux only). The first CI run was
  about twice as fast as the laptop (Other 1.1 ms, conversation pages 0.3–0.45 ms), but shared runners vary from
  run to run, so the step catches regressions of several times, not fractions. The reference evidence is the run
  on the Omarchy machine (Results).

## Log

- 2026-10-15 — M1 search slice. `query.rs` parses the box: words as FTS5 prefixes, `"phrases"`, `OR`, `-` to
  leave out, and the filters `from: to: cc: subject:` (`me` = the account), `is: has:attachment in:/label:
  before: after: newer_than: older_than: larger: smaller:`; anything else is searched as text. Results say when
  mail without its text was searched by headers only (shown under the box). Empty results list the filters.
  Not done: `is:snoozed` (no snooze yet), suggestions, highlighting, server search. `store_bench` at 50,000:
  "search with filters" 10.8 ms median; plain-word search is still about 73 ms, as recorded in package 00
  (the M2 speed work). UI tried in `npm run dev` against the fake mailbox (words only there).
- 2026-10-15 — Plain-word search (see Decisions). `store_bench` at 50,000, before → after: one word 73 → 2.5 ms,
  two prefixes about 80 → 5.3 ms, a rare word 0.07 ms, words with filters 1.4 → 2.9 ms (the filter line now
  finds mail; it searched an empty date range before). Most of what is left is FTS5 reading a prefix term's
  whole list; a `prefix=` index could cut it but means rebuilding the index, so it waits for a measured need.
  Not measured at 100,000 yet (the generator task).
- 2026-10-18 — Sync/search progress slice. Engine: schema v18 (`server_count`), `Store::sync_progress` (test),
  migration test, "syncing" kept through a backfill; `list_threads` batched (existing list tests pass).
  `examples/common/mailbox.rs` generates a realistic mailbox (three folders, Zipf senders, newsletters, threads,
  HTML, attachments, headers-only old mail); `gen_mailbox PATH [N]` writes one (`TERN_DB=PATH` opens it in the
  app); `store_bench` uses 100k by default, prints a target per row and exits non-zero on a miss. UI: "Downloading
  mail: X of Y" and the search note's numbers, tried in `npm run dev` (`#backfill`) in headless Chromium. Not tried
  in the Tauri window against a real backfill yet.

## Results

`store_bench`, 100,000 generated messages, release build, Omarchy laptop (2026-10-18). Medians, ms:

| Row | Median | Target |
|---|---|---|
| first page (100 rows) | 0.16 | < 1 |
| page 250 (100 rows) | 0.14 | < 1 |
| unified inbox page | 0.26 | < 1 |
| unified inbox, conversations (50) | 0.77 | < 1 |
| Important split, conversations (50) | 0.84 | < 1 |
| Other split, conversations (50) | 2.25 | < 5 (see Decisions) |
| conversation page (50) / page 101 | 0.60 / 0.78 | < 1 |
| search: one word / rare / two prefixes / filters | 2.7 / 0.15 / 4.5 / 3.5 | < 10 |
| open conversation | 0.04 | < 50 |
| archive 50 + undo | 2.2 | < 20 |
| split unread counts | 8.9 | — |
| download progress | 5.8 | — (read at most once a second) |
