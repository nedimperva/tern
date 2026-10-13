# Sprint 2 — Conversation list and the Superhuman shell

**Status:** todo

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
- [ ] CSS custom properties for colour, spacing, radius, type scale, motion. Two themes (`light`, `dark`), follow
      the system by default (`prefers-color-scheme`), override in settings. Omarchy sets the GTK theme; we only
      follow light/dark, not the palette.
- [ ] Bundle Inter (variable) and JetBrains Mono as `woff2`; set `font-feature-settings: "cv11", "ss01"`
      for Inter's single-storey a and open digits (closest to Superhuman's feel).
- [ ] Type scale: 13 px list, 14 px reading, 12 px meta; line-height 1.4; row height 36 px (dense) / 44 px (comfortable).
- [ ] Motion: 120 ms ease-out for list moves, 160 ms for panels, none when `prefers-reduced-motion`.
- [ ] Icon set: Lucide (tree-shaken, inline SVG). No icon font.

### Layout
- [ ] Three regions: a slim left rail (hidden by default, `Cmd+\` to toggle) with accounts and labels; the list;
      the conversation pane. List is full-width when nothing is open; `Enter` opens the conversation to the
      right (split) or full (setting); `Esc` returns to the list.
- [ ] Split tabs across the top of the list (`Tab` / `Shift+Tab`). Sprint 2 ships "Inbox" and "Starred"; Sprint 5 adds Important/Other/custom.
- [ ] Empty state: a full-bleed background image with the time and "You're done" — Inbox Zero is a feature.
- [ ] Status strip, bottom right: sync state from Sprint 1, undo toast, keyboard hints after 2 s of inactivity.

### Conversation list
- [ ] One row per thread from the `threads` table: participants (bold if unread, "me" for the account), count badge,
      subject, snippet in muted colour on the same line, date right-aligned (`14:02` today, `Mon`, `12 Mar`, `2024`),
      star and attachment glyphs, label chips (max 2 + "+n").
- [ ] Virtualised with fixed row height (existing `VirtualList`, extend with overscan and `scrollIntoView` logic
      that keeps the selection inside the middle 60 % of the viewport).
- [ ] Selection model: focused row + multi-select (`x`, `Shift+J`/`Shift+K` extend, `Cmd+A`, `Esc` clears).
      Actions apply to the selection if non-empty, else the focused row.
- [ ] Keyset paging on `(last_date, thread_id)`; prefetch the next page when within 50 rows of the end.
- [ ] After an action removes rows, focus moves to the next row (not the previous), like Superhuman.

### Conversation pane
- [ ] Messages as cards, oldest first, all but the last collapsed to one line (sender, snippet, date). `o` or `Enter` expands; `Shift+O` expands all; `n`/`p` move between messages.
- [ ] Sanitised HTML (Rust `ammonia` at insert time, allowlist with inline styles kept, scripts/forms/iframes dropped)
      rendered in `<iframe sandbox>` with a CSP that blocks remote loads until "Load images" (per sender remember).
- [ ] Quoted text collapsed behind "···"; signature heuristics (`-- `, "Sent from") collapsed too.
- [ ] Attachments strip at the bottom of each message (viewer in Sprint 7).
- [ ] Reading marks the thread read after 1 s in view (setting: immediately / after 1 s / manually).

### Keyboard model
- [ ] Central key map (`src/keys.ts`): context (`list | thread | compose | palette | search`), chord support (`g i`), platform modifier (`Ctrl` on Linux/Windows shown as `Ctrl`, map `Cmd` in docs).
- [ ] Implement the Superhuman set for list and thread (full table in `superhuman-reference.md`):
      `j k Enter Esc e Shift+E s u # ! m x Shift+J Shift+K Cmd+A Cmd+K / z r Enter(reply-all) f c n p o Shift+O Tab Shift+Tab g+i g+s g+d g+t g+e g+a g+l Cmd+\ ? Cmd+, Cmd+1..9`.
- [ ] `?` opens a searchable shortcut sheet.
- [ ] Every action in the palette shows its key; every key is discoverable through the palette.

### Command palette (`Cmd+K`)
- [ ] Fuzzy matcher (own, ~60 lines; no dependency) ranking by prefix, word-start, then subsequence.
- [ ] Commands: all actions, "Go to label …", "Move to …", "Label …", "Switch account …", "Theme …", "Settings".
- [ ] Recent commands first; arrow keys and `Enter`; argument mode for move/label with the same list.

### Settings
- [ ] `settings` table (key/value JSON) in SQLite, `settings.ts` signal store, settings pane reachable with `Cmd+,`.
- [ ] Sprint 2 keys: theme, density, open-conversation mode, mark-read delay, load-images-default.

### Perf overlay
- [ ] `Cmd+Shift+P` toggles an overlay with last keypress → paint time, list query time (from the command reply), FPS, and bundle size at build.
- [ ] Log a warning in dev when any of the Sprint targets is exceeded.

## Cut first
Label chips on rows, then the empty-state artwork (use a solid colour), then `Cmd+1..9` account switching.

## Acceptance
- Triage 50 real conversations with keys only; nothing requires the mouse.
- Record `j`/`k` input-to-visible-response p50/p95 on a 10,000-thread list, including during sync; verify no visible lag/focus jumps. Do not equate handler duration with paint.
- Light and dark both pass a contrast check (WCAG AA on text).
- Bundle under 120 kB gzipped (editor not yet included).

## Decisions

_None yet._

## Log

_No sessions yet._
