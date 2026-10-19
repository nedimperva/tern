# Initial Gmail backend decision

**Status:** owner decision: **IMAP with Google sign-in (XOAUTH2)** (2026-10-19), replacing the provisional API choice of 2026-10-13. See Decision below.

The initial release gets one Gmail backend, not an IMAP implementation followed automatically by an API
rewrite. Fastmail remains the first supported IMAP provider. This comparison does not block unrelated
Fastmail alpha work while waiting for owner-provided test credentials.

## Inputs

Owner preparation steps: [Gmail test setup](gmail-test-setup.md).

- A Gmail test account with representative threads, multiple labels, drafts, Sent, Trash, Spam and attachments.
- A desktop OAuth client in a Google Cloud project; record project creation date and effective quota limits.
- Use synthetic/non-sensitive fixture mail for destructive operations and failure injection.
- Owner confirms which account(s) represent intended beta users (consumer Gmail / Workspace).

## Compare with a small probe, not two production backends

| Evidence | IMAP + X-GM extensions | Gmail API |
|---|---|---|
| Labels, canonical message identity, Gmail threads | Record X-GM-MSGID/THRID/LABELS behavior | Record message/thread IDs and label operations |
| Archive/trash and multiple labels | Verify intended scope and no unintended deletion | Verify modify/trash semantics |
| Draft replacement and sent copies | Measure APPEND/reconciliation behavior | Measure drafts/send behavior |
| Startup | First 100 useful rows, then complete metadata backfill; bytes/time | Same rows/backfill; calls, quota units/time |
| Incremental/recovery | Changes/deletions, capabilities, IDLE reconnect, UIDVALIDITY | History cursor expiry/recovery, retries, quota errors |
| Freshness | Inbox IDLE plus other-folder/label reconciliation | Poll cadence, focused/background, quota budget |
| Auth/distribution | Full mail scope, XOAUTH2, renewal/revocation | Narrowest sufficient scope, renewal/revocation |
| Implementation cost | Parser coverage and custom protocol work needed | Adapter/model work needed alongside Fastmail IMAP |

Record provider capabilities from the account; do not assume QRESYNC or uniform notification behavior.
Batch HTTP reduces overhead, not per-message quota costs. Do not infer full-backfill speed from first-page speed.

## Current quota baseline (checked 2026-10-13)

[Google's quota documentation](https://developers.google.com/workspace/gmail/api/reference/quota) describes
new-project limits effective May 1, 2026, and legacy treatment for qualifying projects used November 2025
through April 2026. Published new-project figures include:

- Per user per project: 6,000 quota units/minute.
- `messages.get`: 20 units; `messages.list`: 5 units; `history.list`: 2 units.
- Verify actual project quotas and current per-method costs before estimating or implementing rate control.

Example: 20,000 individual `messages.get` calls cost 400,000 units, roughly 67 minutes of sustained
per-user quota at the published new-project rate, excluding other calls. This is an estimate, not a promise
about exact burst behavior. Fetch the newest useful page first and backfill visibly. The previous
20,000-message/30-second complete-list target is withdrawn.

## Probe (2026-10-19)

`crates/tern-core/examples/gmail_probe.rs` collects the API column: mailbox and label counts, the first screen
(100 inbox messages with headers, one request each), an empty `history.list`, quota used, and a full-backfill
estimate at the published per-user rate. It runs once `secrets/google-client.json` exists (setup step 4).
The IMAP column comes from the owner's existing app-password Gmail account and the package 01 probe: io-imap
drops FETCH responses with X-GM-* items, so labels and Gmail threads are not available over IMAP in Tern today.

### Results (2026-10-19)

Two consumer accounts, project in Testing; the probe made its requests one at a time over the owner's
connection. Sign-in (loopback, PKCE, code exchange, refresh) worked for both on the first try. Both inboxes were
empty (kept at zero), so the first screen was measured on the newest 100 messages of All Mail, which costs the same.

| Gmail API | Second account | Owner's main Gmail |
|---|---|---|
| Mailbox | 182 messages, 176 conversations | 9,782 messages, 8,158 conversations |
| Labels | 14, none of the user's | 22, 7 user (one with a zero-width character in its name) |
| First list call (100 ids) | 282 ms (inbox, empty) | 245 ms |
| First screen (100 messages with headers, one `messages.get` each) | not measured | **23.0 s**, 90 conversations |
| `history.list`, no changes | 217 ms | 223–442 ms |
| Quota for the run | 9 units | 2,014 units |
| Full metadata backfill (estimate) | 3,645 units, about 1 min | **195,740 units, about 33 min** at 6,000 units/min |

What this says:

- **The first screen cannot be one request per message.** About 230 ms each, in sequence, is 23 s for 100. Batch
  HTTP (up to 100 calls in one request) or several in flight is required; it cuts the wait, not the 2,000 units.
- **A full backfill is quota-bound, not network-bound.** About 33 minutes for 9.8k messages before any other call,
  so a 50k mailbox is close to three hours. Newest first and visible progress (as Tern already does for IMAP) are
  required, and the backfill has to yield to the person's own actions.
- Labels and conversations come back natively; the user labels include names that need exact handling.

The same main account over IMAP (`examples/gmail_imap_probe.rs`, app password, Tern's own IMAP code and header
set, 500 messages a command as the sync does), on the same connection the same day:

| IMAP, `[Gmail]/All Mail` | Owner's main Gmail |
|---|---|
| Sign-in (TCP, TLS, LOGIN) | 905 ms |
| SELECT + UID SEARCH ALL | 487 ms, 9,782 messages |
| First screen (100 messages with headers, one command) | **0.44 s** |
| Full header download (20 commands of 500) | **41.8 s**, all 9,782, 4.3 MB |

A later run kept 10 API requests in flight: the same 100 messages took **4.5 s** (28.8 s one at a time in that
run), with nothing refused. That run used 4,014 of the 6,000 units a minute allows.

| Main Gmail, 9.8k messages | IMAP | Gmail API |
|---|---|---|
| First screen, 100 messages | 0.44 s, one command | 4.5 s with 10 in flight (23–29 s one at a time) |
| Every message's headers | 42 s | about 33 min, set by quota |
| Limit | daily download bandwidth | 6,000 units a minute per user; 20 units a message |
| Labels, Gmail threads | not read by Tern today | native |

### Why the API looks this slow (checked 2026-10-19)

- **The rules changed on May 1, 2026.** Google's [usage limits page](https://developers.google.com/workspace/gmail/api/reference/quota)
  lists 6,000 units a minute per user per project and 20 units per `messages.get` (60 for `full`/`raw`) for
  projects created from that date. Before, it was 15,000 a minute and 5 units, so a full sync was about ten times
  cheaper; projects that used the API between November 2025 and April 2026 keep their old limits. `tern-mail` is
  new, so the new rules apply. Per-user limits cannot be raised ([report](https://github.com/ronboger/mishmail/issues/16),
  [Nylas notes](https://developer.nylas.com/docs/cookbook/email/gmail-api-quotas/)). Clients built on the API
  before May were designed against the old budget.
- **Nothing cheaper gives headers.** `messages.list` (5 units per 500 ids) and `threads.list` (10 units) return
  ids and at most a snippet; From, Subject and Date need `messages.get` (20) or `threads.get` (40 per thread).
  [Batching](https://developers.google.com/workspace/gmail/api/guides/batch) (at most 100 a batch, 50 advised)
  counts every call separately and saves only round trips. Google's own [sync guide](https://developers.google.com/workspace/gmail/api/guides/sync)
  is list, then a batched get per message.
- **Freshness** through the API is polling `history.list` (2 units) or push through Cloud Pub/Sub, which needs a
  server; IMAP has IDLE today.
- **Labels over IMAP without X-GM-*:** Gmail exposes every label as a folder, and Tern already syncs folders. A
  label's members are that folder's Message-IDs matched to All Mail, as Tern already matches moved messages. That
  gives exact labels with no parser change; only Gmail's own thread ids stay out of reach (Tern threads by
  References and subject). Reading X-GM-* directly needs imap-codec support: no release has it (alpha.9, July
  2026) and its search keys cannot carry `X-GM-RAW` or `X-GM-LABELS` either, so that would be a fork or an
  upstream patch.
- **Verification:** `gmail.modify` (API) and `https://mail.google.com/` (IMAP over OAuth) are both restricted
  scopes, so a public release needs the same security assessment on either path.

### Options

1. **IMAP for Gmail** (what already syncs the owner's account), with labels read from label folders by
   Message-ID, Tern's own threading, and XOAUTH2 instead of app passwords for release. Fast, no quota.
2. **IMAP plus a patched imap-codec** for X-GM-MSGID/THRID/LABELS: option 1 with Gmail's exact ids and threads.
   Costs a fork or an upstream contribution.
3. **API**: native labels, threads and history, at about 33 minutes of quota per 10k messages for the first full
   download, and a first screen of seconds, not a fraction of one.
4. **Hybrid** (IMAP for mail, API for labels/history): two protocols and two auth paths for one account; the API
   ids cannot be matched to IMAP messages without X-GM-MSGID, so it gains little over option 1.

## Decision gate

- [x] Fill the comparison with probe results and known limitations.
- [x] Recommend one path, including realistic freshness, backfill, search-coverage and verification behavior.
- [x] Owner records **IMAP** or **API** below before provider-specific implementation starts.
- [ ] Update package 04 and, if API is chosen, activate the selected slice of package 12 for M2.
- [ ] Specify supported scopes, message identity/location mapping and required production adapter boundary.
- [ ] Keep a second Gmail backend and user-facing switching out of initial-release scope.

Decision: **IMAP with Google sign-in** (owner, 2026-10-19; option 1). IMAP already syncs the owner's Gmail, gives
the first screen in under half a second and every header in under a minute, and has no per-minute quota. The one
thing the owner disliked was the app password; XOAUTH2 replaces it with the browser sign-in `tern_core::oauth`
already does (io-imap 0.7.1 and lettre both support XOAUTH2). Scope: `https://mail.google.com/`. Labels come from
Gmail's label folders matched by Message-ID; threads from Tern's own threading. The X-GM-* tasks in package 04 stay
out until imap-codec can parse them.

The provisional choice before the evidence was **API** (owner, 2026-10-13), for native labels, threads and history
and a narrower scope. The probe reversed it: with projects created from May 2026 a full download is quota-bound
(about 33 minutes for 9.8k messages), and `gmail.modify` is as restricted as IMAP's scope, so it gained nothing in
verification.

Cost: Google charges nothing for IMAP, the API or the OAuth client. While the Cloud project is in Testing (up to 100
listed test users, sign-in renewed every 7 days) there is no cost at all. A public release with a restricted scope
needs Google's yearly security assessment by an approved assessor, which is paid; the API path needs the same one.

## Verification and optional AI

Begin scope inventory, domain/homepage/privacy preparation and test-user setup during M0. Submit verification
when the chosen implemented flow can be demonstrated; do not wait until release week. Describe optional
remote AI transfers accurately when that feature is introduced. BYOK/opt-in is not a blanket exemption from
restricted-data assessment requirements. See [Google's verification guidance](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification)
and [the OAuth notes](gmail-oauth.md).
