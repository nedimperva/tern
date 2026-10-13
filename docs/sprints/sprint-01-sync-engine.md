# Sprint 1 — Sync engine v2

**Week 2.** New mail within two seconds, cheap re-checks, headers before bodies, real conversations.

## Goal

A mailbox with 50,000 messages fills its inbox list in under 10 seconds on a normal connection (headers +
snippets), bodies trickle in behind, new mail appears via IDLE, and re-checking an unchanged folder is one
round trip. Messages are grouped into conversations in the store.

## Decision gate (day 1–2): IMAP library

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
- [ ] `MOVE` (RFC 6851) when advertised, else `COPY` + `STORE \Deleted` + `UID EXPUNGE`.
- [ ] `APPEND` sent mail to the Sent folder when the server does not copy it (detect via the preset / a one-time check).
- [ ] Retry policy: 5 attempts with backoff, then surface in a "Sync problems" list in the UI; never drop silently.

## Cut first
Sleep/resume via D-Bus (keep the clock-jump fallback), then Phase C body prefetch (keep on-demand).

## Acceptance
- A fresh Fastmail account shows its inbox list within 10 s of login (headers + snippets), bodies arrive behind.
- Send yourself a message: it appears in the list in under 2 s without touching anything.
- Toggle a flag in Fastmail's web UI: Tern reflects it within the IDLE notification (inbox) or 5 minutes (other folders).
- `store_bench` thread-list page < 1 ms, thread open < 50 ms at 50,000 messages.
- `cargo tree` shows no `openssl-sys`.
