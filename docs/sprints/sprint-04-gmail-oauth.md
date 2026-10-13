# Sprint 4 — Gmail via IMAP + OAuth

**Week 5.** "Sign in with Google" instead of app passwords, and a Gmail account that behaves like Gmail:
labels, Gmail's own threads, Gmail search syntax, archive that means "remove from Inbox".

Prerequisite from the owner: a Gmail test account and a Google Cloud project with an OAuth **Desktop app**
client. Step-by-step in `docs/research/gmail-oauth.md`. The client ID (and the non-secret "secret") are
committed to the repo in `crates/tern-core/src/oauth/google.rs`; this is normal for desktop clients.

## Goal

Add a Gmail account in three clicks (browser consent), inbox syncs with labels, archiving in Tern archives
in Gmail, labelling in Gmail shows in Tern, a search like `from:alice has:attachment newer_than:7d` works.

## Tasks

### OAuth engine (`tern-core::oauth`)
- [ ] `oauth2` crate, authorization code + PKCE (S256). Loopback redirect: bind `127.0.0.1:0` with a tiny
      `tokio` HTTP listener (no framework; read the first line, reply with a "You can close this tab" page,
      shut down). State parameter checked.
- [ ] Open the system browser with `tauri-plugin-opener`. Time out after 5 minutes.
- [ ] Tokens (refresh + access + expiry) in the keyring as JSON under `tern-mail/<email>/oauth`. Never in SQLite.
- [ ] Refresh 5 minutes before expiry, on demand when a server rejects a token, and once at startup. One refresh in flight per account.
- [ ] `invalid_grant` (user revoked) → account state `auth-failed`, UI banner with "Sign in again".
- [ ] Provider table: `google` now; `microsoft` in Sprint 11. Each has `auth_url`, `token_url`, `scopes`, `client_id`, `client_secret?`.

### XOAUTH2
- [ ] SASL initial response `base64("user=" email "\x01auth=Bearer " token "\x01\x01")` for IMAP `AUTHENTICATE XOAUTH2` and SMTP `AUTH XOAUTH2`.
- [ ] Parse the base64 JSON error challenge on failure (`status 400/401`) and map to refresh-and-retry once, then `auth-failed`.
- [ ] Account `auth_kind` column: `password | oauth`. `secrets.rs` gets `get_credential(account) -> Password | AccessToken`.

### Account setup UI
- [ ] Email entry → preset lookup → for Gmail/Google Workspace show "Continue with Google"; for others the password form as today.
- [ ] Progress states: waiting for browser → exchanging → checking IMAP → syncing. Cancel at every step.
- [ ] Error copy for the usual cases: unverified app warning (link to "Advanced → Go to Tern"), test-user missing, IMAP disabled in Gmail settings.

### Labels model
- [ ] Tables `labels (id, account_id, name, role, color, sort)` and `message_labels (message_id, label_id)`.
      Migration v3. For plain IMAP, every folder is a label and a message has exactly one; nothing else changes.
- [ ] Gmail: `[Gmail]/All Mail` is the source of truth. Sync **All Mail** for messages and `X-GM-LABELS` for membership;
      do not sync the other `[Gmail]/*` folders as folders. `\Inbox`, `\Starred`, `\Important`, `\Sent`, `\Draft`, `\Trash`, `\Spam` map to roles.
- [ ] `X-GM-THRID` as the thread key; `X-GM-MSGID` stored for deep links (`https://mail.google.com/mail/u/0/#all/<hex>`).
- [ ] Actions on Gmail become label ops: archive = `-X-GM-LABELS (\Inbox)`, star = `\Flagged`, trash = `COPY` to Trash (Gmail semantics), label = `+X-GM-LABELS (name)`.
- [ ] Trash and Spam are real folders in Gmail; sync them separately for `g #` / `g !`.
- [ ] Label chips on rows and in the pane; `l` opens the label picker (palette in argument mode); `Cmd+Shift+L`... see key table.

### Gmail search
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
Workspace MX detection, Gmail deep links, the "which results came from the server" marker.

## Acceptance
- Add a Gmail account via the browser; no password typed into Tern.
- Archive in Tern → gone from Gmail's Inbox, still in All Mail. Label in Gmail web → chip appears in Tern within the IDLE window.
- Threads in Tern match Gmail's grouping for 20 random conversations.
- Revoke access at myaccount.google.com → Tern shows "Sign in again" within one sync cycle, no crash, no data loss.
- Token refresh observed in the log after an hour of running.
