# Sprint 12 — Gmail API backend

**Status:** todo

**Week 13.** Only if Sprint 11's gate said "go". A second `MailBackend` for Gmail using the REST API.

Scopes: `gmail.modify` (read, label, archive, trash, drafts, send) is enough and is narrower than
`https://mail.google.com/`. Both are "restricted"; verification requirements are the same, so the smaller
scope is strictly better. See `docs/research/gmail-oauth.md`.

## Goal

A Gmail account can be switched from IMAP to API in Settings (and back). Sync uses `history.list`; labels,
threads and drafts are native; send goes through `messages.send`. The user cannot tell which backend is
active except that the API one syncs faster and shows label colours.

## Tasks

### Client
- [ ] `reqwest` + `serde` models for `users.labels`, `users.messages` (`list`, `get` with `format=metadata|raw|full`), `users.threads`, `users.history.list`, `users.drafts`, `users.messages.send`, `users.messages.batchModify`.
- [ ] Batch HTTP (`multipart/mixed` to `/batch/gmail/v1`) for `messages.get` in groups of 50; respect quota units (5 per `get`, 250 units/user/second).
- [ ] Backoff on `429` / `403 rateLimitExceeded` with the documented exponential policy; `Retry-After` honoured.
- [ ] Gzip, HTTP/2, connection reuse; `userId=me`.

### Sync
- [ ] Initial: `messages.list` on `in:anywhere` (or per label) newest first with `maxResults=500`, `format=metadata` with the header set from Sprint 1 → rows; bodies on demand/policy via `format=raw` (base64url → bytes → existing `mime.rs`).
- [ ] Incremental: store `historyId`; `history.list(startHistoryId, historyTypes=messageAdded,messageDeleted,labelAdded,labelRemoved)`; on `404` (history too old) fall back to a label-scoped re-list.
- [ ] Push: no server, so no Pub/Sub. Poll `history.list` every 30 s while focused, 2 min in background; it is one cheap call.
- [ ] Threads from `threadId` directly (same as X-GM-THRID), labels from `labelIds`, label metadata (name, colour, type, visibility) from `labels.list`.
- [ ] Apply: `batchModify` with `addLabelIds`/`removeLabelIds` for archive/star/read/label/trash (`TRASH` label) — one call per outbox batch.

### Drafts and send
- [ ] Drafts via `drafts.create/update/delete` with the raw RFC 5322 from Sprint 3; the server copy is the source of truth.
- [ ] Send via `messages.send` with `threadId` for replies; Gmail adds to Sent itself. Undo-send stays local (the outbox delay).
- [ ] Send-as aliases from `settings.sendAs.list` populate `identities`.

### Switching backends
- [ ] Settings → Account → "Sync method: IMAP | Gmail API". Switching re-keys messages by `X-GM-MSGID` ↔ `id` (same number, decimal vs hex) so no re-download.
- [ ] Re-consent only if the scope set changes.

## Cut first
Send-as aliases, backend switching in-place (require re-adding the account instead).

## Acceptance
- Fresh Gmail account via API: 20,000-message inbox list in under 30 s; label colours visible.
- Label change in Gmail web shows in Tern within 30 s; archive in Tern shows in Gmail web immediately.
- Quota: a full day of normal use stays under 10 % of the per-user quota (log the unit count).

## Decisions

_None yet._

## Log

_No sessions yet._
