# Tern roadmap

A fast, local-first, keyboard-first mail client for Linux, then Windows. Inspired by Superhuman's workflow,
not gated on feature parity. Rust + SQLite + Tauri 2 + SolidJS remain the foundation. MIT licensing is
planned; adding the license is a foundation task.

## Agreed direction (2026-10-13)

- Deliver in this order: **safe foundation → Linux private alpha → focused Linux beta → Windows release → expansion**.
- Keep Windows compiling and smoke-tested early; defer Windows release polish, not discovery of platform bugs.
- Keep **optional AI** in the product roadmap: off by default, usable with local inference or a user-chosen
  remote provider. AI is not a dependency for the Linux beta or Windows release.
- Choose **one Gmail backend** for the initial release through an early measured decision. Do not build
  both or promise backend switching before proving the core client.
- Defer calendar, advanced CardDAV/contacts, most attachment previews, and broad arbitrary-IMAP compatibility.
- Replace fixed one-week delivery promises with milestone exit criteria and small, reviewable PRs.

This file defines release scope and order. Existing `docs/sprints/sprint-NN-*.md` filenames are retained
as **work-package IDs**, not chronological weeks. A package can contribute a selected slice to a milestone
and retain later tasks. Its **Delivery scope** section says which tasks are in scope; future tasks do not
block a milestone. Do not automatically implement every checkbox in numeric order.

## Current evidence

- The engine has not been compiled in a verified agent run. The frontend production build passed during
  the plan review; the real Tauri bridge and provider behavior still need acceptance testing.
- Fastmail is the first available test account. Acquire a Gmail test account and Cloud project during the
  foundation phase, not just before Gmail implementation. Outlook testing is expansion work.
- Local-first reads, the outbox, keyset paging, FTS5, sandboxed HTML, and OS-keyring credentials remain the
  design direction. Reliability and performance claims must be demonstrated, not inferred from that design.

## Milestones and release gates

| Milestone | Required scope | Exit evidence | Status |
|---|---|---|---|
| M0 — Safe foundation | Compile engine/shell; Linux + Windows CI; Linux boot and early Windows WebView2/keyring smoke test; safe outbox and UID handling; migration/restart/offline tests; early Gmail comparison and verification preparation | Tests/builds pass on both OSes; Fastmail round-trips safely; failure/recovery checks recorded; Gmail decision evidence reviewed by owner | todo |
| M1 — Linux private alpha | Fastmail first; conversations; keyboard triage; safe HTML; basic compose/reply/forward; durable local and server drafts; send/undo; attachments saved/opened through system; signatures; header-derived autocomplete; local search; visible sync/outbox failures | Owner uses a test mailbox and then daily mail with a backup client; restart retains drafts; attachments round-trip; offline actions reconcile; common tasks work without mouse | todo |
| M2 — Focused Linux beta | One chosen Gmail backend + OAuth; native label/thread semantics; unified inbox; notifications/background mode; mailto; basic snippets, splits, snooze/reminders; Linux packages/update path; accurate partial-search/sync progress; small external tester group | Real Fastmail + Gmail checks pass; testers use the app for several weeks; no known mail-loss/unsafe retry blockers; installation/recovery documented; OAuth distribution is appropriate for the audience | todo |
| M3 — Windows release | Installer and update flow; WebView2 rendering/compose; Credential Manager; notifications/tray/mailto; scaling; sleep/resume; regression test the same supported providers | Clean Windows installation passes the mail-core acceptance suite; existing Linux behavior remains green | todo |
| M4 — Expansion | Optional AI first slice; calendar; Outlook/Graph; advanced contacts/previews; additional provider support; second Gmail backend only if justified | Separate owner-approved scope and acceptance per feature; no dependency back into M1–M3 | deferred |

**First release** means the focused mail core in M1–M3, not every work-package checkbox. Remote AI,
calendar, Outlook, a second Gmail backend, and advanced previews cannot delay those milestones.
Optional AI remains an intended follow-on feature, not a rejected idea. Order other expansion work by demand.

### Scope boundaries

- **Supported providers:** Fastmail in the private alpha; Fastmail and Gmail in the beta. Custom IMAP may be
  experimental. “Any IMAP server” is not a release guarantee without a tested capability/provider matrix.
- **Compose:** preserve drafts and send correct mail before adding a sophisticated editor, aliases, or
  automatic voice matching. Basic formatting may follow once the reliability gate holds.
- **Attachments:** sending, downloading, saving, and opening with the system are core; embedded PDF/media
  viewers, drag-out, and advanced browsing are expansion work.
- **Contacts:** autocomplete from received/sent headers is core; CardDAV imports/merging are expansion work.
- **Triage:** basic snippets/splits/snooze are beta scope. Advanced rule builders, unsubscribe automation,
  mute, follow-up automation and send-later can follow; none may hide sync failures or lose pending work.
- **Local scheduling:** timers run only while Tern runs. Explain overdue actions and app-closed behavior
  for snooze/reminders as well as send-later. Do not imply cross-device synchronization of local timers.
- **Security/reliability:** unsafe deletion, ambiguous-send handling, draft persistence, migration safety,
  and visible failed work are release blockers, never “cut first” to meet a date.

## Gmail: decide early, implement once

Use [the decision checklist](research/gmail-backend-decision.md) during M0. Compare IMAP + Gmail extensions
with Gmail API using the actual test account and Cloud project. Assess labels/threads/drafts, deletion,
initial useful page, full-backfill cost, freshness, recovery, scopes and verification. The owner chooses
one path before provider-specific implementation. No backend is selected by this plan revision.

- If **IMAP** wins, use package 04's IMAP path; package 12 stays deferred.
- If **API** wins, combine package 04's common OAuth/UI/model work with package 12's API path in M2;
  skip Gmail-specific IMAP implementation. Fastmail still uses IMAP.
- A minimal scripted transport seam belongs in M0 for tests. Extract a production `MailBackend` boundary
  when the selected second transport requires it, not automatically after Outlook.
- Use the actual Cloud project quotas. The research notes include Google's 2026 new-project limits and
  legacy exceptions. Batch requests do not remove individual-call quota costs.
- Measure **time to first useful page** separately from **full backfill**. Do not promise 20,000 fetched
  messages in 30 seconds. Show background progress and partial search coverage honestly.
- IMAP IDLE and API polling have different freshness guarantees. A 30-second poll is not a two-second push.
- Start scope/domain/privacy/verification preparation in M0; submit once the implemented flow can be
  demonstrated. Do not wait for the launch package to begin an external approval dependency.

## Optional AI contract

Package 10 remains planned for M4. Start with user-triggered **summarize** and **draft/rewrite**, then
consider Ask AI, automatic labels, voice matching, and additional providers separately.

- Fully off by default; no provider key, model download, AI account, or AI request required for normal mail.
- Support a tested local endpoint and a user-chosen remote provider with keys in the OS keyring.
- Explain exactly which mail/draft content leaves the device, the recipient provider, and how to disable it.
- No claim that “all data stays on-device” when remote AI is enabled. Opt-in/BYOK does not automatically
  remove Google's restricted-data obligations or guarantee a security-assessment exemption.
- Explicit enablement per account/feature; user confirms send and destructive actions. Email content is
  untrusted input, not instructions granting the model authority over the inbox.
- Provider failures/cost limits must never block reading, composing, searching, syncing, or sending manually.

## Performance evidence

Targets are measured on named reference hardware with release builds and representative mailboxes.
Keep store microbenchmarks separate from end-to-end interaction latency. Record p50/p95 and regressions;
measure input-to-visible-response, not just the duration of a signal update.

| What | Initial target / evidence |
|---|---|
| Navigation | No visible lag or focus jumps; record input-to-paint p95 while syncing; a sub-5-ms handler is not a universal sub-5-ms paint guarantee |
| SQLite list page | < 1 ms benchmark target at 100k messages |
| Local search | < 10 ms engine target; report IPC/render and partial-body coverage separately |
| Open local conversation | < 50 ms target, measured end to end |
| Archive 50 conversations | < 20 ms local store target; server completion tracked independently |
| Startup | < 400 ms aspirational packaged cold-start target; record measured result, not `tauri dev` startup |
| New mail | < 2 s target for healthy IDLE path; API path uses documented/observed poll interval |
| JS bundle | < 150 kB gzipped including the eventual compose editor |

## Work-package map (IDs are not delivery order)

| ID | Work package | Delivery scope |
|---|---|---|
| 00 | [Compile and boot](sprints/sprint-00-compile-and-boot.md) | M0; both-OS checks, early Windows smoke test, first Fastmail account |
| 01 | [Sync engine](sprints/sprint-01-sync-engine.md) | M0 safety/transport tests; M1 reliable sync and threading; optimizations staged |
| 02 | [Conversation UI](sprints/sprint-02-conversation-ui.md) | M1; no future-feature placeholders required |
| 03 | [Compose](sprints/sprint-03-compose.md) | M1 reliable compose/drafts/attachments; rich-editor extras later |
| 04 | [Gmail OAuth and selected transport](sprints/sprint-04-gmail-oauth.md) | M0 decision/preparation; M2 chosen Gmail path |
| 06 | [Search and speed](sprints/sprint-06-search-and-speed.md) | M1 search basics; M2 scale/performance refinement |
| 07 | [Attachments, contacts, snippets](sprints/sprint-07-attachments-contacts-snippets.md) | M1 basic attachments/autocomplete; M2 snippets; advanced previews/CardDAV M4 |
| 08 | [Desktop integration](sprints/sprint-08-desktop-integration.md) | M1 error/outbox visibility; M2 Linux integration; M3 Windows parity |
| 05 | [Triage](sprints/sprint-05-triage.md) | M2 basic splits/snooze; advanced automation later |
| 14 | [Distribution and launch](sprints/sprint-14-launch.md) | M0 CI/verification prep; M2 Linux beta distribution; M3 Windows distribution |
| 13 | [Windows](sprints/sprint-13-windows.md) | M0 compile + smoke; M3 public release, no calendar/AI prerequisite |
| 10 | [Optional AI](sprints/sprint-10-ai.md) | M4 staged opt-in feature, off by default |
| 09 | [Calendar](sprints/sprint-09-calendar.md) | M4, deferred from first release |
| 11 | [Outlook](sprints/sprint-11-outlook.md) | M4; does not gate Gmail or a backend boundary |
| 12 | [Gmail API candidate](sprints/sprint-12-gmail-api.md) | M0 spike; M2 only if selected; otherwise deferred |
| 15+ | [Backlog](sprints/sprint-15-plus-backlog.md) | Owner-prioritized expansion |

## Working agreement

See [the work-package process](sprints/README.md) and [UI spec](design/ui.md).

- Small branches/PRs per tested slice; do not accumulate a week's unrelated work into one review.
- A milestone completes on evidence and owner acceptance, not elapsed weeks or implementation volume.
- Select required task slices before implementation; explicitly defer the remainder without pretending it
  is complete. Do not automatically carry all deferred work into the next milestone.
- Keep `main` building on Linux and Windows once M0 establishes the baseline. Engine changes require tests;
  network behavior requires real-provider evidence. Record environmental limits honestly.
- Owner decides gates. No acceptance check is marked complete merely because an agent wrote code.

## Decision record

2026-10-13 — Owner agreed to a narrower initial release, early Windows validation, revisiting Gmail, and
the milestone delivery order. Owner reaffirmed that AI is wanted but optional. This revision records those
product decisions; it does not claim an implemented feature, selected Gmail transport, or passed release gate.

2026-10-13 — Owner chose, **provisionally**, the Gmail API as the Gmail backend and `io-imap` as the IMAP library
(package 01 gate; evidence in `docs/research/stack.md`). The Gmail comparison still runs in M0 and can reopen
both before Gmail-specific code is written. M0 testing uses a local Stalwart server instead of Fastmail
(Fastmail app passwords need a paid plan); real-provider acceptance waits for the owner's provider choice.

Research: [stack](research/stack.md), [Gmail OAuth](research/gmail-oauth.md),
[Gmail decision](research/gmail-backend-decision.md), [Microsoft OAuth](research/microsoft-oauth.md),
[data model](research/data-model.md), [Superhuman reference](research/superhuman-reference.md).
