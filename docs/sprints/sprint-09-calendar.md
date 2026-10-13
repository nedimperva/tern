# Sprint 9 — Calendar v1 (CalDAV)

**Status:** todo

**Week 10.** See your day without leaving the inbox, answer invites with a key, create events from mail.

CalDAV first because it works today with Fastmail, and with Google through `apidata.googleusercontent.com`
using the same OAuth token plus the `https://www.googleapis.com/auth/calendar` scope. Native Google /
Graph calendar APIs are backlog.

## Goal

`0` opens a day panel on the right with today's events; `0 0` a week view; an invite in a conversation
shows Accept/Tentative/Decline (`Cmd+Shift+Y/T/N`) and the reply goes out as iTIP; `Cmd+Shift+E` creates
an event from the current mail with the date it mentions.

## Tasks

### Sync (`tern-core::cal`)
- [ ] `libdav` `CalDavClient` with service discovery (`/.well-known/caldav`, SRV); Basic auth for Fastmail (app password, same keyring entry pattern), Bearer for Google.
- [ ] Tables: `calendars (id, account_id, href, name, color, ctag, sync_token, read_only)`, `events (id, calendar_id, uid, href, etag, start, end, all_day, tz, summary, location, description, rrule, status, organizer, attendees JSON, ical TEXT)`, `event_instances (event_id, start, end)` materialised for the next 365 days.
- [ ] Incremental sync with `sync-collection` (RFC 6578) where supported, else `calendar-query` by time range + etag diff. Every 5 minutes and on panel open.
- [ ] Recurrence expansion with `rrule` crate; time zones via `chrono-tz`; all-day events handled as dates, not midnight UTC.
- [ ] Write: create/update/delete `PUT`/`DELETE` with `If-Match`; conflicts surface as "Changed on server, reload".

### Panel
- [ ] `0` toggles the day panel (right side, 320 px): hour grid with now-line, events with colour, free/busy at a glance; `Cmd+[`/`]` previous/next day, `t` today. `0 0` week (seven columns, compact).
- [ ] Event detail on `Enter`: attendees with status, location link, join link detection (Meet/Zoom/Teams URLs) with "Join" button, description.
- [ ] Quick create: `Cmd+Shift+E` → one text field, parsed: "Lunch with Ana tomorrow 12:30 at Mozza" → title/date/time/location.

### Invites in mail
- [ ] Detect `text/calendar` parts with `METHOD:REQUEST|CANCEL|REPLY`; parse with `icalendar`; render an invite card above the message body: title, time (in your zone), organiser, attendees, conflicts with your calendar ("Overlaps: Standup").
- [ ] Accept / Tentative / Decline (`Cmd+Shift+Y/T/N` or buttons): update `PARTSTAT` on your copy (PUT), send the `METHOD:REPLY` iTIP mail to the organiser via the normal outbox, archive the invite (setting).
- [ ] `CANCEL` removes the event with an undo; `REPLY` from others updates attendee status on your event.
- [ ] Google and Fastmail both also process iTIP server-side; we still send the mail so plain CalDAV servers work.

### Share availability (lightweight)
- [ ] In compose, `Cmd+Shift+A`vailability (palette "Insert availability"): pick slots from the week view, insert as text in your timezone (and optionally the recipient's).

## Cut first
Share availability, week view, quick-create NLP (use a form).

## Acceptance
- Fastmail calendar syncs; an event created in Tern shows in Fastmail web within a minute and vice versa.
- Accept a real Google Calendar invite received in Fastmail: organiser sees "accepted".
- A recurring weekly event appears on the right days across a DST change.

## Decisions

_None yet._

## Log

_No sessions yet._
