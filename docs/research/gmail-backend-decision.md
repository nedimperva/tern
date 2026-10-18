# Initial Gmail backend decision

**Status:** provisional owner decision: **Gmail API** (2026-10-13). Confirm with the comparison below before Gmail-specific implementation.

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

## Decision gate

- [ ] Fill the comparison with probe results and known limitations.
- [ ] Recommend one path, including realistic freshness, backfill, search-coverage and verification behavior.
- [ ] Owner records **IMAP** or **API** below before provider-specific implementation starts.
- [ ] Update package 04 and, if API is chosen, activate the selected slice of package 12 for M2.
- [ ] Specify supported scopes, message identity/location mapping and required production adapter boundary.
- [ ] Keep a second Gmail backend and user-facing switching out of initial-release scope.

Decision: **API, provisional** (owner, 2026-10-13). Reasons given: the API is Google's long-term interface for
Gmail (labels, threads and history natively), it allows a narrower scope than IMAP's full-mail scope, verification
cost is the same on both paths, and it lets the IMAP library (io-imap) ignore Gmail's X-GM-* extensions it cannot
parse. Evidence: **not yet collected**. The comparison still runs once the test account and Cloud project exist;
a surprise there (for example quotas far worse than estimated) reopens the decision before any Gmail code exists.

## Verification and optional AI

Begin scope inventory, domain/homepage/privacy preparation and test-user setup during M0. Submit verification
when the chosen implemented flow can be demonstrated; do not wait until release week. Describe optional
remote AI transfers accurately when that feature is introduced. BYOK/opt-in is not a blanket exemption from
restricted-data assessment requirements. See [Google's verification guidance](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification)
and [the OAuth notes](gmail-oauth.md).
