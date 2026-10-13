# Sprint 11 — Outlook / Microsoft 365, and the backend abstraction

**Status:** todo

## Delivery scope

**M4 — expansion, deferred from first release.** Outlook support is not a prerequisite for the initial Gmail decision or Windows. The backend boundary and scripted transport tests move earlier when needed by M0/M2. The trait sketch below is a candidate, not a requirement to wait for Outlook.

Package number is a stable ID, not a delivery week. [PLAN.md](../PLAN.md) defines order and release gates.

## Overview

Microsoft accounts through IMAP + OAuth, and the `MailBackend` trait so the Gmail API (and
later Graph) can sit next to IMAP.

Prerequisites: an Outlook.com or Microsoft 365 test account, and a Microsoft Entra app registration (steps in
`docs/research/microsoft-oauth.md`).

## Goal

"Continue with Microsoft" adds an Outlook.com or M365 account, syncs via `outlook.office365.com`, sends via
`smtp.office365.com`. Use the existing tested transport boundary; extract or extend a production `MailBackend` only when needed.

## Tasks

### Microsoft OAuth
- [ ] Provider `microsoft`: authority `https://login.microsoftonline.com/common/oauth2/v2.0`, scopes
      `https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send offline_access openid email`.
      Public client (no secret), loopback redirect `http://localhost:<port>` (Microsoft requires `localhost`, not `127.0.0.1`, for the redirect in the portal; the code handles both).
- [ ] The access token for the Outlook resource is opaque (not a JWT); do not try to decode it. The refresh token rotates; store the new one each time.
- [ ] Account-type detection: `outlook.com | hotmail.com | live.com | msn.com` → consumer; otherwise MX lookup for `*.mail.protection.outlook.com` → M365. Both use the same endpoints.
- [ ] Known failure `AUTHENTICATE failed` with a valid token: check the scope prefix (`https://outlook.office.com/…`, not Graph's), that IMAP is enabled on the mailbox, and that "Allow public client flows" is on in the registration. Write the error copy for each.

### Outlook IMAP quirks
- [ ] Folder names: `Junk Email`, `Deleted Items`, `Sent Items`, `Archive`; roles via SPECIAL-USE where present, name map otherwise.
- [ ] Exchange supports IDLE and CONDSTORE; QRESYNC varies. The Sprint 1 fallbacks must be exercised here.
- [ ] Exchange copies sent mail to Sent Items itself when sent via `smtp.office365.com`; preset `copies_sent = true`.
- [ ] `MOVE` is supported. Message-ID is sometimes rewritten; thread by `References` first.
- [ ] Throttling: Exchange returns `BYE` / `NO [UNAVAILABLE]` under load; backoff respects `Retry-After`-like hints in the text.

### `MailBackend` trait
- [ ] `tern-core::backend`:
      ```rust
      trait MailBackend {
          async fn connect(&mut self) -> Result<Caps>;
          async fn list_folders(&mut self) -> Result<Vec<RemoteFolder>>;
          async fn sync_folder(&mut self, f: &Folder, since: SyncState, sink: &mut dyn Sink) -> Result<SyncState>;
          async fn fetch_body(&mut self, m: &MessageRef) -> Result<RawMessage>;
          async fn fetch_part(&mut self, m: &MessageRef, part: &str) -> Result<Bytes>;
          async fn apply(&mut self, op: &OutboxOp) -> Result<ApplyResult>;
          async fn wait_for_changes(&mut self, f: &Folder, timeout: Duration) -> Result<Wake>;
          async fn search_remote(&mut self, q: &str) -> Result<Vec<MessageRef>>;
          async fn send(&mut self, raw: &[u8], env: &Envelope) -> Result<SendResult>;
      }
      ```
      `ImapBackend` wraps the existing code with no behaviour change. The worker loop depends only on the trait.
- [ ] `Sink` receives parsed headers/bodies and writes to the store; both IMAP and API backends produce the same `NewMessage`.
- [ ] Tests: a `FakeBackend` that replays a scripted mailbox; the worker's tests move onto it.

### Gmail decision is no longer gated on Outlook
The initial transport decision happens during M0 using
[the Gmail decision checklist](../research/gmail-backend-decision.md). Do not schedule an automatic
Gmail rewrite here. Revisit a second Gmail transport only as separately approved expansion work.

## Cut first
Throttling hints, M365 MX detection.

## Acceptance
- Add an Outlook.com account via the browser; inbox syncs; send and receive work; archive lands in `Archive`.
- Revoke the app at `account.live.com/consent/Manage` → "Sign in again" banner, no crash.
- Scripted transport tests established in M0 remain green; the IMAP integration path is unchanged (Fastmail and Gmail re-tested).

## Decisions

_None yet._

## Log

_No sessions yet._
