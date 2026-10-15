# Sprint 6 — Search and speed

**Status:** in progress · started 2026-10-15

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
- [ ] `examples/gen_mailbox.rs`: generate 100,000 realistic messages (Zipfian senders, threads, 20 % HTML, attachments) straight into a store file. Use it in `store_bench` and in the UI dev mode (`TERN_DB=path`).
- [ ] `store_bench` prints a table and exits non-zero if any target is missed (so it can run in CI later).

### Search
- [x] Query language → FTS5 + SQL: free text (FTS, prefix on the last token), `from:`, `to:`, `cc:`, `subject:`, `has:attachment`, `is:unread|starred|snoozed`, `in:inbox|archive|sent|drafts|trash|spam|<label>`, `label:`, `before:`/`after:`/`newer_than:7d`, `larger:`/`smaller:`, quoted phrases, `-` negation, `OR`.
- [ ] Results as you type; `↓` enters the results; `Enter` opens; `Esc` back to the query. Search is a split-like view, so `e`/`s`/`#` work on results.
- [ ] Highlight matches using stored source text and a tested strategy; contentless FTS cannot reconstruct body snippets by itself. Use external-content FTS or stored text/offsets if needed; measure before changing the index.
- [ ] Suggestions row: contacts matching the token, labels matching, "Search Gmail for …" when the account is Gmail.
- [ ] FTS: index `to_addrs` and `cc` too; add a `trigram` secondary index? Measure first; only if prefix search on body is too slow.

### Body download policy
- [ ] Setting: full bodies for the last `30 | 90 | 365 | all` days; everything else headers + snippet. Default 90.
- [ ] Opening an unsynced body: fetch, show a skeleton for up to 300 ms, then a spinner. Cache forever once fetched.
- [ ] FTS of bodies covers only what is downloaded; the search UI says so when results might be partial, with "Search on server".
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

_None yet._

## Log

- 2026-10-15 — M1 search slice. `query.rs` parses the box: words as FTS5 prefixes, `"phrases"`, `OR`, `-` to
  leave out, and the filters `from: to: cc: subject:` (`me` = the account), `is: has:attachment in:/label:
  before: after: newer_than: older_than: larger: smaller:`; anything else is searched as text. Results say when
  mail without its text was searched by headers only (shown under the box). Empty results list the filters.
  Not done: `is:snoozed` (no snooze yet), suggestions, highlighting, server search. `store_bench` at 50,000:
  "search with filters" 10.8 ms median; plain-word search is still about 73 ms, as recorded in package 00
  (the M2 speed work). UI tried in `npm run dev` against the fake mailbox (words only there).
