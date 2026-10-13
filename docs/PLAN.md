# Tern roadmap

A Superhuman-class mail client for Linux and Windows: local-first, keyboard-first, fast, and good-looking.
Open source (MIT). Linux (Omarchy / Hyprland / Wayland) is the primary target until the core is complete;
Windows lands in Sprint 13.

This file is the map. Each sprint has its own file in `docs/sprints/` with tasks, acceptance criteria and
decision gates. Research notes that back the decisions live in `docs/research/`.

Sprints are one week each, on the assumption that an agent does most of the implementation and the owner
reviews, tests against real accounts, and decides at the gates. If a sprint overruns, cut scope rather than
extend the week; carry the remainder into the next sprint's file.

## Where we are (2026-10-13)

- ~3,100 lines: Rust engine (`crates/tern-core`), Tauri 2 shell (`src-tauri`), SolidJS UI (`src`).
- The Rust has **never been compiled**. The UI has only run against a fake mailbox in a browser.
- Design is sound and worth keeping: SQLite-only reads, outbox with 5-second undo, keyset paging,
  contentless FTS5, sandboxed HTML, passwords in the OS keyring. See `CLAUDE.md`.
- Only a Fastmail (plain IMAP) test account is available today. A Gmail account and a Google Cloud project
  arrive before Sprint 4. Outlook test account is needed before Sprint 11.

## Product definition

Tern should feel like Superhuman: one list, one conversation, everything reachable from the keyboard in
under 100 ms, a command palette for everything else, and an inbox that is empty most of the time.

**Must have (Sprints 0–8)**
- Any IMAP account, Gmail with OAuth (labels, Gmail threads, Gmail search syntax), unified inbox.
- Conversation list, split inbox (Important / Other / custom), snooze & reminders, follow-up reminders,
  send later, undo send, snippets, signatures, recipient autocomplete, attachments, instant search.
- Notifications, tray, `mailto:` handler, start at login.
- Speed targets in the table below, measured and enforced.

**Should have (Sprints 9–12)**
- Calendar (CalDAV first), RSVP from invites, "see your day".
- AI with your own API key: summarize, draft, ask, auto-label. Opt-in, off by default.
- Outlook / Microsoft 365 via IMAP+OAuth; Gmail API backend behind a backend trait.

**Later (Sprints 13+)**
- Windows build and installers, auto-update, AUR / Flatpak, Microsoft Graph, multiple windows/tabs.

**Not planned**
- Read statuses / open tracking. Team features (shared conversations, comments). Any server component.

## Speed targets

These are the product. Every sprint ends with `store_bench` and the UI perf overlay showing green.

| What | Target | How we measure |
|---|---|---|
| Keypress to list moved (`j`/`k`) | < 5 ms | perf overlay, `performance.now()` around the signal update |
| One page of a list from SQLite | < 1 ms | `store_bench` |
| Search as you type, 100k messages | < 10 ms per keystroke | `store_bench` + overlay |
| Open a conversation | < 50 ms (bodies local) | overlay |
| Archive 50 conversations | < 20 ms local, server later | `store_bench` |
| Cold start to interactive inbox | < 400 ms | `tauri dev` log line at first paint |
| New mail on server to row on screen | < 2 s with IDLE | manual, Sprint 1 |
| JS bundle | < 150 kB gzipped (compose editor included) | `vite build` |

## Architecture (decisions, with the sprint that makes them)

Full reasoning in `docs/research/stack.md`.

| Area | Decision | Sprint |
|---|---|---|
| IMAP | Upgrade `async-imap` 0.10 → 0.11. Spike `imap-next`/`imap-client` in Sprint 1; switch only if async-imap cannot do IDLE + QRESYNC + Gmail extensions cleanly. | 0, gate in 1 |
| TLS | Move to `rustls` everywhere (IMAP, SMTP, HTTP). No OpenSSL on Windows, one root store (`rustls-platform-verifier`). | 1 |
| HTTP | `reqwest` (rustls) for OAuth, Gmail API, CalDAV, AI providers. | 4 |
| OAuth | `oauth2` crate, authorization code + PKCE, loopback redirect on `127.0.0.1:<random>`, system browser via opener. Tokens in keyring. | 4 |
| Threading | Our own: `References`/`In-Reply-To`, subject fallback; Gmail `X-GM-THRID` wins when present. Materialized `threads` table. | 1, 2 |
| Labels | First-class `labels` + `message_labels` tables. IMAP folders map to one label each; Gmail labels map directly. Archive = remove Inbox label. | 4 |
| HTML mail | Sanitize once in Rust (`ammonia`) at insert time, render in `<iframe sandbox>` with CSP. Remote images blocked until click. | 2 |
| Compose editor | ProseMirror (core packages only). Small, keyboard-first, controllable schema. | 3 |
| UI | SolidJS, no state library, CSS custom properties for themes, Inter + JetBrains Mono bundled. | 2 |
| Calendar | `libdav` (CalDAV/CardDAV) + `icalendar` crate. Native Google/Graph calendar later. | 9 |
| AI | Provider trait in Rust (OpenAI / Anthropic / Gemini), keys in keyring, results cached in SQLite. | 10 |
| Backends | `MailBackend` trait so Gmail API and Graph can sit beside IMAP. Introduced when the second backend arrives, not before. | 12 |
| Packaging | AppImage + .deb + .rpm from `tauri build`, AUR PKGBUILD, Tauri updater with signing key. MSI/NSIS on Windows. | 13, 14 |

## Sprint map

| # | Week | Theme | Outcome you can see |
|---|---|---|---|
| 0 | 1 | [Compile and boot](sprints/sprint-00-compile-and-boot.md) | App opens on Hyprland, Fastmail inbox fills, archive/star/send round-trip |
| 1 | 2 | [Sync engine v2](sprints/sprint-01-sync-engine.md) | New mail in < 2 s (IDLE), cheap re-checks (QRESYNC), headers first, real threads |
| 2 | 3 | [Conversation list and the Superhuman shell](sprints/sprint-02-conversation-ui.md) | One row per thread, Superhuman keys, command palette, dark/light, perf overlay |
| 3 | 4 | [Compose](sprints/sprint-03-compose.md) | Rich compose, reply/forward with quoting, drafts to server, attachments, signatures, autocomplete |
| 4 | 5 | [Gmail via IMAP + OAuth](sprints/sprint-04-gmail-oauth.md) | "Sign in with Google", labels, Gmail threads, Gmail search syntax |
| 5 | 6 | [Triage: split inbox, snooze, send later](sprints/sprint-05-triage.md) | Important/Other, custom splits, `h` to snooze, follow-up reminders, send later, unsubscribe, mute |
| 6 | 7 | [Search and speed](sprints/sprint-06-search-and-speed.md) | Instant search with operators, 100k-message mailbox under targets, body download policy |
| 7 | 8 | [Attachments, contacts, snippets](sprints/sprint-07-attachments-contacts-snippets.md) | Attachment viewer and drag/drop, contact ranking, snippets with `;`, Instant Intro |
| 8 | 9 | [Desktop integration](sprints/sprint-08-desktop-integration.md) | Notifications, tray, `mailto:`, start at login, single instance, offline indicator |
| 9 | 10 | [Calendar v1](sprints/sprint-09-calendar.md) | CalDAV sync, day/week panel on `0`, RSVP from invites, create event from mail |
| 10 | 11 | [AI with your own key](sprints/sprint-10-ai.md) | Summaries above threads, write with AI, Ask AI over local mail, auto-labels into splits |
| 11 | 12 | [Outlook and backend abstraction](sprints/sprint-11-outlook.md) | Microsoft sign-in, outlook.office365.com IMAP+OAuth, `MailBackend` trait, Gmail API go/no-go |
| 12 | 13 | [Gmail API backend](sprints/sprint-12-gmail-api.md) | history-based incremental sync, native labels/threads/drafts, send via API |
| 13 | 14 | [Windows](sprints/sprint-13-windows.md) | Builds on Windows, WebView2, Credential Manager, MSI/NSIS, tray, notifications |
| 14 | 15 | [Open-source launch](sprints/sprint-14-launch.md) | CI matrix, signed releases, updater, AUR, docs, Google verification submitted |
| 15+ | — | [Backlog](sprints/sprint-15-plus-backlog.md) | Graph API, Flatpak, tabs, themes, accessibility, i18n |

## Working agreement

- **Branch per sprint**: `sprint/NN-short-name`, PR into `main` at the end of the week, owner reviews.
  Small follow-up PRs are fine. `main` must always compile and pass `cargo test` + `npm run build`.
- **Definition of done** for a task: code compiles, tests for engine changes, tried against a real account
  where it touches the network, `CLAUDE.md` updated if a decision changed, speed targets still green.
- **Decision gates** are marked in sprint files. The agent proposes with evidence; the owner decides.
- **Commits**: imperative, one topic each, body says why. Author is the owner.
- **Keep the bundle small, keep the engine synchronous where it can be.** Measure before optimizing,
  but never ship a regression against the table above.

## Risks

| Risk | Mitigation |
|---|---|
| Rust code written blind has deeper problems than API mismatches | Sprint 0 is only about compiling and the first real sync; nothing else is scheduled that week |
| `async-imap` cannot parse `MODSEQ` / `X-GM-*` FETCH items | Sprint 1 spike with raw commands and a second parser; switch to `imap-next` if needed before Sprint 4 depends on it |
| Google OAuth verification takes months; CASA may be demanded | Testing mode (100 users) covers development; local-first should exempt us from CASA; start the submission in Sprint 14, not later |
| Outlook.com IMAP OAuth quirks (opaque tokens, scope prefixes, intermittent `AUTHENTICATE failed`) | Sprint 11 budgets a day for it; Graph is the fallback path |
| WebKitGTK on Wayland/NVIDIA renders blank | `WEBKIT_DISABLE_DMABUF_RENDERER=1` fallback set from `main.rs` when detected; documented in Sprint 0 |
| Scope creep from the Superhuman feature list | Every sprint has a "cut first" line; the backlog file exists so nothing has to be squeezed in |
| One developer-reviewer | One PR per sprint, concise, with a "how to test" section; agent writes the test plan |

## Reference material

- `docs/research/stack.md` — library choices and alternatives.
- `docs/research/gmail-oauth.md` — Google Cloud setup, scopes, loopback flow, verification.
- `docs/research/microsoft-oauth.md` — Entra app registration and the Outlook IMAP quirks.
- `docs/research/superhuman-reference.md` — features, shortcuts and UI patterns we are matching.
- `docs/research/data-model.md` — schema changes across sprints.
