# Sprint 16 — The tide and the companion

**Status:** built, waiting on owner acceptance · started 2026-10-29

## Delivery scope

Expansion, after 1.5.0's look. The owner picked these from the design board "Tern design ideas" (2026-10-29,
https://claude.ai/artifact/4f1kAYtsNMVtvtZjCaSnt6). Each slice is its own branch and PR. AI slices go through
`ai::allowed` like every other AI path: off by default, on request, never in the background.

## Tasks

### A. Moods (themes)
- [x] Three named moods: Dawn (today's light), Dusk (today's dark) and Night Sea (the Inbox Zero navy). System
  still picks Dawn or Dusk from the desktop.
- [x] Follow Omarchy (Linux): read `~/.local/state/omarchy/current/theme/colors.toml`, map it onto the tokens the
  way Omarchy's own T3 Code template does, and change with it when the theme is switched. Only offered when the
  file exists.

### B. Motion
- [x] Actions say where things went: archive, snooze, delete, star and read get a short, calm motion (160 ms,
  none with reduced motion).

### C. The tide (replaces the day screen)
- [x] A morning brief: Needs you, Waiting on others, Came back today, To read with reading times, an overnight
  line. Built from the store on this computer; no AI.

### D. Delight
- [x] A sky that changes: Inbox Zero follows the hour and the season, with the real phase of the moon.
- [x] Wing beat: a soft sound when mail leaves the outbox. Off by default.
- [x] The tide report: on Sunday, how much came in, how fast it was cleared, the quietest day. Local, no streaks.

### E. Reading
- [x] Only what's new: in a long conversation each reply shows its new text; quoted history folds into a line.
- [x] Who fills your inbox: senders by volume over 30 days, with unsubscribe (List-Unsubscribe) or "always to
  Other".

### F. The companion column
- [x] A right column beside the conversation (`Ctrl+.`), docked in a wide window: Ask, Person, Promises, Files.
- [x] Ask: chat about the open conversation with context chips, answers that cite messages, chats kept per
  conversation, and a "what was sent" receipt. Behind the AI switch.
- [x] Person, Files: from the store only, no AI.
- [x] Promises: what you owe and what is owed to you, found locally by phrases; tick when done.

### G. Writing with AI
- [x] Bullets to a draft: `Ctrl+J` turns bullets into a draft in the style note, shown as ghost text; Tab keeps it,
  Esc drops it.
- [x] Tone dial: Shorter, Warmer, Firmer, shown as a change to accept or drop.

## Decisions

- The Linux title bar change (frameless, no window buttons) went first, on `sprint/16-linux-titlebar`; this
  package's branches stack on it until it is merged.

- Ask goes through the summaries switch (`Feature::Summaries`): asking about a conversation is reading it, and a
  separate switch would need a settings change for little gain. Chats are kept in memory per conversation while
  Tern runs, not in the store; keeping them across restarts can follow if the owner wants it (a table, a migration).

## Log

- 2026-10-29: Package written from the owner's picks on the design board. Started slice A.
- 2026-10-29: Slice A done: moods and Follow Omarchy, tried in `tauri dev` on Hyprland with the Evergreen theme
  (Omarchy) and Night Sea. A live theme switch was not tried: it would change the owner's desktop.
- 2026-10-29: Slice B done: motion on actions, tried with `npm run dev` (fake mailbox) in headless Chromium, frames
  caught mid-archive and after a star. Not on the real dev store: archiving there reaches the owner's server.
- 2026-10-29: Slice C done: the tide replaces the day screen; `day_start` gains `to_read` (shelf, then lists since,
  with minutes). Tried with `npm run dev` in headless Chromium: Dawn after dark, Dusk, Night Sea and 760 px wide.
  Source Serif 4 600 is bundled (21 kB woff2) for its headings.
- 2026-10-29: Slice D done: Horizon by hour, moon phase and winter snow (`src/sky.ts`, tested); the tide report on
  Sundays (`arrivals` in the store, tested; `src/tide.ts`, tested); the wing beat (Web Audio, off by default). Sky
  and report tried with the fake mailbox in headless Chromium at fixed times; the sound was not heard (headless).
- 2026-10-29: Slice E done: the catch-up line and tucked older lines (`src/catchup.ts`, tested; the fake mailbox's
  `#long` has nine-message conversations to try them on) and Settings → Who writes most (`senders` in the store,
  tested; List-Unsubscribe parsing moved to `src/unsubscribe.ts`). Tried with the fake mailbox in headless Chromium.
- 2026-10-29: Slice F done: the companion with Ask (`ai::ask_about` and `prompts/ask.md`, tested against the
  scripted model incl. AI off), Person, Promises (`src/promises.ts`, tested) and Files. Tried with the fake mailbox
  in headless Chromium at 1440 and 1100 px; not against a real model.
- 2026-10-29: Slice G done on top of package 10's Write with AI rather than a second path: "Write out these points"
  for a draft of points, Warmer and Firmer asks (Friendlier became Warmer), a tone row in the footer, and the
  change shown as a word diff (`src/wordDiff.ts`, tested). Tried with the fake mailbox in headless Chromium. Every
  task in the package is ticked; owner acceptance is open.
