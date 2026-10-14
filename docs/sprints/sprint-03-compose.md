# Sprint 3 — Compose

**Status:** in progress · started 2026-10-14

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
- [ ] ProseMirror core (`prosemirror-model`, `-state`, `-view`, `-schema-basic`, `-keymap`, `-history`,
      `-inputrules`) with a small schema: paragraph, bold, italic, underline, strike, link, bullet/ordered list,
      blockquote, code (inline), hard break. No tables, no headings, no colours in v1.
- [ ] Keys: `Cmd+B/I/U`, `Cmd+K` link, `Cmd+Shift+7/8` lists, `Cmd+Shift+9` quote, `Cmd+Z/Shift+Z`, `Cmd+[ ]` indent.
      Markdown input rules: `*`, `-`, `1.`, `>`, backticks.
- [ ] Serialise to HTML (inline-styled where mail clients need it) and a plain-text alternative (`text/plain` from the doc, not from the HTML).
- [ ] Paste: strip Word/Docs styles down to the schema; paste images as attachments (inline `cid:` later).
- [ ] Bundle budget for the editor: 60 kB gzipped. Measure.

### Compose surface
- [x] Inline at the bottom of the conversation for replies, a centred modal for new mail; `Cmd+Shift+O` pops out to its own window later (backlog).
- [ ] Fields: From (account picker if > 1), To, Cc, Bcc (hidden until `Cmd+Shift+C/B`), Subject. `Tab` between fields; `Esc` closes (keeps the draft).
- [x] Recipient chips; `Backspace` on an empty field edits the last chip; invalid addresses highlighted; paste a list of addresses splits them.
- [ ] "Send & Mark Done", "Send Later" (stub until Sprint 5), "Remind me" (stub until Sprint 5) in a footer with their keys.

### Reply, reply-all, forward (core; rich quoting follows editor slice)
- [x] Reply-all excludes our own addresses (all aliases from the account), honours `Reply-To`, `Mail-Followup-To`.
- [ ] Quote header `On <date>, <name> <<addr>> wrote:` then `<blockquote>` of the original HTML (sanitised) or text; collapsed in the editor behind "···", editable on click.
- [ ] Forward includes original attachments; subject `Fwd:`; original headers block.
- [x] Threading headers: `In-Reply-To`, `References` appended; `Message-ID` generated as `<uuid@tern>` (host part from the account domain).

### Drafts
- [ ] Autosave to SQLite every 2 s of idle typing (`drafts` table: account, thread_id, fields JSON, doc JSON, attachments, updated).
- [ ] Sync to the server's Drafts folder as RFC 5322 via `APPEND` with `\Draft`, replacing the previous UID (delete old after the new one lands). Debounced to 30 s and on close.
- [ ] Drafts appear in the list (`g d`) and inline in the conversation they belong to; `Enter` reopens.
- [ ] Discard: `Cmd+Shift+,` with undo.

### Attachments
- [ ] File picker (`Cmd+Shift+A`) via `tauri-plugin-dialog`; drag and drop onto compose from the file manager (`tauri://drag-drop` event).
- [ ] Attachments stored in `app_data/attachments/<draft-id>/`; size total shown; warn over 25 MB.
- [ ] Build MIME with `lettre`'s `MessageBuilder` and `MultiPart::mixed/alternative`; stream large files, don't read into memory twice.

### Sending
- [ ] Send puts an `Outbox::Send` op with `not_before = now + undo window` (setting: 0/5/10/20 s). Toast with "Undo".
- [ ] SMTP via `lettre` (rustls). On permanent failure (5xx) the message returns to Drafts with the error shown; on 4xx retry with backoff.
- [ ] Copy to Sent via `APPEND` when the preset says the server does not (Fastmail does; Gmail does; most others don't).
- [ ] Sent conversation is marked done (archived) when "Send & Mark Done" was used.

### Signatures and identity
- [ ] Per-account signature (ProseMirror doc), inserted above the quote; setting to place below.
- [ ] Aliases per account (`identities` table): name, address, signature; "From" picker lists them.

### Recipient autocomplete
- [ ] `contacts` table built from headers as mail syncs: `email, name, sent_count, received_count, last_seen`.
- [ ] Ranking: `3·sent + 1·received`, decayed by recency; prefix match on name parts and email.
- [ ] Popup under the field, `↑/↓/Enter/Tab`, < 5 ms per keystroke (SQLite index on `email`, `name` collate nocase).

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
