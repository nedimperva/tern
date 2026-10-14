# Sprint 1 — Sync engine v2

**Status:** in progress · started 2026-10-13

## Delivery scope

**M0 safety; M1 reliable sync; later optimizations.** Split this package into small PRs: (1) transport probe and correctness/recovery tests, (2) reliable incremental sync/IDLE and headers-first first page, (3) conversations, (4) measured QRESYNC/prefetch optimizations. No requirement to finish every optimization before the alpha. Safety and recovery checks are never deferred for speed.

Package number is a stable ID, not a delivery week. [PLAN.md](../PLAN.md) defines order and release gates.

## Overview

New mail within two seconds, cheap re-checks, headers before bodies, real conversations.

## Goal

On a representative 50,000-message Fastmail account, aim to show the first useful page (100 newest
headers/snippets) within 10 seconds on the recorded test connection. Backfill progresses separately with
visible state; this is not a complete-mailbox time guarantee. New mail appears via IDLE. Measure cheap
unchanged-folder checks where capabilities permit. Group messages into conversations in the store.

## Decision gate (early probe): IMAP library

Time-box one day. Build a tiny probe binary (`crates/tern-core/examples/imap_probe.rs`) that connects to
Fastmail (and later Gmail) and tries, with each candidate:

1. `IDLE` with a 29-minute re-issue and a clean `DONE` on demand.
2. `ENABLE QRESYNC`, `SELECT ... (QRESYNC (uidvalidity modseq))`, parse `VANISHED (EARLIER)` and `FETCH ... MODSEQ`.
3. `UID FETCH ... (FLAGS X-GM-LABELS X-GM-THRID X-GM-MSGID)` parsing — Gmail-only, but the parser must not choke.
4. `AUTHENTICATE XOAUTH2` with a SASL initial response.
5. `STARTTLS` on 143.

Candidates:
- **`async-imap` 0.11** (current). Pros: already integrated, `idle()` exists, `run_command_and_read_response`
  for raw commands. Cons: `imap-proto` may not parse `MODSEQ`/`X-GM-*` FETCH items; `VANISHED` is likely unparsed.
- **`imap-next` 0.3 + `imap-client`** (duesee/soywod, NLnet-funded). Pros: sans-I/O, `ext_condstore_qresync`,
  `starttls`, `ext_id` features; `imap-types` is complete and misuse-resistant. Cons: new API surface to
  learn; `X-GM-*` are Gmail-proprietary and may need a fallback parser either way.

Decide by: whichever passes 1, 2, 4 with the least custom parsing. If both need a custom parser for Gmail
items, prefer the one with QRESYNC support built in. Record the decision and probe output in `docs/research/stack.md`.

## Tasks

### TLS and transport
- [x] Move to `rustls`: `tokio-rustls` + `rustls-platform-verifier` for IMAP; `lettre` features `tokio1-rustls-tls` (drop `native-tls`). No OpenSSL anywhere; `cargo tree | grep -i openssl` must be empty.
      Done 2026-10-13: lettre uses `tokio1-rustls` + `ring` + `rustls-platform-verifier`; nothing links OpenSSL
      (`cargo tree -i openssl-sys` is empty). The grep still shows `openssl-probe`, a pure-Rust crate the platform
      verifier uses to find certificate files; it is not OpenSSL.
- [x] STARTTLS on 143 and 587 as a preset option; prefer implicit TLS (993/465) by default.
- [x] Send `ID ("name" "Tern" "version" ... "contact" ...)` after login where `ID` is advertised (Gmail asks for it).
      Done: name, version and support-url; a refusal is only logged.

### Connections
- [x] Two connections per account: one **idle** connection parked on the Inbox, one **worker** for everything else.
      The idle connection only ever does `SELECT INBOX`, `IDLE`, `DONE`, `NOOP`.
- [x] Reconnect with exponential backoff (1 s → 60 s cap, jitter). Surface state to the UI via a `sync-state` event: `connecting | idle | syncing | offline | auth-failed`.
      Done: a refused sign-in waits 30 min or until the window gets focus (any focus wakes every account).
- [x] Re-issue `IDLE` every 25 minutes; servers drop at 30.
- [x] Wake on resume from sleep: on Linux listen to `org.freedesktop.login1.Manager.PrepareForSleep` over D-Bus (`zbus`), or fall back to detecting a clock jump > 60 s.
      Done with the clock jump only (works on Windows too): > 30 s unaccounted for in a 10 s tick drops both
      connections and syncs at once. D-Bus cut, as the Cut-first list allows. Not yet tried across a real suspend.

### Incremental sync
- [x] `ENABLE CONDSTORE QRESYNC` when advertised. Store `highest_modseq` per folder (column exists).
- [ ] Folder check = `SELECT (QRESYNC ...)` → apply `VANISHED` + changed flags from the response; fall back to
      `UID SEARCH MODSEQ n` on CONDSTORE-only servers; fall back to `UID FETCH 1:* (FLAGS)` in batches of 5,000 on plain servers.
- [x] `UIDVALIDITY` change: drop the folder's rows (respecting `pending_uids`) and resync.
      Done in the reliability gate (#17): rows queued work points at stay with their uid cleared; sync claims
      them back by Message-ID.
- [ ] Interval for non-inbox folders: 5 minutes, or on demand when the user opens the folder.

### Headers first, bodies later
- [ ] Phase A: `UID FETCH <new> (UID FLAGS INTERNALDATE RFC822.SIZE BODY.PEEK[HEADER.FIELDS (FROM TO CC DATE SUBJECT MESSAGE-ID IN-REPLY-TO REFERENCES LIST-UNSUBSCRIBE LIST-ID)] BODYSTRUCTURE)`
      in batches by count and size (`by_size` exists). Insert rows with `has_attachments` from `BODYSTRUCTURE`
      and an empty snippet.
- [ ] Phase B: fetch the text part only (from `BODYSTRUCTURE`, prefer `text/plain`, else `text/html`) for the
      snippet, newest first, 200 at a time.
- [ ] Phase C: full bodies for the last 90 days (configurable), newest first, low priority, pausable when the user is active.
- [x] On demand: opening a message without a body fetches it immediately on the worker connection and emits `body-ready`.
      Done as: the `thread` command marks it `wanted` and wakes the worker, which fetches wanted bodies first;
      the existing `mail-changed` event reloads the open thread (no separate `body-ready`).
- [ ] Store `size`, `bodystructure` (JSON) and `body_state` (`none | snippet | full`) on `messages`. Schema migration v2 (see `docs/research/data-model.md`).

### Conversations
- [ ] `threads` table: `id, account_id, subject_norm, last_date, first_date, message_count, unread_count, flagged, participants (JSON), snippet, labels (JSON cache)`.
- [ ] Threading: by `References` / `In-Reply-To` chain → existing thread; else by normalised subject
      (strip `Re:`, `Fwd:`, `[list]`) within 7 days and overlapping participants; else new thread.
- [ ] Gmail: when `X-GM-THRID` is present it is the thread key, no heuristics.
- [ ] Keep `threads` in sync via store methods (not triggers) so the counts are right when a row moves or flips `seen`.
- [ ] `store_bench`: add "thread list page" and "thread open" timings.

### Outbox
- [x] `MOVE` (RFC 6851) when advertised, else `COPY` + `STORE \Deleted` + targeted `UID EXPUNGE` when supported. Without UIDPLUS, choose a conservative fallback; never globally EXPUNGE unrelated deleted mail.
- [x] Validate mailbox identity/UIDVALIDITY before queued mutations; reconcile stale IDs. Preserve dependencies for actions on messages with pending moves.
      Done in #17: ops carry UIDVALIDITY and `waiting` rows; Message-ID lookup and COPYUID fill them in.
- [x] Persist send identity/MIME and distinguish confirmed, failed and unknown outcomes; stable Message-ID alone does not make SMTP exactly-once.
      Done in #17: the Message-ID is fixed when queued and kept across tries (the MIME is rebuilt from the stored
      draft, so only its Date changes); unknown outcomes become "may have been sent" problems.
- [ ] `APPEND` sent mail to the Sent folder when the server does not copy it (detect via the preset / a one-time check).
- [x] Retry policy: 5 attempts with backoff, then surface in a "Sync problems" list in the UI; never drop silently.

## Cut first
Sleep/resume via D-Bus (keep the clock-jump fallback), then Phase C body prefetch (keep on-demand).

## Acceptance
- A fresh Fastmail account shows the first useful page (100 newest headers/snippets) within the measured 10 s target; complete-backfill timing is recorded separately.
- Send yourself a message: it appears in the list in under 2 s without touching anything.
- Toggle a flag in Fastmail's web UI: Tern reflects it within the IDLE notification (inbox) or 5 minutes (other folders).
- `store_bench` thread-list page < 1 ms, thread open < 50 ms at 50,000 messages.
- `cargo tree` shows no `openssl-sys`.

## Decisions

- 2026-10-13 — **Carried from package 00:** the async-imap upgrade (0.10 → current; 0.12 is out) and replacing
  the `Debug`-text folder-role parsing in `sync.rs` with a match on the library's attribute type. Owner moved both
  here so the IMAP library gate decides the version or the replacement first.
- 2026-10-13 — **Decision gate: IMAP library.** Candidates changed since the plan: `imap-client` is archived
  (moved to `io-imap`); owner chose to probe `async-imap` 0.12 against `io-imap` 0.7. Evidence and table:
  `docs/research/stack.md` → "IMAP library probe". Both pass at equal speed with `TCP_NODELAY`. Deciding
  differences: io-imap drops Gmail X-GM-* FETCHes silently; async-imap loses QRESYNC changes past 100 unless
  drained, and does not return COPYUID. Recommendation depends on the Gmail backend: API → io-imap, IMAP →
  async-imap. Owner decided (2026-10-13), **provisionally: io-imap**, together with the Gmail API for Gmail.
  Confirm when the Gmail comparison runs. Conditions: pin exact versions, keep the `nom/alloc` workaround, keep
  every io-imap call inside one engine module so a later swap touches one file, send fixes upstream.

## Log

- 2026-10-13 — IMAP library probe (`crates/imap-probe`) against the local Stalwart server and a scripted Gmail fake.
  Results in `docs/research/stack.md`. Found: Tern's sync sockets lack `TCP_NODELAY` (≈40 ms per command).
  Gate waiting on owner, together with the Gmail backend decision.
- 2026-10-13 — Engine moved to io-imap (`src/imap.rs`, the only file using it) over rustls; async-imap, async-native-tls
  and futures removed from tern-core. Sign-in picks PLAIN from advertised capabilities, else IMAP LOGIN (no more
  double attempts on a wrong password). Folder roles come from real special-use attributes (carried task done).
  Moves: MOVE, else COPY + \Deleted + UID EXPUNGE, and without UIDPLUS no expunge at all. Tests: 8 fake-server unit
  tests, 2 opt-in checks against the dev server (`scripts/dev-mail-server.sh test`), live sync verified (new mail
  and an outside flag change arrived within one 60 s poll). Open: lettre to rustls; then QRESYNC, IDLE, headers-first.
- 2026-10-13 — SMTP on rustls; OpenSSL gone from the build. Found: Tern infers SMTP security from the port (465 means
  implicit TLS, anything else STARTTLS), so the dev server's implicit-TLS port 1465 hangs (both sides wait). Dev
  server gained STARTTLS submission on 1587, used by the new real send check. Next slice: an explicit security
  setting per account for IMAP and SMTP (schema migration), which also brings IMAP STARTTLS.
- 2026-10-14 — Connection security stored per account (`imap_security`, `smtp_security`: tls or starttls), schema v2
  with the first real migration framework (`store::migrate`). Presets set it; the account form has two selects that
  follow the port (993/465 TLS, 143/587 STARTTLS). IMAP STARTTLS implemented, refusing bytes injected before TLS.
  Real-server checks: IMAP STARTTLS on 1143, SMTP over TLS on 1465 (the port-guessing case) and STARTTLS on 1587.
  UI checked by `npm run build` only; owner to look at the form in `tauri dev`.
- 2026-10-14 — Outbox failures no longer stall sync. Found live: a reply to a nonexistent seed address failed with
  SMTP 550 and aborted every pass, so new mail stopped. Now a refused item is recorded and the pass goes on; only a
  lost connection ends it (claimed work is released). Permanent refusals stop at once, others after 5 tries; given-up
  work waits in `Store::outbox_problems` (retry or discard, discard reverts like undo). Schema v3 (`gave_up_at`).
  Still open for the Retry-policy task: the "Sync problems" list in the UI (package 08, M1).
- 2026-10-14 — IDLE: a second connection per account (`watch_inbox`) idles on the inbox and wakes the worker on any
  change; re-issued every 25 min, reconnects with backoff, stops (polling stays) if the server has no IDLE. Measured
  on the dev server: new mail in Tern's database 16, 64 and 72 ms after SMTP accepted it (was up to 60 s). Tests:
  two fake-server IDLE cases, one real-server IDLE check. Open in "Connections": jittered 1 s → 60 s reconnect and
  the `sync-state` event; sleep/resume.
- 2026-10-14 — Headers first (schema v4: `messages.size`, `messages.body_state` none|wanted|full). New mail arrives as
  header fields + size + flags in 500-message FETCHes and shows at once (no snippet yet); bodies follow within the
  15 s budget, opened ones first, then the newest; mail older than 90 days gets its body only when opened. Done of
  Phase A: everything except LIST-* headers and BODYSTRUCTURE (the attachment marker appears with the body).
  Phase B (text part only) skipped for now: the body brings the snippet. Phase C: 90 days, not yet pausable.
  Found: io-imap drops a FETCH response it cannot parse without error; sync now warns when fewer came back.
- 2026-10-14 — QRESYNC: `ENABLE QRESYNC` per session; a folder synced before is opened with `SELECT … (QRESYNC (v m))`,
  which reports expunged UIDs (VANISHED) and changed flags in the same round trip. New mail is still found by UID
  SEARCH, but only when UIDNEXT moved; `folders.uid_next` is stored only once all new mail was fetched, so a capped
  pass cannot hide messages from the next. Live: all nine dev folders checked with one SELECT each when unchanged.
  Done of "Folder check": the QRESYNC path and the plain fallback (whole-folder flags, not yet 5,000-UID batches).
  Not done: the CONDSTORE-only path (`UID SEARCH MODSEQ`). UIDVALIDITY reset still drops pending rows too.
- 2026-10-14 — Sync problems in the UI: a strip under the list ("1 change didn't go through · Review") while any work
  is given up, and a dialog listing each with the server's reason, Retry and Discard; also in the command bar.
  Tauri commands `problems`, `retry_problem`, `discard_problem`. Checked with headless Chromium (light and dark) on
  the fake mailbox and in the real window, where the stuck 550 reply shows. Retry-policy task complete.
- 2026-10-14 — Reader fixes from the owner's Windows test. (1) The HTML frame flickered: every sync change reloaded
  the open thread as new objects, so each message's frame was rebuilt. The thread is now a store reconciled by id;
  checked in headless Chromium (starring the open message rebuilt the frame before, keeps it now). The reading pane
  also reserves its scrollbar gutter, so classic scrollbars cannot start a resize loop. (2) Plain-text mail showed in
  a white box in dark mode: mail-parser's `body_html` converts text to HTML. Only a real `text/html` part is stored
  as HTML now; schema v5 clears the generated HTML already stored (exact match only). Dev DB: 657 of 657 cleared.
  Noted from the same test: sending felt slow right after adding the account — not reproduced; to look at with the
  reliability work.
- 2026-10-14 — Connection state. `SyncState` (connecting, syncing, idle, offline, auth-failed) goes to the UI as a
  `sync-state` event and a `sync_states` command; the sidebar says "Offline", "Connecting…" or "Sign-in failed"
  next to the account. Reconnects wait 1 s → 60 s with jitter (were 10 s → 5 min); retries while offline stay
  quiet so the label does not flicker. Sleep is noticed by the clock. IMAP `ID` after sign-in. Live on the dev
  server: stopping it showed Offline within a second and backoff of 4, 6, 13, 25 s; starting it again synced 6 s
  later. Also, for the owner's slow first send on Windows: queued work is now sent between folders and stops body
  backfill, instead of waiting for a whole pass (up to 15 s of backfill plus every folder) to finish.
