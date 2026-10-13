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
- [ ] Move to `rustls`: `tokio-rustls` + `rustls-platform-verifier` for IMAP; `lettre` features `tokio1-rustls-tls` (drop `native-tls`). No OpenSSL anywhere; `cargo tree | grep -i openssl` must be empty.
- [ ] STARTTLS on 143 and 587 as a preset option; prefer implicit TLS (993/465) by default.
- [ ] Send `ID ("name" "Tern" "version" ... "contact" ...)` after login where `ID` is advertised (Gmail asks for it).

### Connections
- [ ] Two connections per account: one **idle** connection parked on the Inbox, one **worker** for everything else.
      The idle connection only ever does `SELECT INBOX`, `IDLE`, `DONE`, `NOOP`.
- [ ] Reconnect with exponential backoff (1 s → 60 s cap, jitter). Surface state to the UI via a `sync-state` event: `connecting | idle | syncing | offline | auth-failed`.
- [ ] Re-issue `IDLE` every 25 minutes; servers drop at 30.
- [ ] Wake on resume from sleep: on Linux listen to `org.freedesktop.login1.Manager.PrepareForSleep` over D-Bus (`zbus`), or fall back to detecting a clock jump > 60 s.

### Incremental sync
- [ ] `ENABLE CONDSTORE QRESYNC` when advertised. Store `highest_modseq` per folder (column exists).
- [ ] Folder check = `SELECT (QRESYNC ...)` → apply `VANISHED` + changed flags from the response; fall back to
      `UID SEARCH MODSEQ n` on CONDSTORE-only servers; fall back to `UID FETCH 1:* (FLAGS)` in batches of 5,000 on plain servers.
- [ ] `UIDVALIDITY` change: drop the folder's rows (respecting `pending_uids`) and resync.
- [ ] Interval for non-inbox folders: 5 minutes, or on demand when the user opens the folder.

### Headers first, bodies later
- [ ] Phase A: `UID FETCH <new> (UID FLAGS INTERNALDATE RFC822.SIZE BODY.PEEK[HEADER.FIELDS (FROM TO CC DATE SUBJECT MESSAGE-ID IN-REPLY-TO REFERENCES LIST-UNSUBSCRIBE LIST-ID)] BODYSTRUCTURE)`
      in batches by count and size (`by_size` exists). Insert rows with `has_attachments` from `BODYSTRUCTURE`
      and an empty snippet.
- [ ] Phase B: fetch the text part only (from `BODYSTRUCTURE`, prefer `text/plain`, else `text/html`) for the
      snippet, newest first, 200 at a time.
- [ ] Phase C: full bodies for the last 90 days (configurable), newest first, low priority, pausable when the user is active.
- [ ] On demand: opening a message without a body fetches it immediately on the worker connection and emits `body-ready`.
- [ ] Store `size`, `bodystructure` (JSON) and `body_state` (`none | snippet | full`) on `messages`. Schema migration v2 (see `docs/research/data-model.md`).

### Conversations
- [ ] `threads` table: `id, account_id, subject_norm, last_date, first_date, message_count, unread_count, flagged, participants (JSON), snippet, labels (JSON cache)`.
- [ ] Threading: by `References` / `In-Reply-To` chain → existing thread; else by normalised subject
      (strip `Re:`, `Fwd:`, `[list]`) within 7 days and overlapping participants; else new thread.
- [ ] Gmail: when `X-GM-THRID` is present it is the thread key, no heuristics.
- [ ] Keep `threads` in sync via store methods (not triggers) so the counts are right when a row moves or flips `seen`.
- [ ] `store_bench`: add "thread list page" and "thread open" timings.

### Outbox
- [ ] `MOVE` (RFC 6851) when advertised, else `COPY` + `STORE \Deleted` + targeted `UID EXPUNGE` when supported. Without UIDPLUS, choose a conservative fallback; never globally EXPUNGE unrelated deleted mail.
- [ ] Validate mailbox identity/UIDVALIDITY before queued mutations; reconcile stale IDs. Preserve dependencies for actions on messages with pending moves.
- [ ] Persist send identity/MIME and distinguish confirmed, failed and unknown outcomes; stable Message-ID alone does not make SMTP exactly-once.
- [ ] `APPEND` sent mail to the Sent folder when the server does not copy it (detect via the preset / a one-time check).
- [ ] Retry policy: 5 attempts with backoff, then surface in a "Sync problems" list in the UI; never drop silently.

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
