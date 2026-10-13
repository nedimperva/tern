# Sprint 15+ — Backlog

**Status:** todo

## Delivery scope

**M4 and later — owner-prioritized expansion.** The narrower initial release and milestone order in PLAN.md control scope. Do not automatically pull every deferred item into the next milestone. Optional AI is retained; calendar, advanced contacts/previews and additional backends stay demand-driven.

Package number is a stable ID, not a delivery week. [PLAN.md](../PLAN.md) defines order and release gates.

## Overview

Candidate expansion work, not a mandatory queue. Pull into a milestone when the owner approves.
Optional AI remains in package 10; calendar in package 09. Advanced contact imports/merging and embedded
attachment previews from package 07 are deferred here in priority terms, not lost requirements.

## Mail
- Microsoft Graph backend (`MailBackend` impl): categories, Focused Inbox, better threading, calendar via Graph.
- Native Google Calendar API (colours, conferencing data, working location) replacing CalDAV for Google.
- Gmail API: watch via Pub/Sub is impossible without a server; keep polling. Consider a tiny optional relay only if users ask.
- JMAP backend (Fastmail is JMAP-native; `jmap-client` crate) — faster sync than IMAP for Fastmail users.
- S/MIME and OpenPGP (read + verify first, then sign/encrypt) via `sequoia-openpgp`.
- Server-side filters UI for Gmail (`settings.filters`) and Sieve (Fastmail, ManageSieve).
- Vacation responder via `settings.vacation` / Sieve.
- Spam reporting with `!` → provider-appropriate action (Gmail `SPAM` label already; others move to Junk).
- Conversation "Done" folder semantics for IMAP servers with no Archive (configurable folder).

## UI
- Multiple windows and tabs (Superhuman has `Cmd+T`, `Cmd+N`), pop-out compose.
- Themes beyond light/dark: import a palette from Omarchy's current theme file; community themes as CSS vars JSON.
- Comfortable / dense / spacious density; larger fonts for accessibility; full screen-reader pass (ARIA roles on the virtual list are non-trivial).
- Inbox Zero backgrounds: curated set + user folder; time-of-day greeting.
- Reading pane on the bottom option; three-pane layout option for wide screens.
- i18n with `@solid-primitives/i18n`; date formatting via `Intl`.
- Emoji picker (`:smile`) in compose; GIF no.
- Read receipts request (MDN) — send only, never answer automatically.

## Engine
- Sync throttling when on metered connections (NetworkManager exposes it).
- Attachment virus scanning hook (ClamAV socket) — opt-in.
- Full-text search across attachments (PDF text via `pdf-extract`, Office via `zip` + XML).
- Encrypted local database option (SQLCipher via `rusqlite` `bundled-sqlcipher`) with a key in the keyring.
- Export: mbox / EML of a conversation or a search; import mbox.

## Platform
- Flathub publish; Snap no.
- macOS build (Tauri supports it; keyring `apple-native` already on) — only if someone with a Mac maintains it.
- Windows code signing; MSIX for the Store.
- Portable Windows build (settings next to the exe).

## Explicitly not planned
- Read statuses / open tracking pixels.
- Team features (shared threads, comments, shared drafts).
- Any hosted service, telemetry, or accounts with Tern itself.

## Decisions

_None yet._

## Log

_No sessions yet._
