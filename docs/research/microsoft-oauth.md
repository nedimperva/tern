# Microsoft: Entra app registration and Outlook IMAP

## Setup (owner, before Sprint 11) — about 15 minutes

1. **entra.microsoft.com** → Identity → Applications → **App registrations** → New registration.
   - Name `Tern`.
   - Supported account types: **Accounts in any organizational directory and personal Microsoft accounts** (multitenant + MSA). This covers Outlook.com, Hotmail and Microsoft 365.
   - Redirect URI: platform **Mobile and desktop applications**, value `http://localhost` (Microsoft accepts `http://localhost` with any port for public clients; `127.0.0.1` is *not* accepted in the portal, so Tern's listener answers on both names).
2. **Authentication** → Advanced settings → **Allow public client flows: Yes**. No client secret.
3. **API permissions** → Add → **Microsoft Graph → Delegated**: `IMAP.AccessAsUser.All`, `SMTP.Send`, `offline_access`, `openid`, `email`, `User.Read`. (They appear under Graph in the portal, but are requested with the Outlook resource prefix below.) Later for Graph backend: `Mail.ReadWrite`, `Mail.Send`, `Calendars.ReadWrite`, `Contacts.Read`.
4. Copy the **Application (client) ID**. Commit it to `crates/tern-core/src/oauth/microsoft.rs`.
5. Optional later: **Publisher verification** (needs a Partner Center account) removes the "unverified publisher" banner.

## Flow

```
authorize: https://login.microsoftonline.com/common/oauth2/v2.0/authorize
token:     https://login.microsoftonline.com/common/oauth2/v2.0/token
scopes:    https://outlook.office.com/IMAP.AccessAsUser.All
           https://outlook.office.com/SMTP.Send
           offline_access openid email
PKCE S256, redirect http://localhost:<port>
```

- The access token for the Outlook resource is **opaque**, not a JWT. Do not decode or validate it locally.
- Refresh tokens rotate: store the new `refresh_token` from every token response. MSA refresh tokens live 90 days of inactivity.
- You cannot mix resources in one token: Graph scopes and `outlook.office.com` scopes need separate access tokens (same refresh token can mint both).

## IMAP/SMTP

| | |
|---|---|
| IMAP | `outlook.office365.com:993` (implicit TLS) |
| SMTP | `smtp.office365.com:587` STARTTLS (`smtp-mail.outlook.com` also works for consumer) |
| Auth | `AUTHENTICATE XOAUTH2` / `AUTH XOAUTH2`, same SASL string as Gmail |
| Basic auth | Disabled for M365 (Oct 2022) and Outlook.com (Sept 2024). OAuth is the only way. |

Known quirks (collected from Microsoft Q&A threads 2024–2025):
- `NO AUTHENTICATE failed` with a valid token usually means: scope requested without the `https://outlook.office.com/` prefix (Graph token instead), IMAP disabled on the mailbox (Exchange admin or Outlook.com settings), or "Allow public client flows" off.
- Consumer Outlook.com IMAP OAuth has had outages/regressions; keep the error path good and the Graph backend as the strategic path for Microsoft.
- Exchange sends `* BYE Connection closed` under throttling; reconnect with backoff.
- Folder names are localised for some tenants; rely on SPECIAL-USE (`\Sent`, `\Trash`, `\Junk`, `\Drafts`, `\Archive`) and fall back to English names.
- Sent mail via `smtp.office365.com` is copied to Sent Items by the server.
- IDLE and CONDSTORE are supported; QRESYNC is not advertised. MOVE is supported.
