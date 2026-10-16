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
- [x] Viewer overlay (`Cmd+O` on a message cycles attachments, `Enter` on a chip): images (zoom/pan), PDF (WebKitGTK renders PDF natively in an iframe; on Windows WebView2 does too), text/code, audio/video via `<video>`; everything else shows an "Open with system" button (`opener`).
      Built with `V` and a click on the file card, not `Cmd+O`; zoom is fit or full size, no pan (see Decisions).
- [ ] Drag out: `startDrag` from Tauri (`tauri-plugin-drag` or the core `start_drag` API) with the cached file path.
- [ ] Drag in: already from Sprint 3 for compose; add drop onto a conversation to start a reply with the file attached.
- [x] Inline images (`cid:`) resolved to cached files via a `tern-att://` custom protocol handler in the iframe; blocked remote images untouched.
- [ ] Attachments browser: palette "Attachments in this conversation", `g` + `Shift+A` for all attachments in the account (list view with filters).

### Contacts (header autocomplete is core; import/merging deferred)
- [ ] Contact ranking from Sprint 3 gets names merged across sources (`contacts` + `contact_emails` for people with several addresses).
- [ ] CardDAV import via `libdav` (`CardDavClient`, service discovery, vCard parse with `vcard` or `ical`-style minimal parser); read-only; Fastmail first, Google Contacts via CardDAV with the OAuth token (`https://www.googleapis.com/.well-known/carddav`) and the `https://www.googleapis.com/auth/carddav` scope added in Settings → "Sync contacts".
- [x] Contact card on hover/`Shift+I` in the pane: name, addresses, last 5 conversations, "Add to VIP" (a rule into Important).
      Built on hover and click of the sender's name, without `Shift+I` or "Add to VIP" (see Decisions).
- [ ] Autocomplete shows the avatar initials chip; Gravatar/remote avatars are **not** fetched (privacy).

### Snippets
- [x] `snippets` table: `shortcut, name, body (ProseMirror doc), subject?, to?, cc?, bcc?, attachments?`.
      Built with a plain-text body and no subject, recipients or files (see Decisions).
- [x] `;` in compose opens a fuzzy snippet picker; `;shortcut` + `Space` expands inline; `Cmd+;` from anywhere opens the palette in snippet mode.
      The palette mode is not built.
- [x] Variables: `{first_name}`, `{name}`, `{email}`, `{subject}`, `{my_name}`, `{date}` filled from the thread; `{cursor}` places the caret.
- [x] Snippet manager in Settings (`g ;`) with import/export JSON. Import/export is not built.

### Instant Intro (`Cmd+Shift+I`)
- [ ] Reply-all where the sender who introduced you moves to Bcc, with the first line "Thanks {first_name}, moving you to bcc." inserted. One key.

### Quick quote
- [x] Select text in a message and press `r`: the reply quotes only the selection.

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

- 2026-10-15 — **Basic snippets are plain text.** The beta scope is "basic snippets", so a snippet is a shortcut,
  a name and plain text (blank lines make paragraphs); its places are filled from the first To address, its
  name in contacts (else the address's first word, so ada.lovelace@ gives Ada), the subject without Re:/Fwd:,
  the account's display name and today's date. Formatting, a subject, recipients and files, the palette mode
  and import/export wait for a need. `;` opens the picker only at the start of a word, so `a;b` and `:;` stay
  text; Esc closes the picker, not compose.

- 2026-10-15 — **The viewer reads the cached file whole.** `attachment_bytes` hands the UI the file
  `received_file` already keeps (downloading the message the first time, as Open does), up to 60 MB, and the UI
  shows it from a blob: URL. The app CSP gained `blob:` for frames and media for that. PDFs use the web view's
  own reader, so how they look depends on WebKitGTK or WebView2; "Open with system" is always beside it.
  Single-part fetches stay a proposal.

- 2026-10-15 — **The contact card is built from mail, not a contacts store.** Counts come from `contacts`
  (filled from headers); the last five conversations are the newest messages from or to the address
  (`Store::contact_card`, walking the date index). One address per person, as there is no merging yet. "Add to
  VIP" waits: the Important split already learns from "Move sender to Important". `Shift+I` is left for
  Instant Intro's family of keys.

## Log

- 2026-10-15 — Received attachments open and save (see Decisions). Engine checks: `mime` tests for matching and
  safe names; the dev-server attachment test also downloads and matches each listed file. UI tried in
  `npm run dev` against the fake mailbox only (no window here).
- 2026-10-15 — Owner: a conversation did not say which messages have files, and some messages showed none. Collapsed
  cards now carry a paperclip (and a count above one). Mail downloaded whole before schema v6 had its attachment
  flag but no `parts`, so its files were never listed; schema v15 fetches those bodies again (the stored body
  still shows meanwhile). Still open: images sent inline (`cid:`) are neither drawn nor listed (viewer task).
- 2026-10-15 — Owner acceptance: a pasted picture showed only as an attachment. `cid:` images are now drawn in place:
  the first open of such a message downloads it (as for attachments), `mime::inline_images` turns its image parts
  into data: URIs (20 MB at most per message), cached in `received/<id>/inline.json`. Planned was a `tern-att://`
  protocol; data: URIs needed no new scheme or CSP change (the frame already allowed `data:`). Remote images stay
  blocked as before. Checked with a `mime` test; not yet in the Tauri window.
- 2026-10-15 — Snippets (see Decisions): schema v17, `Store::snippets/save_snippet/delete_snippet/snippet_used`
  with a test, the picker in the editor and a Snippets section in Settings (`g ;`). Tried in `npm run dev` with
  headless Chromium against the fake mailbox: `;ca` + Enter, `;thanks` + Space with `{first_name}` filled,
  `{cursor}` placing the caret, a taken shortcut refused, a new snippet saved and used. Not yet tried in the
  Tauri window.
- 2026-10-15 — Attachment viewer, quick quote, the conversation `…` menu and the contact card (see Decisions).
  `store::tests::a_contact_card_holds_their_latest_conversations_once_each` covers the card's query. Tried in
  `npm run dev` with headless Chromium against the fake mailbox in light and dark: the viewer stepping through a
  PDF, a spreadsheet (shown as "Open with system"), a picture and a CSV table; `V`; the menu's items and Esc;
  the card on hover and gone after; a selection quoted by `r`. Not yet tried in the Tauri window (PDF in
  WebKitGTK especially).
