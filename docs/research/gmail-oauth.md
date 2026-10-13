# Gmail: OAuth, scopes, verification

## Release sequencing

Choose the initial transport during M0 using [the decision checklist](gmail-backend-decision.md). Only one
Gmail transport ships initially. Begin project/domain/privacy/scope preparation early; complete the
implementation in M2, submit verification when the selected flow is demonstrable, and distinguish a
controlled test-user beta from unrestricted public distribution.

## Setup (owner, during M0)

1. **Google Cloud Console** → New project, e.g. `tern-mail`.
2. **APIs & Services → Library**: enable **Gmail API** (needed even for IMAP XOAUTH2 so the scope is valid). Later: **Google Calendar API**, **People API** / CardDAV (Sprint 7/9).
3. **OAuth consent screen** (now "Google Auth Platform → Branding/Audience"):
   - User type: **External**. Publishing status: **Testing**.
   - App name `Tern`, support email, developer contact. Logo optional (adds review time later).
   - Audience → **Test users**: add your Gmail address(es). Up to 100 while in Testing.
   - Data access → Scopes: choose `https://mail.google.com/` for the IMAP/SMTP path **or** `https://www.googleapis.com/auth/gmail.modify` for the API path. Do not request both by default. Calendar/Contacts scopes are deferred and requested incrementally only if those features are implemented/enabled.
4. **Credentials → Create credentials → OAuth client ID**:
   - Application type: **Desktop app**. Name `Tern desktop`.
   - Download the JSON. The `client_id` ends in `.apps.googleusercontent.com`; the `client_secret` for Desktop clients is **not a secret** by Google's own definition ("installed apps cannot keep secrets") and is fine in an open-source repo. Thunderbird, GNOME Online Accounts and others ship theirs.
5. Share `client_id` and `client_secret` with the agent (or commit them yourself to `crates/tern-core/src/oauth/google.rs`).

Refresh tokens issued while the app is in **Testing** expire after **7 days**. Expect to re-consent weekly during development; this goes away once the consent screen is **In production** (even before verification completes).

## Flow (RFC 8252 — native apps; IMAP example below)

```
1. Tern binds 127.0.0.1:<random port> and opens the system browser at
   https://accounts.google.com/o/oauth2/v2/auth
     ?client_id=…&redirect_uri=http://127.0.0.1:<port>&response_type=code
     &scope=https://mail.google.com/ email openid
     &code_challenge=<S256>&code_challenge_method=S256
     &access_type=offline&prompt=consent&state=<random>&login_hint=<email>
2. User consents. Google redirects to http://127.0.0.1:<port>/?code=…&state=…
3. Tern verifies state, exchanges code (+ code_verifier) at https://oauth2.googleapis.com/token
   → access_token (1 h), refresh_token, id_token (email for the account row)
4. IMAP: AUTHENTICATE XOAUTH2 base64("user=" email "\x01auth=Bearer " access_token "\x01\x01")
   SMTP: AUTH XOAUTH2 <same>
5. Refresh with grant_type=refresh_token before expiry. On invalid_grant → re-consent.
```

If the API path is selected, use its chosen Gmail API scopes instead of the example full-mail scope,
and replace steps 4–5 transport authentication with authorized API calls plus token renewal.

Google requires the loopback **IP literal** (`127.0.0.1`), not `localhost`, for Desktop clients. The port is free-form.

Error challenge from XOAUTH2 is base64 JSON `{"status":"400|401","schemes":"bearer","scope":"https://mail.google.com/"}`; the client must send an empty line to finish the exchange, then can retry after a refresh.

## Scopes

| Scope | Class | Used for |
|---|---|---|
| `https://mail.google.com/` | restricted | IMAP + SMTP (the only scope IMAP accepts) |
| `https://www.googleapis.com/auth/gmail.modify` | restricted | Gmail API path if selected in M0 (package 12). Covers read, labels, drafts, send, trash. Not permanent delete. |
| `…/auth/calendar` | sensitive | CalDAV / Calendar API (Sprint 9) |
| `…/auth/carddav` | sensitive | Google Contacts via CardDAV (Sprint 7) |
| `openid email` | — | Know which account was signed in |

Request only what the enabled features need; add Calendar/Contacts scopes incrementally with a second consent when the user turns those features on (Google calls this incremental authorization; it keeps the first consent screen short).

## Unverified-app phase

- Consent screen shows "Google hasn't verified this app" with an **Advanced → Go to Tern (unsafe)** link. Only test users can get through while in Testing; once In production and unverified, anyone can, up to a cap of 100 users total.
- Document this in README with a screenshot. Offer "Use your own Google client ID" in advanced settings so power users and distro packagers are not blocked by the cap.

## Verification (prepare M0; submit as soon as the selected flow is demonstrable)

Requirements for restricted scopes:
1. Verified domain ownership (Search Console) for the homepage and privacy policy URLs.
2. Homepage describing the app; **privacy policy** stating what data is accessed, stored locally and transmitted. Optional remote AI transfers must be disclosed when implemented; do not make an unconditional on-device-only claim.
3. A YouTube video showing the OAuth flow in the app and how each scope is used.
4. Written justification per scope ("IMAP access requires the full mail scope; Tern is a mail client").
5. **Security assessment (CASA)**: evaluate the actual data flow against [Google's current guidance](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification). Local storage alone is not the whole question: optional remote AI can transmit restricted data to third-party servers. BYOK and opt-in are not blanket exemptions. Ask Google which requirements apply; do not promise an exemption or assessment price before confirmation.

Treat review as an external dependency with variable timing. Start preparation in M0 and submit when the selected implemented flow, scope justification and accurate privacy material are ready; do not wait for the launch package.

## Gmail IMAP specifics worth remembering

- Capabilities: `IMAP4rev1 UNSELECT IDLE NAMESPACE QUOTA ID XLIST CHILDREN X-GM-EXT-1 UIDPLUS COMPRESS=DEFLATE ENABLE MOVE CONDSTORE ESEARCH UTF8=ACCEPT LIST-EXTENDED LIST-STATUS LITERAL- SPECIAL-USE APPENDLIMIT=35651584`. **CONDSTORE is advertised, QRESYNC is not.** Verify in the Sprint 1 probe; the plan assumes flag re-scans on All Mail.
- `[Gmail]/All Mail` has `\All`; use it for ordinary message storage and label membership. Trash and Spam need separate sync; do not claim All Mail includes them. Inbox membership is the `\Inbox` label.
- Labels with "Show in IMAP" off are invisible to IMAP. The API backend sees them all.
- `X-GM-MSGID` (decimal) = Gmail API message `id` (hex). Same for thread ids.
- Deleting from a label folder removes the label; deleting from All Mail or Trash deletes. Our "trash" action must `COPY` to `[Gmail]/Trash`.
- Send `ID` after login; Google asks for it.
- Connection limit 15 per account; we use 2.
