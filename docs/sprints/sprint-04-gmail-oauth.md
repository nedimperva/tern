# Sprint 4 — Gmail OAuth and selected transport

**Status:** in progress (OAuth core and Gmail probe; Gmail backend waits on the owner setup) · started 2026-10-19

## Delivery scope

**M0 comparison/preparation; M2 one selected Gmail backend.** The common OAuth/UI/label-model tasks apply to either transport. XOAUTH2, X-GM operations and X-GM-RAW search apply only if the owner selects IMAP in the early Gmail gate. If API is selected, use the API slice of package 12 instead; do not implement both Gmail paths. See [the decision checklist](../research/gmail-backend-decision.md).

Package number is a stable ID, not a delivery week. [PLAN.md](../PLAN.md) defines order and release gates.

## Overview

"Sign in with Google" instead of app passwords, and a Gmail account that behaves like Gmail:
labels, Gmail's own threads, Gmail search syntax, archive that means "remove from Inbox".

Prerequisite from the owner: a Gmail test account and a Google Cloud project with an OAuth **Desktop app**
client. Step-by-step in `docs/research/gmail-oauth.md`. The client ID (and the non-secret "secret") are
committed to the repo in `crates/tern-core/src/oauth/google.rs`; this is normal for desktop clients.

## Goal

Add a Gmail account in three clicks (browser consent), inbox syncs with labels, archiving in Tern archives
in Gmail, labelling in Gmail shows in Tern, a search like `from:alice has:attachment newer_than:7d` works.

## Tasks

### OAuth engine (`tern-core::oauth`)
- [x] `oauth2` crate, authorization code + PKCE (S256). Loopback redirect: bind `127.0.0.1:0` with a tiny
      `tokio` HTTP listener (no framework; read the first line, reply with a "You can close this tab" page,
      shut down). State parameter checked.
- [ ] Open the system browser with `tauri-plugin-opener`. Time out after 5 minutes.
- [x] Tokens (refresh + access + expiry) in the keyring as JSON under `tern-mail/<email>/oauth`. Never in SQLite.
- [ ] Refresh 5 minutes before expiry, on demand when a server rejects a token, and once at startup. One refresh in flight per account.
- [ ] `invalid_grant` (user revoked) → account state `auth-failed`, UI banner with "Sign in again".
- [x] Provider table: `google` now; `microsoft` in Sprint 11. Each has `auth_url`, `token_url`, `scopes`, `client_id`, `client_secret?`.

### XOAUTH2 (IMAP choice only)
- [ ] SASL initial response `base64("user=" email "\x01auth=Bearer " token "\x01\x01")` for IMAP `AUTHENTICATE XOAUTH2` and SMTP `AUTH XOAUTH2`.
- [ ] Parse the base64 JSON error challenge on failure (`status 400/401`) and map to refresh-and-retry once, then `auth-failed`.
- [ ] Account `auth_kind` column: `password | oauth`. `secrets.rs` gets `get_credential(account) -> Password | AccessToken`.

### Account setup UI
- [ ] Email entry → preset lookup → for Gmail/Google Workspace show "Continue with Google"; for others the password form as today.
- [ ] Progress states: waiting for browser → exchanging → checking selected backend → syncing first page → background backfill. Cancel at every step.
- [ ] Error copy for the usual cases: unverified app warning (link to "Advanced → Go to Tern"), test-user missing, IMAP disabled in Gmail settings.

### Labels model (shared identity/membership; transport-specific operations below)
- [ ] Tables `labels (id, account_id, name, role, color, sort)` and `message_labels (message_id, label_id)`.
      Use the next available migration version. Preserve stable local message identity and per-folder remote locations; Gmail membership is many-to-many. Do not assume RFC Message-ID is a universal remote key.
- [ ] Gmail: `[Gmail]/All Mail` is the source of truth. Sync **All Mail** for messages and `X-GM-LABELS` for membership;
      do not sync the other `[Gmail]/*` folders as folders. `\Inbox`, `\Starred`, `\Important`, `\Sent`, `\Draft`, `\Trash`, `\Spam` map to roles.
- [ ] `X-GM-THRID` as the thread key; `X-GM-MSGID` stored for deep links (`https://mail.google.com/mail/u/0/#all/<hex>`).
- [ ] Actions on Gmail become label ops: archive = `-X-GM-LABELS (\Inbox)`, star = `\Flagged`, trash = `COPY` to Trash (Gmail semantics), label = `+X-GM-LABELS (name)`.
- [ ] Trash and Spam are real folders in Gmail; sync them separately for `g #` / `g !`.
- [ ] Label chips on rows and in the pane; `l` opens the label picker (palette in argument mode); `Cmd+Shift+L`... see key table.

### Gmail search (X-GM-RAW for IMAP; API q= when API selected)
- [ ] Local FTS first (instant). When the query uses Gmail operators the FTS cannot answer (`older_than:`, `label:`, `is:important`, `category:`) or the user presses `Enter` on "Search Gmail", send `UID SEARCH X-GM-RAW "<query>"` on All Mail, fetch headers for unknown UIDs, show results.
- [ ] Results view shows which were local and which came from the server.

### Presets
- [ ] `gmail.com`, `googlemail.com` → `imap.gmail.com:993`, `smtp.gmail.com:465`, oauth=google, `gmail_ext=true`.
- [ ] Google Workspace detection: MX lookup for `aspmx.l.google.com` (via `hickory-resolver`) → same preset.
- [ ] Preset flags: `copies_sent`, `has_archive_folder`, `supports_move`, `supports_qresync`, `is_gmail`.

### Multi-account
- [ ] Unified "All Inboxes" (`g i` when more than one account) using a `UNION ALL` over threads with a per-account colour dot.
- [ ] `Cmd+1..9` switch account scope; palette "Switch account".

## Cut first
Workspace MX detection and Gmail deep links. Preserve partial-result/sync-coverage indicators.

## Acceptance
- Add a Gmail account via the browser; no password typed into Tern.
- Archive in Tern → gone from Gmail's Inbox, still in All Mail. Label changes converge within the selected backend's documented reconciliation interval; do not assume every label change triggers inbox IDLE.
- Threads in Tern match Gmail's grouping for 20 random conversations.
- Revoke access at myaccount.google.com → Tern shows "Sign in again" within one sync cycle, no crash, no data loss.
- Token refresh observed in the log after an hour of running.

## Decisions

- 2026-10-19 — **Owner chose Gmail sign-in as the next M2 slice.** The owner setup (test account, Cloud project,
  desktop client; [Gmail test setup](../research/gmail-test-setup.md)) is not done yet, so this slice builds what
  needs no credentials: the OAuth core and the probe that collects the decision evidence the moment the client file
  exists. The Gmail backend itself waits for the confirmed decision.
- 2026-10-19 — **No `oauth2` crate.** Planned: the `oauth2` crate. Built: `tern_core::oauth`, about 250 lines:
  PKCE from `ring` (already here through rustls), the authorize URL with `url`, a one-request listener on
  `127.0.0.1:0` in tokio, and the token calls through `ureq` on the same rustls and platform verifier as the rest
  of Tern. The crate would bring its own HTTP client and TLS choice for two POSTs. `invalid_grant` is its own error
  (`oauth::Revoked`), so "sign in again" can be told apart from a network failure.
- 2026-10-19 — **The probe measures the API side only.** The IMAP side is already known in part: io-imap drops
  every FETCH that carries X-GM-* items (package 01 probe, docs/research/stack.md), so Gmail over IMAP in Tern is
  plain IMAP without native labels or threads; the owner's app-password Gmail account shows its sync speed. Building
  XOAUTH2 just to measure that path is not worth it. The probe asks only for `gmail.modify`, `openid` and `email`.

## Log

- 2026-10-19 — OAuth core: `tern_core::oauth` (provider table with Google, PKCE, authorize URL, loopback listener
  with state check and 5-minute limit, code exchange and refresh, ID-token email, `Revoked`) with tests against the
  RFC 7636 vector, a real listener and a fake token server; `secrets::set_tokens/tokens` (`<email>/oauth` in the
  keyring). `examples/gmail_probe.rs` signs in through the browser and prints the API half of the comparison as a
  table (mailbox size, labels, first screen of 100 inbox messages, history.list, quota used, full-backfill
  estimate). Not run yet: it needs `secrets/google-client.json`. Not wired into the app: sign-in UI, refresh
  scheduling, `auth-failed` banner (they follow the decision).
