# Sprint 5 — Triage: split inbox, snooze, reminders, send later

**Status:** todo

**Week 6.** The features that make Superhuman Superhuman.

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
- [ ] Picker with presets (Later today, Tomorrow, This weekend, Next week, Pick a time) and a text field that
      parses `3h`, `tomorrow 9am`, `mon`, `in 2 days`, `dec 3` (own parser, ~150 lines, tested).
- [ ] `reminders` table: `thread_id, due, kind (snooze | followup), note, created`.
- [ ] Snoozed threads leave the inbox: plain IMAP → move to a `Tern/Snoozed` folder (created on first use);
      Gmail → `-\Inbox +Tern/Snoozed` label. Both are reversible without data loss if the user stops using Tern.
- [ ] A scheduler in the sync worker fires due reminders: move back to Inbox, mark unread, add a `\Flagged`-free "Reminder" chip, notify (Sprint 8 adds OS notifications).
- [ ] `g h` shows Reminders sorted by due; `Shift+H` un-snoozes.

### Follow-up reminders on send
- [ ] In compose: "Remind me if no reply in … " (`Cmd+Shift+H`). Stores a `followup` reminder keyed on the sent thread.
- [ ] Cancelled automatically when a reply arrives in that thread from someone else.
- [ ] Due → the thread returns to the inbox with a "No reply yet" chip.

### Send later
- [ ] `Cmd+Shift+L` in compose → same time picker → `Outbox::Send` with `not_before`. Shows under `g d` with a clock chip; editable; cancellable.
- [ ] Sends happen only while Tern runs (local-first, no server). Say so in the UI. If the time passed while Tern was closed, send on next launch after a confirm.

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

_None yet._

## Log

_No sessions yet._
