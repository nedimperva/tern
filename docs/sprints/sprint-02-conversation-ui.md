# Sprint 2 — Conversation list and the Superhuman shell

**Status:** in progress · started 2026-10-14

## Delivery scope

**M1 — Linux private alpha.** Deliver conversations, predictable focus/selection, core keyboard actions, command palette, safe HTML and readable themes. Future-feature commands need not appear as nonfunctional placeholders. Advanced layout polish is not an alpha blocker.

Package number is a stable ID, not a delivery week. [PLAN.md](../PLAN.md) defines order and release gates.

## Overview

The app starts to look and feel like the product. One row per conversation, the full
keyboard model, a real command palette, light and dark, and a perf overlay that keeps us honest.

See `docs/research/superhuman-reference.md` for the patterns we are matching.

## Goal

Someone who uses Superhuman can sit down at Tern and triage an inbox without touching the mouse or reading
the help: `j`/`k`, `e`, `h` (placeholder until Sprint 5), `s`, `u`, `#`, `Enter`, `Esc`, `Cmd+K`, `/`, `g i`.

## Tasks

### Design system
- [x] CSS custom properties for colour, spacing, radius, type scale, motion. Two themes (`light`, `dark`), follow
      the system by default (`prefers-color-scheme`), override in settings. Omarchy sets the GTK theme; we only
      follow light/dark, not the palette.
- [x] Bundle Inter (variable) and JetBrains Mono as `woff2`; set `font-feature-settings: "cv11", "ss01"`
      for Inter's single-storey a and open digits (closest to Superhuman's feel).
- [x] Type scale: 13 px list, 14 px reading, 12 px meta; line-height 1.4; row height 36 px (dense) / 44 px (comfortable).
- [x] Motion: 120 ms ease-out for list moves, 160 ms for panels, none when `prefers-reduced-motion`.
- [x] Icon set: Lucide (tree-shaken, inline SVG). No icon font.

### Layout
- [x] Three regions: a slim left rail (hidden by default, `Cmd+\` to toggle) with accounts and labels; the list;
      the conversation pane. List is full-width when nothing is open; `Enter` opens the conversation to the
      right (split) or full (setting); `Esc` returns to the list.
- [x] Split tabs across the top of the list (`Tab` / `Shift+Tab`). Sprint 2 ships "Inbox" and "Starred"; Sprint 5 adds Important/Other/custom.
- [ ] Empty state: a full-bleed background image with the time and "You're done" — Inbox Zero is a feature.
- [ ] Status strip, bottom right: sync state from Sprint 1, undo toast, keyboard hints after 2 s of inactivity.

### Conversation list
- [x] One row per thread from the `threads` table: participants (bold if unread, "me" for the account), count badge,
      subject, snippet in muted colour on the same line, date right-aligned (`14:02` today, `Mon`, `12 Mar`, `2024`),
      star and attachment glyphs, label chips (max 2 + "+n").
- [x] Virtualised with fixed row height (existing `VirtualList`, extend with overscan and `scrollIntoView` logic
      that keeps the selection inside the middle 60 % of the viewport).
- [x] Selection model: focused row + multi-select (`x`, `Shift+J`/`Shift+K` extend, `Cmd+A`, `Esc` clears).
      Actions apply to the selection if non-empty, else the focused row.
- [x] Keyset paging on `(last_date, thread_id)`; prefetch the next page when within 50 rows of the end.
- [x] After an action removes rows, focus moves to the next row (not the previous), like Superhuman.

### Conversation pane
- [x] Messages as cards, oldest first, all but the last collapsed to one line (sender, snippet, date). `o` or `Enter` expands; `Shift+O` expands all; `n`/`p` move between messages.
- [x] Sanitised HTML (Rust `ammonia` at insert time, allowlist with inline styles kept, scripts/forms/iframes dropped)
      rendered in `<iframe sandbox>` with a CSP that blocks remote loads until "Load images" (per sender remember).
- [x] Quoted text collapsed behind "···"; signature heuristics (`-- `, "Sent from") collapsed too.
- [x] Attachments strip at the bottom of each message (viewer in Sprint 7).
- [x] Reading marks the thread read after 1 s in view (setting: immediately / after 1 s / manually).

### Keyboard model
- [x] Central key map (`src/keys.ts`): context (`list | thread | compose | palette | search`), chord support (`g i`), platform modifier (`Ctrl` on Linux/Windows shown as `Ctrl`, map `Cmd` in docs).
- [ ] Implement the Superhuman set for list and thread (full table in `superhuman-reference.md`):
      `j k Enter Esc e Shift+E s u # ! m x Shift+J Shift+K Cmd+A Cmd+K / z r Enter(reply-all) f c n p o Shift+O Tab Shift+Tab g+i g+s g+d g+t g+e g+a g+l Cmd+\ ? Cmd+, Cmd+1..9`.
- [x] `?` opens a searchable shortcut sheet.
- [x] Every action in the palette shows its key; every key is discoverable through the palette.

### Command palette (`Cmd+K`)
- [x] Fuzzy matcher (own, ~60 lines; no dependency) ranking by prefix, word-start, then subsequence.
- [ ] Commands: all actions, "Go to label …", "Move to …", "Label …", "Switch account …", "Theme …", "Settings".
- [ ] Recent commands first; arrow keys and `Enter`; argument mode for move/label with the same list.

### Settings
- [x] `settings` table (key/value JSON) in SQLite, `settings.ts` signal store, settings pane reachable with `Cmd+,`.
- [x] Sprint 2 keys: theme, density, open-conversation mode, mark-read delay, load-images-default.

### Perf overlay
- [x] `Cmd+Shift+P` toggles an overlay with last keypress → paint time, list query time (from the command reply), FPS, and bundle size at build.
- [x] Log a warning in dev when any of the Sprint targets is exceeded.

## Cut first
Label chips on rows, then the empty-state artwork (use a solid colour), then `Cmd+1..9` account switching.

## Acceptance
- Triage 50 real conversations with keys only; nothing requires the mouse.
- Record `j`/`k` input-to-visible-response p50/p95 on a 10,000-thread list, including during sync; verify no visible lag/focus jumps. Do not equate handler duration with paint.
- Light and dark both pass a contrast check (WCAG AA on text).
- Bundle under 120 kB gzipped (editor not yet included).

## Decisions

- 2026-10-14 — **Meta grey darker than the spec.** `--fg-2` is `#686871` light / `#8d8d96` dark instead of
  `#a1a1aa` / `#71717a`, which are 2.6:1 and 3.9:1 on the list background; the new values are ≥ 4.5:1 on every
  row background (plain, hover, focused, selected), as §6 asks. `docs/design/ui.md` keeps the table; the tokens
  file notes the change.
- 2026-10-14 — **Conversation rows come from `Store::list_threads`**, computed per page (package 01 decided
  against a `threads` table). Actions on a row go through `apply_conversations`: Done and Trash take the
  conversation's messages in the folder being viewed, read/unread the whole conversation, a star the newest
  message, unstar every star in it. Search results stay message rows (one per hit), shown in the same row.

- 2026-10-14 — **Icons inlined, not imported.** `lucide-solid` tree-shook to the three icons used but still added
  4.7 kB gzipped (its icon component and helpers). The path data is copied from Lucide (ISC, credited in
  `src/components/Icon.tsx`); a new icon is a new entry there.

## Log

- 2026-10-14 — Slice 1: conversation list and pane. Tokens (`src/styles/tokens.css`, old names aliased), one
  36 px row per conversation (participants with first names and "me", count, subject and snippet, star and
  attachment glyphs, date as time / weekday / day month / year), focus bar, selection (`x`, `Shift+J/K`,
  `Ctrl+A`, Esc clears), focus to the next row after Done/Trash, middle-60 % scrolling, next page within 50 rows.
  `Enter` opens the conversation beside the list (≥ 1200 px; the list drops snippets) or over it; `j/k` move to
  the next conversation while one is open; cards collapse to a line except the newest and unread ones; `n/p`,
  `o`, `Shift+O`; read after 1 s. Folders moved to a slide-over rail (`Ctrl+\`). Status strip: sync sentence,
  problems link, selection count, undo toast. Inbox Zero: time and "You're done." on a soft gradient. Central
  key table `src/keys.ts` with contexts and `g` chords; the palette lists it. Checked in headless Chromium with
  keys only (light/dark, 1440 and 1000 px). Bundle 19.6 kB gzipped. Not yet: split tabs, label chips, sanitised
  HTML and quote folding, attachments strip, settings, fonts, shortcut sheet, palette ranking, perf overlay.
- 2026-10-14 — Slice 2: keys and palette. Inbox / Starred split tabs (`Tab`, `Shift+Tab`; Starred = starred mail
  in the inboxes, `ListTarget::Role("starred")`, Done from it takes the conversation out of the inbox). `g` chords
  for Inbox, Starred, Done, Sent, Drafts, All Mail. `?` sheet, searchable, grouped by where keys work. Palette:
  own fuzzy ranking (prefix, then word starts, then letters in order) with matches marked, Recent first (last 8,
  window storage), groups (Recent, Actions, Go to, Accounts), chords as two keycaps. Status strip shows three
  keys for the current context after 2 s without a keypress. Not yet: argument mode (Move to …, Label …), which
  needs a move-to-folder action in the engine; `!` (spam) and `m` (mute) likewise.
- 2026-10-14 — Slice 3: settings, type, perf. `settings` table (schema v9) behind `settings`/`set_setting`;
  `Ctrl+,` opens Appearance (theme, density) and Reading (open mode, mark-read delay, remote images); changes
  apply and save at once. Inter (variable) and JetBrains Mono bundled from Fontsource (OFL); only the scripts
  in use are downloaded. `Ctrl+Shift+P` shows key → paint (from the event's timestamp to the first painted
  frame after the handler), last list query, fps; slow ones warn in dev. Measured in headless Chromium on the
  browser fake with about 10,000 conversations, 201 real key events (j, then k): key → paint p50 23.2 ms, p95
  33.0 ms. Still to do for the acceptance check: the same in the Tauri window during a sync. Migration tests now
  wind a current database back with one helper (`wind_back`). Bundle 23.5 kB gzipped JS.
- 2026-10-14 — Slice 4: safe HTML, folding, attachments. Mail HTML goes through `ammonia` when stored
  (`mime::sanitize_html`: scripts, handlers, forms, frames, objects and `javascript:` out; inline styles,
  `<style>` blocks, table attributes, `class`, `cid:`/`data:` images kept); schema v10 cleans what was stored
  before (dev DB: no `<script>` left). Still rendered in the sandboxed, script-free frame with its CSP. Quoted
  replies (Gmail, Apple, Outlook, Yahoo, Proton containers; "On … wrote:", "Original Message", `>` blocks) and
  signatures (`-- `, "Sent from my …") fold behind a `···` pill. Attachment chips (name, size) under each
  message, from BODYSTRUCTURE or the parsed body (`messages.parts`). "Always for this sender" remembers senders
  whose images load (`imagesFrom` setting). 79 unit tests, 11 dev-server checks pass. Bundle 24.8 kB gzipped.
