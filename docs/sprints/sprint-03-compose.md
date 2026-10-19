# Sprint 3 — Compose

**Status:** tasks done (aliases cut) · acceptance checks with the owner · started 2026-10-14

## Delivery scope

**M1 core; editor extras later.** Required: basic compose/reply/forward, correct recipients/MIME, durable local and server drafts, attachment round-trip, signatures, header-derived autocomplete, safe send/undo and visible failures. Stage a rich editor separately after draft/send reliability is proven. Aliases, image paste and pop-out compose are deferred; they do not block M1.

Package number is a stable ID, not a delivery week. [PLAN.md](../PLAN.md) defines order and release gates.

## Overview

Writing mail should be as fast as reading it. Rich text that stays out of the way, replies
that quote correctly, drafts that survive, attachments, signatures, autocomplete.

## Goal

`c` opens compose in under 50 ms with the cursor in **To**. `r` / `Enter` / `f` open reply, reply-all,
forward with correct recipients and quoting. `Cmd+Enter` sends with undo; `Cmd+Shift+Enter` sends and
marks done. Drafts land in the server's Drafts folder.

## Tasks

### Rich editor (separate slice after core draft/send gate)
- [x] ProseMirror core (`prosemirror-model`, `-state`, `-view`, `-schema-basic`, `-keymap`, `-history`,
      `-inputrules`) with a small schema: paragraph, bold, italic, underline, strike, link, bullet/ordered list,
      blockquote, code (inline), hard break. No tables, no headings, no colours in v1.
- [x] Keys: `Cmd+B/I/U`, `Cmd+K` link, `Cmd+Shift+7/8` lists, `Cmd+Shift+9` quote, `Cmd+Z/Shift+Z`, `Cmd+[ ]` indent.
      Markdown input rules: `*`, `-`, `1.`, `>`, backticks.
- [x] Serialise to HTML (inline-styled where mail clients need it) and a plain-text alternative (`text/plain` from the doc, not from the HTML).
- [x] Paste: strip Word/Docs styles down to the schema; paste images as attachments (inline `cid:` later).
      Styles reduce to the schema (ProseMirror parses pasted HTML through it); pasted images are cut (Cut first).
- [x] Bundle budget for the editor: 60 kB gzipped. Measure.
      Measured 69.8 kB gzipped, over by ~10 kB (see Decisions); loaded as its own chunk.

### Compose surface
- [x] Inline at the bottom of the conversation for replies, a centred modal for new mail; `Cmd+Shift+O` pops out to its own window later (backlog).
- [x] Fields: From (account picker if > 1), To, Cc, Bcc (hidden until `Cmd+Shift+C/B`), Subject. `Tab` between fields; `Esc` closes (keeps the draft).
- [x] Recipient chips; `Backspace` on an empty field edits the last chip; invalid addresses highlighted; paste a list of addresses splits them.
- [x] "Send & Mark Done", "Send Later" (stub until Sprint 5), "Remind me" (stub until Sprint 5) in a footer with their keys.
      Send & Done only; no stubs (see Decisions).

### Reply, reply-all, forward (core; rich quoting follows editor slice)
- [x] Reply-all excludes our own addresses (all aliases from the account), honours `Reply-To`, `Mail-Followup-To`.
- [x] Quote header `On <date>, <name> <<addr>> wrote:` then `<blockquote>` of the original HTML (sanitised) or text; collapsed in the editor behind "···", editable on click.
- [x] Forward includes original attachments; subject `Fwd:`; original headers block.
- [x] Threading headers: `In-Reply-To`, `References` appended; `Message-ID` generated as `<uuid@tern>` (host part from the account domain).

### Drafts
- [x] Autosave to SQLite every 2 s of idle typing (`drafts` table: account, thread_id, fields JSON, doc JSON, attachments, updated).
- [x] Sync to the server's Drafts folder as RFC 5322 via `APPEND` with `\Draft`, replacing the previous UID (delete old after the new one lands). Debounced to 30 s and on close.
- [x] Drafts appear in the list (`g d`) and inline in the conversation they belong to; `Enter` reopens.
- [x] Discard: `Cmd+Shift+,` with undo.

### Attachments
- [x] File picker (`Cmd+Shift+A`) via `tauri-plugin-dialog`; drag and drop onto compose from the file manager (`tauri://drag-drop` event).
- [x] Attachments stored in `app_data/attachments/<draft-id>/`; size total shown; warn over 25 MB.
- [x] Build MIME with `lettre`'s `MessageBuilder` and `MultiPart::mixed/alternative`; stream large files, don't read into memory twice.

### Sending
- [x] Send puts an `Outbox::Send` op with `not_before = now + undo window` (setting: 0/5/10/20 s). Toast with "Undo".
- [x] SMTP via `lettre` (rustls). On permanent failure (5xx) the message returns to Drafts with the error shown; on 4xx retry with backoff.
- [x] Copy to Sent via `APPEND` when the preset says the server does not (Fastmail does; Gmail does; most others don't).
- [x] Sent conversation is marked done (archived) when "Send & Mark Done" was used.

### Signatures and identity
- [x] Per-account signature (ProseMirror doc), inserted above the quote; setting to place below.
      Done as plain text until the editor lands (settings `signatures`, `signatureBelow`). Schema v20
      (2026-10-19) moved them to a `signatures` table: several per account, formatted with compose's editor,
      one for new mail and one for replies, switched in compose (`Ctrl+Shift+S`).
- [ ] Aliases per account (`identities` table): name, address, signature; "From" picker lists them.
      Cut for M1, as the delivery scope allows (aliases, image paste and pop-out are deferred).

### Recipient autocomplete
- [x] `contacts` table built from headers as mail syncs: `email, name, sent_count, received_count, last_seen`.
- [x] Ranking: `3·sent + 1·received`, decayed by recency; prefix match on name parts and email.
- [x] Popup under the field, `↑/↓/Enter/Tab`, < 5 ms per keystroke (SQLite index on `email`, `name` collate nocase).

## Cut first
Pop-out window, paste-images-as-attachments, aliases. Never cut draft autosave.

## Acceptance
- Reply to a Fastmail thread from Tern; Fastmail web shows it threaded correctly with correct quoting.
- Close the app mid-draft, reopen, draft is there; Fastmail Drafts folder shows one copy, not several.
- Send with two attachments; receive them intact in another client.
- Bundle under 150 kB gzipped including the editor.

## Decisions

- 2026-10-14 — **Reply rules live in the engine** (`Store::reply_init`), tested there: Reply → Reply-To, else
  the sender, and a reply to one's own message goes back to its recipients; Reply-all → Mail-Followup-To when
  present, else sender + To + Cc; the account's address never a recipient (aliases join when `identities`
  exist); References = the original's References + its Message-ID. The UI only writes the quote header, in the
  person's locale. Schema v12 keeps Cc, Reply-To, Mail-Followup-To and References per message (rows from before
  have them empty, so reply-all there falls back to To).
- 2026-10-14 — **Drafts: local first, one server copy.** A `drafts` table (schema v13) holds what compose
  saved; a row for it in the account's Drafts folder (uid NULL until uploaded) makes it show in `g d` and in its
  conversation at once, offline too. The server copy is replaced after 30 s without changes or when compose
  closes (APPEND `\Draft`, then the old copy is deleted by uid; without APPENDUID it is found by Message-ID).
  Versions are counted, not timed. A draft keeps one Message-ID for every copy and the message finally sent;
  discarding keeps the server copy for 30 s (Undo); sending removes it once the send has gone. Undoing a send
  makes it a draft again. A refused send ("550 no such user") opens as a draft from the problems list ("Edit"),
  rather than going back to Drafts on its own.
- 2026-10-14 — **Forwarded attachments come from the server at send time.** The UI never talks to the server,
  and Tern does not keep attachment bytes, so a forward records where the original is (folder, uid,
  UIDVALIDITY, Message-ID) and the sync worker fetches it just before sending; renumbered folders are searched by
  Message-ID; an original that is gone stops the send for the person rather than sending it without them. They
  are all-or-nothing in compose (one chip). Picked and dropped files are copied into
  `app_data/attachments/<stamp>/` (one folder per file, not per draft: a file is added before the draft has an
  id); copies are not cleaned up yet. Attachments are read into memory once at send; no streaming yet.
- 2026-10-15 — **The editor is a separate chunk, 69.8 kB gzipped** (budget 60). ProseMirror's view and model are
  most of it; the schema is already the small one the plan asks for. The app's own bundle stays at 33.1 kB: the
  editor is fetched when the browser is idle after start, so `c` still opens compose at once. App + editor is
  103 kB, under the 150 kB ceiling. Revisit only if it grows.
- 2026-10-15 — **Rich mail is multipart/alternative**: the text part is written from the document (lists as "- ",
  quotes as "> ", links as "text <url>"), not scraped from the HTML. Quotes get inline styles (mail clients drop
  `<style>`). The reply's quote is a real blockquote in the editor, folded behind "···" until opened.
- 2026-10-14 — **No "Send Later" / "Remind me" stubs.** Package 02's scope says future features need not appear as
  placeholders; they arrive with package 05.

## Log

- 2026-10-14 — Slice 1: replies and sending. Reply (`r`), reply-all (`Enter` in a conversation) and forward (`f`)
  are set up by `reply_init`; replies open under the conversation, new mail and forwards in a dialog. Recipient
  chips (Enter, Tab, comma; Backspace takes the last back; pasted lists split; bad addresses marked and stopped
  at send). Cc/Bcc on demand (`Ctrl+Shift+C/B`), Bcc in the envelope only (test). Send `Ctrl+Enter`, Send & Done
  `Ctrl+Shift+Enter` (archives the conversation, one undo for both). "Undo send" setting: off, 5, 10, 20 s. The
  body grows with its text. Not yet: drafts (Esc still drops what was typed), attachments, signatures,
  autocomplete, the rich editor.
- 2026-10-14 — Slice 2: drafts. Compose saves 2 s after typing pauses (only once something changed: a reply's
  prefilled quote alone is not a draft); Esc / Close keeps it ("Draft saved") and uploads it; Discard
  (`Ctrl+Shift+,`) has Undo. Drafts open from `g d` into compose; in a conversation a draft card says "Draft · R
  to continue" and `r` continues it. Tests: store (mirror, versions, removal, undo send, refused send), a scripted
  replace-the-copy check (the scripted server now takes IMAP literals), and the whole life on the dev server:
  one copy in Drafts across saves, none after sending, one in Sent. 89 unit tests, 12 dev-server checks.
- 2026-10-14 — Slice 3: attachments. Attach (`Ctrl+Shift+A`, dialog plugin) or drop files on compose (Tauri's
  drag-drop event); chips with sizes and a total, a warning above 25 MB. MIME multipart/mixed with the text and
  each file; drafts carry their attachments to the server copy too. Forwards carry the original's attachments.
  Checked on the dev server: a 200 kB binary and a UTF-8 text file arrive byte for byte, and a forward of that
  message carries both. 90 unit tests, 13 dev-server checks. Bundle 30.0 kB gzipped.
- 2026-10-15 — Slice 4: signatures and autocomplete. A plain-text signature per account (Settings → Accounts),
  after "-- ", above the quote in replies unless set below; above a forwarded message. `contacts` table (schema
  v14, filled from stored mail by the migration): received mail counts the sender, sent mail (and every queued
  send) its recipients; no-reply style senders are left out. Suggestions under To/Cc/Bcc rank 3·sent + received,
  fading over months, matching the start of the address, the name or a word of it. `store_bench`: 0.09 ms a
  query at 50,000 messages (target < 5 ms). Dev DB: 221 people from existing mail.
- 2026-10-15 — Slice 5: the rich editor. ProseMirror with paragraphs, quotes, lists, breaks; bold, italic,
  underline, strike, code, links. Keys `Ctrl+B/I/U`, `Ctrl+Shift+X` strike, `Ctrl+E` code, `Ctrl+K` link,
  `Ctrl+Shift+7/8/9` lists and quote, `Ctrl+[ ]` list level, `Shift+Enter` line break, undo/redo; typing "- ",
  "1. ", "> " or `code` formats. A format bar over a selection. Keys the editor handles no longer reach the app
  (`Ctrl+K` there is a link, not the palette). Drafts keep the HTML. Checked in headless Chromium; 92 unit tests,
  13 dev-server checks.
- 2026-10-15 — Owner acceptance fixes. Closing the app within 2 s of typing lost the draft: drafts now save locally
  after 0.8 s (the server copy keeps its own debounce) and once more when the window closes (Tauri
  `onCloseRequested`, which needs `core:window:allow-destroy`). Esc straight after undo-send dropped a message
  that had never been saved as a draft: compose reopened by undo starts as unsaved, so Esc keeps it.

