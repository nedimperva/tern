# Sprint 7 — Attachments, contacts, snippets

**Status:** in progress · started 2026-10-15

## Delivery scope

**M1 basic attachments/autocomplete; M2 snippets; M4 advanced features.** Core attachment scope is send/download/save/open with system, with clear progress/errors. Core contacts are header-derived autocomplete; basic snippets join in beta. Embedded PDF/media previews, drag-out, attachment browser, CardDAV/contact merging, Instant Intro and other advanced items below are deferred from the first release.

Package number is a stable ID, not a delivery week. [PLAN.md](../PLAN.md) defines order and release gates.

## Overview

The surrounding features that save seconds many times a day.

## Goal

Attachments open instantly in a viewer, drag in and out of the app; contacts rank well and can come from
CardDAV; snippets expand with `;`; Instant Intro does the reply-all-and-bcc dance in one key.

## Tasks

### Attachments (basic fetch/save/open is core; embedded viewer and drag-out deferred)
- [ ] `attachments` table: `message_id, part, filename, mime, size, cid, state (remote | cached), path`.
- [ ] Fetch a single part with `UID FETCH (BODY.PEEK[<part>])` on open; cache to `app_data/attachments/<account>/<msgid>/`. Decode base64/QP in Rust.
- [ ] Viewer overlay (`Cmd+O` on a message cycles attachments, `Enter` on a chip): images (zoom/pan), PDF (WebKitGTK renders PDF natively in an iframe; on Windows WebView2 does too), text/code, audio/video via `<video>`; everything else shows an "Open with system" button (`opener`).
- [ ] Drag out: `startDrag` from Tauri (`tauri-plugin-drag` or the core `start_drag` API) with the cached file path.
- [ ] Drag in: already from Sprint 3 for compose; add drop onto a conversation to start a reply with the file attached.
- [ ] Inline images (`cid:`) resolved to cached files via a `tern-att://` custom protocol handler in the iframe; blocked remote images untouched.
- [ ] Attachments browser: palette "Attachments in this conversation", `g` + `Shift+A` for all attachments in the account (list view with filters).

### Contacts (header autocomplete is core; import/merging deferred)
- [ ] Contact ranking from Sprint 3 gets names merged across sources (`contacts` + `contact_emails` for people with several addresses).
- [ ] CardDAV import via `libdav` (`CardDavClient`, service discovery, vCard parse with `vcard` or `ical`-style minimal parser); read-only; Fastmail first, Google Contacts via CardDAV with the OAuth token (`https://www.googleapis.com/.well-known/carddav`) and the `https://www.googleapis.com/auth/carddav` scope added in Settings → "Sync contacts".
- [ ] Contact card on hover/`Shift+I` in the pane: name, addresses, last 5 conversations, "Add to VIP" (a rule into Important).
- [ ] Autocomplete shows the avatar initials chip; Gravatar/remote avatars are **not** fetched (privacy).

### Snippets
- [ ] `snippets` table: `shortcut, name, body (ProseMirror doc), subject?, to?, cc?, bcc?, attachments?`.
- [ ] `;` in compose opens a fuzzy snippet picker; `;shortcut` + `Space` expands inline; `Cmd+;` from anywhere opens the palette in snippet mode.
- [ ] Variables: `{first_name}`, `{name}`, `{email}`, `{subject}`, `{my_name}`, `{date}` filled from the thread; `{cursor}` places the caret.
- [ ] Snippet manager in Settings (`g ;`) with import/export JSON.

### Instant Intro (`Cmd+Shift+I`)
- [ ] Reply-all where the sender who introduced you moves to Bcc, with the first line "Thanks {first_name}, moving you to bcc." inserted. One key.

### Quick quote
- [ ] Select text in a message and press `r`: the reply quotes only the selection.

## Cut first
Google Contacts via CardDAV (keep Fastmail), attachments browser, drag out.

## Acceptance
- Open a 5 MB PDF attachment from a Fastmail message in under a second on second open (cached), viewer navigates pages.
- Drag a PNG from the file manager onto a conversation → reply with the file attached.
- `;thanks` + `Space` expands a snippet with `{first_name}` filled.
- Fastmail CardDAV contacts show up in autocomplete with their names.

## Decisions

- 2026-10-15 — **Open and save came early, without the table.** The owner could see attachments on received mail
  but do nothing with them (Windows test, 2026-10-15). A chip now opens the file with the system's program and
  the arrow beside it saves it. Planned: an `attachments` table and `BODY.PEEK[<part>]` per file. Built: the
  whole message is fetched once on a connection of its own (`sync::download`), its listed files are written to
  `app_cache/received/<message>/<n>/<name>`, and later opens read that copy. Rows parsed from a full body have no
  section numbers, so one path that works for every row came first. Names are made safe for every system, and
  programs or disk images (`.exe`, `.lnk`, `.iso`, …) are saved but never opened. Proposal: keep this until the
  viewer task, then fetch single parts where BODYSTRUCTURE gave a section.

## Log

- 2026-10-15 — Received attachments open and save (see Decisions). Engine checks: `mime` tests for matching and
  safe names; the dev-server attachment test also downloads and matches each listed file. UI tried in
  `npm run dev` against the fake mailbox only (no window here).
- 2026-10-15 — Owner: a conversation did not say which messages have files, and some messages showed none. Collapsed
  cards now carry a paperclip (and a count above one). Mail downloaded whole before schema v6 had its attachment
  flag but no `parts`, so its files were never listed; schema v15 fetches those bodies again (the stored body
  still shows meanwhile). Still open: images sent inline (`cid:`) are neither drawn nor listed (viewer task).

