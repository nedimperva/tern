# What 1.0 needs

1.0 is the Windows release (M3), after the focused Linux beta (M2) has passed its gate ([PLAN.md](PLAN.md)). This
page sorts every open task in the work packages into what 1.0 needs and what comes later, so the checkboxes stop
reading as a to-do list for the release. Proposed 2026-10-20 by the agent; **the owner approves or changes it** in
the PR, and the packages' Decisions sections record the outcome.

The gates themselves are the owner's: the [M2 checklist](acceptance/m2-beta.md) on Linux with Fastmail and Gmail
and a tester group using Tern for several weeks, then the [M3 checklist](acceptance/m3-windows.md) on a clean
Windows. The owner tests both platforms now.

## Needed for 1.0

| Package | Task | Who |
|---|---|---|
| 08 | Copy link / Copy address: right-click on a link in a message and on an address. #73 took the web view's own menu away, which also took "Copy link" | agent |
| 08 | Reminder and follow-up notifications: check every due path notifies (snooze back, no reply yet, scheduled send to confirm) | agent |
| 13 | Text and layout at 125 % and 150 % display scaling | owner (M3 checklist) |
| 14 | README rewrite: screenshots, install per platform, keyboard sheet, how it works | agent |
| 14 | `THIRD_PARTY.md`: licences of the Rust and npm dependencies that ship in the app | agent |
| 14 | A one-page site with downloads per platform and the privacy note, no tracking | agent; owner turns on GitHub Pages |
| 14 | Windows signing: stay unsigned with SmartScreen documented, or apply for free OSS signing (SignPath) / pay for Azure Trusted Signing | owner decides |
| 00 | Make the `check` workflow required on PRs (branch protection) | owner (GitHub setting) |
| 00 | M0 acceptance with Fastmail: the same checks are in the M2 checklist | owner |
| — | Version 1.0 in `package.json`, `tauri.conf.json` and both `Cargo.toml`; release notes | agent, at the end |

## Already done in another form (tick or reword)

| Package | Task | What exists |
|---|---|---|
| 04 | All Mail as the source of truth, label membership | #66: All Mail plus `message_labels` from each label folder (io-imap drops X-GM-LABELS, see 04's Decisions) |
| 04 | Unified inbox across accounts | The inbox lists every account's mail with its colour dot |
| 05 | Mute | `m` and the `muted` table (schema v11) |
| 05 | Split counts in the tabs | Important / Other show unread counts |
| 06 | Fetch a body when it is opened; never attachment bytes until opened | `want_bodies`, `sync::download` |
| 06 | Prepared statement cache | `prepare_cached` on the hot queries |
| 07 | Download an attachment on first open, cache it | `sync::download`, `app_cache_dir()/received` |
| 07 | No remote avatars | Initials; sender logos are opt-in (Settings → Reading) |

## Later (M4 and the backlog)

- **04 Gmail extras:** server-side Gmail search and the results' origin, Workspace detection by MX lookup, preset
  flags, `X-GM-THRID` thread keys and `X-GM-MSGID` deep links (both need io-imap to keep X-GM items), account
  switching with `Ctrl+1…9`, the OAuth progress states and error copy (releases use app passwords).
- **05 Triage automation:** the rule engine and custom splits, Gmail's own categories, teaching rules from moves
  (moving a sender already sticks), Tern/Snoozed on the server, one-click unsubscribe, block sender, mark all as done,
  batching outbox ops per 100 UIDs.
- **06 Speed and search extras:** results as you type with highlights, suggestion rows, a body-download window
  setting, search on the server, a reader-connection pool and other SQLite tuning, a warm-cache first paint,
  coalesced IPC, `tracing` spans, p95 in the perf overlay. `store_bench` meets today's targets at 100k.
- **07 Advanced:** drag out, drop onto a conversation, an attachments browser, contacts merged across addresses,
  CardDAV, the introduction reply.
- **09–12:** calendar, AI, Outlook, the Gmail API: M4 by the plan.
- **14 distribution extras:** publishing the AUR package and a Flatpak, Google's app verification and Microsoft's
  publisher verification (only with an own-client build in releases).

## Windows signing: the options

Unsigned installers make SmartScreen say "Windows protected your PC" until the person chooses More info → Run
anyway; the tester guide explains that. A signature names the publisher and, over time, earns SmartScreen's
trust. Since 2024 no certificate type skips that warm-up, EV included. Check current terms before choosing:

| Option | Cost | Fits Tern? |
|---|---|---|
| Stay unsigned | none | Fine for the beta and testers; a hurdle for strangers downloading 1.0 |
| SignPath Foundation | free for open-source projects, by application | Likely: MIT, public repo, releases built in GitHub Actions |
| Certum Open Source Code Signing | roughly €25–70 a year, for an individual developer | Yes, and worldwide; the key lives on a card or in their cloud signing |
| Azure Trusted Signing | about $10 a month | Identity checks limited to some countries; may not be open to the owner |

The release workflow signs the updater bundles already (`TAURI_SIGNING_PRIVATE_KEY`); Authenticode signing would
be a step after the build in `release.yml`.
