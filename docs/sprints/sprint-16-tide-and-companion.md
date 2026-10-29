# Sprint 16 — The tide and the companion

**Status:** in progress · started 2026-10-29

## Delivery scope

Expansion, after 1.5.0's look. The owner picked these from the design board "Tern design ideas" (2026-10-29,
https://claude.ai/artifact/4f1kAYtsNMVtvtZjCaSnt6). Each slice is its own branch and PR. AI slices go through
`ai::allowed` like every other AI path: off by default, on request, never in the background.

## Tasks

### A. Moods (themes)
- [ ] Three named moods: Dawn (today's light), Dusk (today's dark) and Night Sea (the Inbox Zero navy). System
  still picks Dawn or Dusk from the desktop.
- [ ] Follow Omarchy (Linux): read `~/.local/state/omarchy/current/theme/colors.toml`, map it onto the tokens the
  way Omarchy's own T3 Code template does, and change with it when the theme is switched. Only offered when the
  file exists.

### B. Motion
- [ ] Actions say where things went: archive, snooze, delete, star and read get a short, calm motion (160 ms,
  none with reduced motion).

### C. The tide (replaces the day screen)
- [ ] A morning brief: Needs you, Waiting on others, Came back today, To read with reading times, an overnight
  line. Built from the store on this computer; no AI.

### D. Delight
- [ ] A sky that changes: Inbox Zero follows the hour and the season, with the real phase of the moon.
- [ ] Wing beat: a soft sound when mail leaves the outbox. Off by default.
- [ ] The tide report: on Sunday, how much came in, how fast it was cleared, the quietest day. Local, no streaks.

### E. Reading
- [ ] Only what's new: in a long conversation each reply shows its new text; quoted history folds into a line.
- [ ] Who fills your inbox: senders by volume over 30 days, with unsubscribe (List-Unsubscribe) or "always to
  Other".

### F. The companion column
- [ ] A right column beside the conversation (`Ctrl+.`), docked in a wide window: Ask, Person, Promises, Files.
- [ ] Ask: chat about the open conversation with context chips, answers that cite messages, chats kept per
  conversation, and a "what was sent" receipt. Behind the AI switch.
- [ ] Person, Files: from the store only, no AI.
- [ ] Promises: what you owe and what is owed to you, found locally by phrases; tick when done.

### G. Writing with AI
- [ ] Bullets to a draft: `Ctrl+J` turns bullets into a draft in the style note, shown as ghost text; Tab keeps it,
  Esc drops it.
- [ ] Tone dial: Shorter, Warmer, Firmer, shown as a change to accept or drop.

## Decisions

- The Linux title bar change (frameless, no window buttons) went first, on `sprint/16-linux-titlebar`; this
  package's branches stack on it until it is merged.

## Log

- 2026-10-29: Package written from the owner's picks on the design board. Started slice A.
