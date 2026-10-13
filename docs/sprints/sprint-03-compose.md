# Sprint 3 — Compose

**Week 4.** Writing mail should be as fast as reading it. Rich text that stays out of the way, replies
that quote correctly, drafts that survive, attachments, signatures, autocomplete.

## Goal

`c` opens compose in under 50 ms with the cursor in **To**. `r` / `Enter` / `f` open reply, reply-all,
forward with correct recipients and quoting. `Cmd+Enter` sends with undo; `Cmd+Shift+Enter` sends and
marks done. Drafts land in the server's Drafts folder.

## Tasks

### Editor
- [ ] ProseMirror core (`prosemirror-model`, `-state`, `-view`, `-schema-basic`, `-keymap`, `-history`,
      `-inputrules`) with a small schema: paragraph, bold, italic, underline, strike, link, bullet/ordered list,
      blockquote, code (inline), hard break. No tables, no headings, no colours in v1.
- [ ] Keys: `Cmd+B/I/U`, `Cmd+K` link, `Cmd+Shift+7/8` lists, `Cmd+Shift+9` quote, `Cmd+Z/Shift+Z`, `Cmd+[ ]` indent.
      Markdown input rules: `*`, `-`, `1.`, `>`, backticks.
- [ ] Serialise to HTML (inline-styled where mail clients need it) and a plain-text alternative (`text/plain` from the doc, not from the HTML).
- [ ] Paste: strip Word/Docs styles down to the schema; paste images as attachments (inline `cid:` later).
- [ ] Bundle budget for the editor: 60 kB gzipped. Measure.

### Compose surface
- [ ] Inline at the bottom of the conversation for replies, a centred modal for new mail; `Cmd+Shift+O` pops out to its own window later (backlog).
- [ ] Fields: From (account picker if > 1), To, Cc, Bcc (hidden until `Cmd+Shift+C/B`), Subject. `Tab` between fields; `Esc` closes (keeps the draft).
- [ ] Recipient chips; `Backspace` on an empty field edits the last chip; invalid addresses highlighted; paste a list of addresses splits them.
- [ ] "Send & Mark Done", "Send Later" (stub until Sprint 5), "Remind me" (stub until Sprint 5) in a footer with their keys.

### Reply, reply-all, forward
- [ ] Reply-all excludes our own addresses (all aliases from the account), honours `Reply-To`, `Mail-Followup-To`.
- [ ] Quote header `On <date>, <name> <<addr>> wrote:` then `<blockquote>` of the original HTML (sanitised) or text; collapsed in the editor behind "···", editable on click.
- [ ] Forward includes original attachments; subject `Fwd:`; original headers block.
- [ ] Threading headers: `In-Reply-To`, `References` appended; `Message-ID` generated as `<uuid@tern>` (host part from the account domain).

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
