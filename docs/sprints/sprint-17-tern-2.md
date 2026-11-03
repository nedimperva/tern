# Sprint 17 — Tern 2.0

**Status:** todo · planned 2026-11-02

## Delivery scope

The next major release after 1.9.0. The owner picked these on 2026-11-02 from the ideas page
(https://claude.ai/artifact/963KKSEjYQGzn6n8phgVzu) and the canvas "Tern 2.0 screens"
(https://claude.ai/artifact/R5NFNGMEdTj2pBo1soJVkV), which draws every slice below that has a screen. The story of
2.0: **your inbox, your rules**, search that reaches the server, AI only when asked, and Todoist beside your mail.

Each slice is its own `sprint/17-…` branch and PR, in the order of the sections. Before UI work, copy the board's
layout into `docs/design/ui.md` (the spec, not the canvas, is the source of truth). Every slice keeps the rules in
CLAUDE.md: the UI reads only SQLite, changes go through the outbox with undo, mail HTML stays sandboxed, AI goes
through `ai::allowed`. Schema changes start at v31 (1.9.0 is v30; D is v31), each with a migration test from the version before.

Postponed by the owner (2026-11-02): Outlook and Microsoft 365, Gmail threads by `X-GM-THRID`, rules and custom
splits, snooze that moves mail on the server, search inside attachments. See **Later** at the end.

### Already built (found while planning)

The ideas page offered these as new; the code already has them, so 2.0 only finishes what's missing:

- Moving a mail teaches the split: `Shift+O` / `moveToSplit` writes `sender_splits`, and later mail follows.
- Tracker shield: `mailview.ts` takes tracking pixels out, even after Load images, and the header counts them.
- All Inboxes, and `Ctrl 1–9` for one account's inbox (`switchAccount`).
- Mute (`m`, `muted_threads`, Unmute in the palette).

## Tasks

### A. Beta channel (first, so the rest can be tried early)
- [x] Settings → About → Updates: Stable / Beta (canvas board "Settings"). Default Stable. Shown only on copies
  that update themselves; changing it looks for an update at once (`update::look_now`).
- [x] A beta feed the updater can read. `releases/latest` skips pre-releases, so the release workflow also writes a
  `latest-beta.json` the beta channel reads (see Decisions). Both stay signed with the same key. Built as the
  proposed rolling `beta` release: `.github/workflows/beta-feed.yml` copies a published release's latest.json there
  when it is newer (semver, betas before their release). A tag with a hyphen makes a pre-release. Not yet run on
  GitHub.
- [x] Going back to Stable never installs an older version: it waits for the first stable release newer than the
  beta, because migrations only go forward. The setting says so. (The updater only installs a newer version.)
- [ ] A `2.0.0-beta.N` tag needs its CHANGELOG section like any release.

### B. Foundations
- [ ] Reader pool: WAL, one writer connection and a small pool of readers, so a list query never waits on a sync
  write. `PRAGMA optimize` on idle once a week. `store_bench` before and after, numbers in the Log.
- [ ] Coalesced change events: the sync worker sends `messages-changed` at most every 100 ms with the thread ids;
  the list patches those rows in place instead of loading the page again. Check holding `j` while a large sync runs.

### C. Senders: the screener, block and mute
- [x] Schema v32 (D took v31): `sender_splits.other` becomes a sender state (`important | other | waiting | blocked`), by address
  or by domain. Migration test from v31; today's rows keep their meaning. This is also the base that rules (2.1)
  build on. Now `sender_state (account_id, addr, state, since)`, `addr` an address or `@domain`; `STATE_M` and
  `IS_OTHER` in `store/mod.rs` (store_bench: Other split 4.7 ms, as before).
- [x] Screener, off by default (Settings → Senders). A first mail from someone unknown that isn't bulk goes to
  **New people** instead of Important. Known means: you wrote to them (`MINE_M`), they are in a conversation with
  you, they are at one of the domains the person lists, or you let them in before. Decided at insert, like splits.
  `messages.screen` (in v32), set only while the screener is on, so turning it on later leaves old mail alone;
  turning it off shows what waited in Important. No notifications for mail waiting there.
- [x] New people (canvas board "Screener"): Let in `y`, Other `Shift+O`, Block `Shift+X` (`x` selects), Enter reads
  first. The choice applies to everything they sent and to later mail. After the owner's first try (2026-11-03) it
  moved from a tab that came and went to a place of its own, as HEY's Screener: always in the sidebar while the
  screener is on (`g n`), a row per person (name, address, how many conversations wait; `people()` in
  `src/app/rows.ts`), a line above Important while someone waits, and the companion's drop-down says "Waiting"
  (`Sender::waiting`). Its count is people, not conversations.
- [x] Block sender (by address or domain), from the conversation menu, the palette and the companion's drop-down:
  mail from them dated after the block is marked read and archived on arrival through the outbox
  (`archive_blocked`), and still searchable; the conversation goes to Done, one undo for both. Nothing tells the
  sender. (From New people with C's screener.)
- [ ] Settings → Senders (canvas board "Senders"): the screener switch, known domains, and Blocked, Muted, To Other
  and Let in lists, each with a way back (Unblock, Unmute, To Important). Who writes most moves here. Done so far:
  the screener switch, "People you know at" (known domains), "Your choices" (Blocked, To Other, Kept in
  Important, each with its way back; Let in shows as Kept in Important) above Who writes most. Muted is still to do.
- [x] Tests: a fixture of senders with the expected place for each, screener on and off
  (`the_screener_holds_first_mail_from_people_not_known_yet`, `blocking_a_sender_or_their_domain`).

### D. One-click unsubscribe
- [x] `Ctrl+U` on a conversation (canvas board "Unsubscribe"). With `List-Unsubscribe-Post: List-Unsubscribe=One-Click`
  and an https link, Tern sends the RFC 8058 POST: queued in the outbox with the usual 5-second undo, sent by the
  sync worker, no cookies, no referrer, the body exactly `List-Unsubscribe=One-Click`. A failure lands in the
  problems list like any other queued work. Schema v31 keeps `messages.unsubscribe_post` (the header is fetched
  with the list headers); mail from before it has 0 and uses its page. Redirects are not followed; a 4xx is
  permanent (`unsubscribe::Refused`), a 5xx retries. `crates/tern-core/src/unsubscribe.rs`, `OutboxOp::Unsubscribe`.
- [x] Without one-click, today's paths stay: an address opens the mail in compose, a page opens in the browser.
- [x] After unsubscribing: the conversation goes to Done, one undo for both. ("Also block {domain}" waits for C.)
- [x] Tests: header parsing (one-click, mailto only, web only, both), the POST against a local server, the queued
  op and its undo, migration 31.

### E. Search that reaches the server
- [ ] Search on server: when local results may be partial (the search note already knows how much is downloaded),
  Enter on "Search server" runs `UID SEARCH` per account (`X-GM-RAW` on Gmail), on its own connection like
  `sync::download`. Headers for unknown UIDs are fetched and inserted like normal mail, so they are local afterwards.
  Results show under "From the server" (canvas board "Search").
- [ ] Highlights and snippets: matched words lit in the list and in the open message (CSS Custom Highlight API,
  a colour apart from marks), `N` / `Shift+N` step through matches. Contentless FTS can't rebuild snippets: try
  reading the top results' text from `bodies` at query time first, measure, and only then consider changing the index.
- [ ] Results as a split: results as you type, `↓` enters them, Enter opens, Esc goes back to the query, and `e`,
  `s`, `#` work on results like on the inbox.

### F. AI, on request
- [ ] Overnight summary on the tide (canvas board "The tide"): a Summarise button over what came in since the person
  was last here. Behind `ai::allowed` (summaries switch). Points cite their messages as chips; a receipt says what
  was sent; nothing runs until pressed and nothing is kept.
- [ ] Ask your mail: a question over all mail the AI may read (palette, and a key, see Decisions). Retrieval is local:
  the model picks search words, local FTS finds the top 20 messages, the answer cites them. It reuses the
  companion's Ask turns, chips and receipt. No embeddings.

### G. Todoist
- [ ] **Decision gate.** `docs/research/todoist.md`: the API to use (Todoist API v1 at `api.todoist.com/api/v1`;
  check what's current), how to sign in (a personal API token in the keyring as `todoist`, or OAuth if it works for
  a desktop app without a shipped secret), the endpoints (create task, projects, labels), limits, and exactly what
  leaves the computer. The owner explored this before and leans to the API: record that and the evidence.
Todoist lives in the companion column (owner, 2026-11-02: direction A on the canvas, boards "A — Tasks in the
column, at rest" and "A — Adding a task from the mail").

- [ ] Settings → Integrations → Todoist (board "Settings → Todoist"): connect (token or sign-in), Test, Forget; the
  default project; a label for tasks from mail (`@mail`); Show tasks in the companion; Suggest tasks with AI (off);
  a "What goes to Todoist" card.
- [ ] A **Tasks** section in the companion, after the details: the conversation's tasks (a tick completes it, Open
  goes to Todoist), then "Add a task from this mail" with its key `t`. Shown only once Todoist is connected.
- [ ] `t` (or the row, the `…` menu, the palette) opens the task box in place of that row: the title from what was
  asked or promised (`src/promises.ts`), else the subject; the day from the sentence (`src/facts.ts`); project,
  priority and label as chips. The words it came from stay lit in the mail; with words selected, `t` starts from
  those. "Also in this mail" lists the other asks and dates to use instead. Enter adds, Esc cancels.
- [ ] The task is created through the outbox with the 5-second undo, like every other change, and retried on failure.
- [ ] A link back: the task's description carries the sender, the subject and a `tern://` link (registered beside
  `mailto`) that opens the conversation by Message-ID. No mail text goes to Todoist unless the person adds it.
- [ ] The conversation remembers its tasks (schema): the conversation shows an "In Todoist · due Fri" pill, and the
  Tasks section lists them. Opening a conversation with a task asks Todoist for its state then, never in the background.
- [ ] Ask and promise rows: "Owed to you" and "You owe" rows get **+ Task**; a row already in Todoist shows its task
  instead, so nothing is listed twice.
- [ ] With AI (behind `ai::allowed`, its own switch for tasks): Suggest with AI in the task box fills the title, due
  day and project from the mail as a proposal. Nothing is created until the person presses Enter. Mail goes to the AI provider,
  never to Todoist.
- [ ] Tests: the Todoist client against a canned HTTP server; the outbox op, undo and retry.

### H. The companion column
Direction A on the canvas (owner, 2026-11-02). Can go before G: it needs no Todoist.

- [x] Recent with them (named "Recent with Ana"): each row opens that conversation (click or Enter), in a card,
  with an unread dot and a line of its newest text. The open conversation is left out.
- [x] "All mail from Ana · 37 →" as the card's last row searches `from:` them (the search has no "from or to"
  filter, so it says "from"; the count is their mail).
- [x] Header actions under the name: Write to Ana, Copy address, and where their mail goes (Important / Other) as
  a drop-down on the right (`goes_to_other`, `splitSenders` with undo). Blocked joins it with section C.
- [x] Every row in the column is reachable with Tab and has a visible focus: Enter or Space on a companion button
  presses it instead of the conversation's Reply all (`src/keys.ts`).

### I. Your mail as files
- [ ] Export a folder or a search as one mbox; bodies not yet downloaded are fetched first, with progress and Stop
  (canvas board "Settings"). A conversation: `…` → Save as .eml.
- [ ] Import an mbox into a new folder (see Decisions for where it goes), with progress.
- [ ] Tests: mbox round trip (From-line escaping, attachments, non-UTF-8 headers).

### J. Small finishes
- [x] The sidebar shows each account's `Ctrl` number while Ctrl is held (`src/components/Rail.tsx`).

### K. Release gate for 2.0
- [ ] (owner) The M2 checklist (`docs/acceptance/m2-beta.md`) passed: Fastmail and Gmail runs and the tester group.
- [ ] (owner) At least two weeks of betas through the beta channel on Linux and Windows without a mail-loss or
  unsafe-retry problem.
- [ ] Upgrading from 1.9.0 (schema v30) to 2.0 tested on a copy of a real store.
- [ ] CHANGELOG `[2.0.0]`; version bumped in `package.json`, `src-tauri/tauri.conf.json` and both `Cargo.toml` files.

## Decisions

Open, for the owner:

- **Beta feed:** a rolling `beta` release that holds `latest-beta.json`, or a file on GitHub Pages. Proposed: the
  rolling release, so the workflow stays in one place. Built that way; the owner can still change it.
- **Beta version numbers:** WiX (the `.msi`) takes only numeric pre-release parts, so `2.0.0-beta.1` may fail the
  Windows build where `2.0.0-1` works. Try a beta tag on a branch first (a PR that touches release.yml builds
  without releasing); if the MSI refuses, number betas `2.0.0-1`, `2.0.0-2`, or drop the MSI for betas.
- **Block's key:** `B` in a conversation switches reading view, so block has no key there; in New people it takes
  `X`? Proposed: menu and palette only in a conversation, `X` in New people. Built that way, as `Shift+X` (`x`
  selects) and `Shift+O` for Other (`o` opens); the owner can still change it.
- **Search on server** is a read from a UI command on its own connection, like `sync::download`. Proposed: add it to
  that exception in CLAUDE.md.
- **Ask your mail's switch:** the summaries switch, or its own ("Ask across mail"), since it reads every account the
  AI may read. Proposed: its own.
- **Todoist sign-in:** personal token or OAuth; settled by the gate in G.
- **Import destination:** a local-only folder, or uploaded to the server (APPEND through the outbox in batches).
  Proposed: uploaded, so other devices see it.

## Later (2.1 and after)

- Outlook and Microsoft 365 (package 11): needs an Entra app registration, publisher verification and a real
  Microsoft 365 mailbox; none of it can be tested on Stalwart.
- Gmail threads by `X-GM-THRID`: io-imap drops FETCH responses with X-GM-* items, so it needs a parser fix
  (upstream or a fork) first.
- Rules and custom splits (package 05), on top of the sender state from C.
- Snooze that moves mail to `Tern/Snoozed` on the server: then mail only comes back while Tern runs, also on other
  devices. If built, opt-in per account.
- Search inside attachments: only covers files already opened; each extraction library needs a `deny.toml` check.
- Todoist: show a task done in Todoist as done in Tern.

## Log

- 2026-11-02: planned with the owner from the ideas page and the canvas. Nothing built yet.
- 2026-11-02: owner picked direction A for the companion and Todoist (a Tasks section with a task box in place);
  B (a quick-add box docked beside Ask) was not chosen. Written into G, H and ui.md §4.2b.
- 2026-11-02: H built on `sprint/17-companion`, checked on the fake backend in the browser (rows open, search,
  split with undo toast). Not yet tried in the Tauri app on Linux.
- 2026-11-02 (overnight, same branch, a commit each): J, D, C (block, then the screener) and A. Engine tests and
  the UI checks pass; each was tried on the fake backend in the browser, none in the Tauri app or against Stalwart
  yet. store_bench on the Windows machine, main → branch: Important 1.70 → 1.91 ms, Other 4.60 → 4.76 ms; main
  itself misses four targets there (unified/Important conversations, conversation pages), as before.
  Owner checklist: `docs/acceptance/sprint-17-overnight.md`.
