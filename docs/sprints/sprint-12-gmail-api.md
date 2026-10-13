# Sprint 12 — Gmail API backend

**Status:** todo

## Delivery scope

**M0 probe; M2 only if API is selected; otherwise deferred.** This is an alternative initial Gmail transport, not an automatic second backend. Activate only after the owner decision in [the early gate](../research/gmail-backend-decision.md). Shared OAuth/UI tasks remain in package 04. Switching Gmail backends is deferred from the first release.

Package number is a stable ID, not a delivery week. [PLAN.md](../PLAN.md) defines order and release gates.

## Overview

Only if the M0 Gmail gate selects API. Add the minimal Gmail adapter alongside Fastmail IMAP; no Gmail IMAP implementation is required first.

Scopes: `gmail.modify` (read, label, archive, trash, drafts, send) is enough and is narrower than
`https://mail.google.com/`. Both are "restricted"; verification requirements are the same, so the smaller
scope is strictly better. See `docs/research/gmail-oauth.md`.

## Goal

If selected, Gmail uses the API from initial account setup. Sync uses `history.list`; labels, threads and
drafts are native; send goes through `messages.send`. Measure performance and polling freshness; do not
promise it is universally faster than IMAP. User-facing backend switching is deferred.

## Tasks

### Client
- [ ] `reqwest` + `serde` models for `users.labels`, `users.messages` (`list`, `get` with `format=metadata|raw|full`), `users.threads`, `users.history.list`, `users.drafts`, `users.messages.send`, `users.messages.batchModify`.
- [ ] Batch HTTP where appropriate; each subrequest still consumes quota. Read effective project quotas and current method costs: published 2026 new-project baseline is 20 units per `messages.get`, 6,000 units/user/project/minute. Budget interactive requests before background backfill; see the early decision research.
- [ ] Backoff on `429` / `403 rateLimitExceeded` with the documented exponential policy; `Retry-After` honoured.
- [ ] Gzip, HTTP/2, connection reuse; `userId=me`.

### Sync
- [ ] Initial: `messages.list` with the chosen query/labels and `maxResults=500` returns IDs, not metadata. Follow with quota-budgeted `messages.get(format=metadata)` for useful recent rows; verify ordering rather than assuming it. Backfill metadata visibly, then bodies on demand/policy via `messages.get(format=raw)`.
- [ ] Incremental: store `historyId`; `history.list(startHistoryId, historyTypes=messageAdded,messageDeleted,labelAdded,labelRemoved)`; on `404` (history too old) fall back to a label-scoped re-list.
- [ ] Push: no server, so no Pub/Sub. Start with `history.list` polling every 30 s while focused, 2 min in background; handle pagination and backoff and record observed freshness. This is not a two-second push guarantee.
- [ ] Threads from `threadId` directly (same as X-GM-THRID), labels from `labelIds`, label metadata (name, colour, type, visibility) from `labels.list`.
- [ ] Apply: `batchModify` with `addLabelIds`/`removeLabelIds` for archive/star/read/label/trash (`TRASH` label) — one call per outbox batch.

### Drafts and send
- [ ] Drafts via `drafts.create/update/delete` with the raw RFC 5322 from Sprint 3; the server copy is the source of truth.
- [ ] Send via `messages.send` with `threadId` for replies; Gmail adds to Sent itself. Undo-send stays local (the outbox delay).
- [ ] Send-as aliases from `settings.sendAs.list` populate `identities`.

### Switching backends (M4 only, excluded from initial-release acceptance)
- [ ] Settings → Account → "Sync method: IMAP | Gmail API". Switching re-keys messages by `X-GM-MSGID` ↔ `id` (same number, decimal vs hex) so no re-download.
- [ ] Re-consent only if the scope set changes.

## Cut first
Send-as aliases and label-colour polish. Backend switching is already out of initial-release scope; do not build a second Gmail path as a fallback requirement.

## Acceptance
- Fresh Gmail account: first useful page target and complete-backfill estimate are recorded from the M0 probe; progress/partial coverage remains visible. No 20,000-message/30-second complete-list guarantee.
- Label changes converge within the selected focused/background poll interval plus measured fetch time on a healthy connection; archive reaches Gmail after the local undo window, with server completion visible.
- Quota: log rolling per-minute use and demonstrate interactive headroom under the actual project limits during initial backfill and normal use; handle throttling without losing progress.

## Decisions

_None yet._

## Log

_No sessions yet._
