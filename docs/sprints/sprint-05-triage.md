# Sprint 5 — Triage: split inbox, snooze, reminders, send later

**Status:** in progress (follow-ups and send later) · started 2026-10-15

## Delivery scope

**M2 basics; advanced automation later.** Required for beta: simple Important/Other splits, manual correction and snooze/reminders with explicit app-closed limitations. Advanced rule builders, unsubscribe automation, mute, follow-up automation and send-later can be staged later. They do not block Windows. Acceptance applies only to the selected slice.

Package number is a stable ID, not a delivery week. [PLAN.md](../PLAN.md) defines order and release gates.

## Overview

The features that make Superhuman Superhuman.

## Goal

The inbox is split into Important and Other by default with custom splits on top; `h` snoozes with
natural-language times; sent mail can carry a follow-up reminder; `Cmd+Shift+L` sends later; `Cmd+U`
unsubscribes; `m` mutes. All of it works offline and syncs when back.

## Tasks

### Rules engine (`tern-core::rules`)
- [ ] Rule = ordered list of conditions on a message/thread → actions. Conditions: `from` (address, domain, contact group),
      `to`, `subject`, `has_header` (`List-Unsubscribe`, `List-Id`, `Precedence: bulk`), `has_attachment`,
      `is_calendar_invite` (`text/calendar` part), `label`, `account`. Actions: `split`, `label`, `archive`, `mark_read`, `mute`.
- [ ] Evaluated at insert time and on demand (re-run when rules change, in a background pass).
- [ ] Rule results cached in `thread_splits (thread_id, split_id)`; the list query joins on it. No per-row evaluation at render time.
- [ ] Tests: a fixture of 30 headers, expected splits.

### Split inbox
- [ ] Default splits: **Important** (everything not matched below), **Other** (newsletters: `List-Unsubscribe` or `Precedence: bulk`; notifications: known no-reply senders; social: a small domain list), **Calendar** (invites), **Team** (same domain as the account, off for consumer domains).
- [ ] Gmail: use `\Important` and the category labels (`CATEGORY_PROMOTIONS` etc. appear as labels over IMAP only when the user enabled them; otherwise fall back to our rules).
- [ ] Custom splits in Settings: name, rule builder, colour, position. `Tab`/`Shift+Tab` cycle; `Cmd+Shift+Tab` picks by palette.
- [ ] "Move to Important/Other" on a conversation teaches the rule (adds a sender exception), like Superhuman.
- [ ] Split counts in the tabs (unread), updated from the `threads` table, not by counting rows.

### Snooze / Remind me (`h`)
- [x] Picker with presets (Later today, Tomorrow, This weekend, Next week, Pick a time) and a text field that
      parses `3h`, `tomorrow 9am`, `mon`, `in 2 days`, `dec 3` (own parser, ~150 lines, tested).
- [x] `reminders` table: `thread_id, due, kind (snooze | followup), note, created`.
- [ ] Snoozed threads leave the inbox: plain IMAP → move to a `Tern/Snoozed` folder (created on first use);
      Gmail → `-\Inbox +Tern/Snoozed` label. Both are reversible without data loss if the user stops using Tern.
- [ ] A scheduler in the sync worker fires due reminders: move back to Inbox, mark unread, add a `\Flagged`-free "Reminder" chip, notify (Sprint 8 adds OS notifications).
- [x] `g h` shows Reminders sorted by due; `Shift+H` un-snoozes.

### Follow-up reminders on send
- [x] In compose: "Remind me if no reply in … " (`Cmd+Shift+H`). Stores a `followup` reminder keyed on the sent thread.
- [x] Cancelled automatically when a reply arrives in that thread from someone else.
- [x] Due → the thread returns to the inbox with a "No reply yet" chip.

### Send later
- [x] `Cmd+Shift+L` in compose → same time picker → `Outbox::Send` with `not_before`. Shows under `g d` with a clock chip; editable; cancellable.
- [x] Sends happen only while Tern runs (local-first, no server). Say so in the UI. If the time passed while Tern was closed, send on next launch after a confirm.

### Unsubscribe and mute
- [ ] `Cmd+U`: RFC 8058 one-click (`List-Unsubscribe-Post: List-Unsubscribe=One-Click`) via HTTPS POST; else `mailto:` → send an unsubscribe mail; else open the URL. Then archive and offer "Also block sender".
- [ ] `m` mute: `muted_threads` table; new messages in a muted thread skip the inbox (archived on arrival). Gmail has a `\Muted`-like behaviour via its own label; we keep ours.
- [ ] Block sender: a rule that archives + marks read.

### Mass actions
- [ ] "Mark all as done" in a split (palette), with a confirm and a single undo token for the batch.
- [ ] `Shift+J`/`Shift+K` selection + action already from Sprint 2; make batch outbox ops one row per 100 UIDs to keep the server happy.

## Cut first
Team split, "teaches the rule" from Move, RFC 8058 POST (keep mailto/URL).

## Acceptance
- A real inbox with 200 conversations lands mostly right in Important/Other without configuration; fixing five mis-splits sticks.
- Snooze to +2 minutes; the thread leaves and returns, unread, in both Tern and the server's view.
- Send-later a message to yourself for +2 minutes; it arrives then.
- Unsubscribe from a real newsletter via one-click; no further mail (verify the next day).

## Decisions

- 2026-10-15 — **Two splits from headers, no rules engine yet.** Important and Other. Other is mail with `List-Id`,
  `List-Unsubscribe`, `Precedence: bulk|list|junk`, or from a noreply-style address (`triage::is_bulk`, kept as
  `messages.bulk`). "Move sender to Other/Important" (Ctrl+K) records the sender (`sender_splits`), which wins for
  its past and future mail. The split is per message, so a conversation answered by a person after a newsletter
  shows in Important. Custom splits, the Calendar and Team splits and Gmail's categories wait for the rules engine.
  Notifications only come for Important. Settings → Reading → Inbox turns the splits off.
- 2026-10-15 — **Snooze is Tern's alone, for now.** Planned: move to a `Tern/Snoozed` folder. Built: the
  conversation stays in the server's inbox and leaves Tern's lists while a `reminders` row exists. No folder to
  create, no hierarchy delimiter to guess, nothing to undo on the server. Other mail apps still show it in the inbox,
  and it comes back only while Tern runs (at the next start if it fell due while closed); the picker says so. Coming
  back marks it unread (through the outbox) and notifies; a reply from someone else brings it back early.
  `h` snoozes, `Shift+H` brings it back now, `g h` lists snoozed conversations with their time. The time reader is
  `triage::when` in the engine, with tests.

- 2026-10-19 — **Follow-ups and send later, selected by the owner** (rest of package 05's M2 scope). Not in it:
  unsubscribe, block sender, mass actions, the rules engine.
- 2026-10-19 — **A follow-up waits on the sent message's Message-ID.** Which conversation a new message joins is
  only known once its copy in Sent is here (References, else the subject), so the `reminders` row keeps the bare
  Message-ID (schema v19, `message_id`) and finds the conversation through it. It is cancelled when anyone but
  the account writes in that conversation after the send, and dropped if the send is undone or discarded.
- 2026-10-19 — **"Returns to the inbox" is a pinned row.** The conversation lives in Sent, not the inbox folder, so
  a due follow-up is shown at the top of the inbox and Important (first page only) with "No reply yet", announced
  once ("No reply yet: subject"). Done (`e`) or the notification's Archive dismisses it; a reply cancels it.
  Nothing changes on the server.
- 2026-10-19 — **Send later is an outbox send with its time** (`outbox.scheduled`). Picking a time sends at once
  (Undo still works in its window). "N scheduled" in the status strip opens the list with Send now and Edit
  (back to a draft). Planned: shown under `g d` with a clock chip; built: the strip and the review dialog, where
  waiting work already lives. At start, a scheduled send more than a minute overdue is **held**
  (`outbox.held`): "1 scheduled send to confirm" until Send now or Edit, so nothing goes out hours late unasked.
- 2026-10-19 — Compose's footer says **Later** and **Remind** (single words like Attach, Cc, Bcc; the full names
  are in the tooltips, the pickers' titles and the shortcuts): two two-word buttons did not fit at 720 px.

## Log

- 2026-10-15 — M2 basics: Important/Other splits (schema v16), sender moves, local snooze with the picker and time
  reader, Snoozed list, split unread counts on the tabs. Conversation lists of a role (the inbox, a split) now scan
  in pages with a LIMIT: without one SQLite sorted the whole inbox first, about 45 ms per page at 50k messages
  (`store_bench`: unified inbox and Important now under 1 ms). An empty Other split on a large inbox still walks the
  whole inbox (35 ms in the bench, which has no bulk mail); split unread counts cost about 22 ms in the bench, where
  three quarters of 50k messages are unread. UI tried against the fake mailbox in headless Chromium, light and dark.
  Not built: rules engine, custom splits, follow-up reminders, send later, unsubscribe, mass actions.
- 2026-10-19 — Follow-ups and send later. Engine: schema v19 (`outbox.scheduled/held`, `reminders.message_id/fired`),
  `queue_send_at`, `hold_overdue`, `send_now`, `check_follow_ups`, `dismiss_follow_ups`, pinned rows in
  `list_threads`, held work skipped by `claim_due`/`next_due`, undo drops the follow-up (tests for each, and the
  migration). Shell: holds overdue sends at start; the 20-second snooze watcher also checks follow-ups and
  notifies "No reply yet"; Done and the notification's Archive dismiss. UI: Later/Remind in compose with the time
  picker (its own presets), the "No reply yet" chip, "N scheduled" and "to confirm" links, Scheduled section in
  the review dialog. Tried in `npm run dev` (`#followup`, `#scheduled`) in headless Chromium; found and fixed a
  stale read of the picker's kind after closing it. Not tried in the Tauri window against a server yet.
- 2026-10-26 (branch `sprint/10-ai-models`, owner's call to ship it with the AI follow-up): the start of the day,
  designed on a canvas and picked by the owner (A2 line, A3 morning screen, A5 one at a time). `Store::day_start`:
  Important conversations whose newest message is someone else's, oldest first; snoozed ones that came back
  (`wake_snoozed` now leaves a `woke` reminder, kept two days); fired follow-ups; new since and new in Other.
  `src/day.ts` keeps `lastSeen` while the window shows. Tried in `npm run dev` on the fake.
- 2026-10-27 (branch `sprint/05-morning`): reading, picked by the owner from the canvas "Tern reading ideas" (R2,
  R5, R6; ui.md §4.2a–c). The column beside a conversation (`ReadingMargin`), `src/facts.ts` for when, where, asks,
  codes and links (checked against English and Bosnian samples in the browser; no JS test runner yet), marks
  (schema v27, `Store::marks/add_mark/set_mark_note/delete_mark`, a migration test) drawn with the CSS Custom
  Highlight API (`src/marks.ts`), the selection bar, `[`/`]`, newsletters in reading view by default and the
  footer left out. Not built: Read later, Add to calendar, `is:marked` in search, tinting found facts in the text.
  Tried in `npm run dev` on the fake (offsite mail and the Field Notes newsletter) at 820–1913 px; a ResizeObserver
  loop (the conversation's width followed its content beside the column) was found in the Tauri window's log and
  fixed. Not yet tried against real mail in the Tauri window.
