# Stack decisions

What we use, what we considered, and why. Update when a decision changes; note the milestone/package.
Package numbers are stable IDs, not delivery weeks. PLAN.md and package Delivery scope sections control
release scope; calendar, advanced contacts and optional AI are expansion, not core-release dependencies.

## Rust engine

| Need | Choice | Alternatives considered | Why |
|---|---|---|---|
| IMAP | **pending owner decision** (package 01 gate, probed 2026-10-13): `async-imap` 0.12 or `io-imap` 0.7 | `imap-next` 0.3 alone (sans-I/O, no command layer); `imap-client` (archived May 2026, moved to `io-imap`); `imap` (sync) | Both pass the probe at equal speed. `io-imap` has first-class QRESYNC and COPYUID but drops Gmail X-GM-* FETCHes; `async-imap` parses X-GM-* but loses QRESYNC changes past 100 unless drained. See the probe results below. |
| TLS | `rustls` (`tokio-rustls`, `rustls-platform-verifier`) | `native-tls` (current) | No OpenSSL on Windows/CI, OS trust store via the platform verifier, one code path. `lettre` has `tokio1-rustls-tls`. |
| SMTP | `lettre` 0.11 | own minimal client | Mature, async, MIME builder, XOAUTH2 via `Mechanism::Xoauth2`. |
| MIME parse | `mail-parser` (bump to latest 0.11.x) | `mailparse` | Fast, zero-copy, handles broken mail; used by Stalwart. |
| MIME build | `lettre::message` | `mail-builder` | One dependency fewer; `mail-builder` is the fallback if lettre's builder is limiting for `cid:` inline images. |
| HTML sanitise | `ammonia` | DOMPurify in the webview | Sanitise once at insert time, in Rust, so the stored HTML is already safe; the iframe sandbox remains as the second layer. |
| SQLite | `rusqlite` bundled | `sqlx` | Sync API matches the design; FTS5 contentless-delete needs a recent bundled SQLite. |
| Secrets | `keyring` 3 | own D-Bus/Secret Service code | Already in; Secret Service / Credential Manager / Keychain. |
| OAuth | `oauth2` 5 | own | PKCE, token refresh, standards-compliant; small. |
| HTTP | `reqwest` (rustls, gzip, http2, json, stream) | `ureq`, `hyper` directly | Needed by OAuth, Gmail API, CalDAV, AI. One client. |
| DNS | `hickory-resolver` | system resolver | MX/SRV lookups for presets and CalDAV discovery. |
| D-Bus (Linux) | `zbus` | `dbus` (C bindings) | Pure Rust; sleep/resume and network state. |
| CalDAV/CardDAV | `libdav` | `minicaldav`, own WebDAV | NLnet-funded, service discovery, request/response types usable with any HTTP client. |
| iCalendar | `icalendar` + `rrule` + `chrono-tz` | `ical` | Builder + parser, recurrence expansion, zones. |
| Logging | `tracing` + `tracing-subscriber` | `log` + `env_logger` (current) | Spans with durations for sync phases; `log` facade still works through `tracing-log`. |
| Async | `tokio` | — | Already in. Store stays sync behind a mutex; move to `spawn_blocking` only where measured. |

### IMAP library probe (package 01 gate, 2026-10-13)

`crates/imap-probe`: the same checks for each library over tokio-rustls with `TCP_NODELAY`, against the local
Stalwart 0.15.5 server (`scripts/dev-mail-server.sh`), plus a scripted fake server for Gmail-only responses.
Run: `cargo run --release -p imap-probe --bin probe_async_imap` (or `probe_io_imap`). Folder: 200 small messages
and one 20 MB message; out of band, 150 flagged and 3 expunged before the QRESYNC resync.

| Check | async-imap 0.12 | io-imap 0.7.1 |
|---|---|---|
| TLS connect + login | pass, 5 ms | pass, 4 ms |
| STARTTLS on 1143 | pass; by hand (no helper) | pass; `starttls()` reads the greeting itself (undocumented) |
| XOAUTH2, rejected token (server + Gmail's JSON challenge) | pass, no hang | pass, no hang |
| Headers-first `UID FETCH 1:*` (201 msgs, BODYSTRUCTURE + HEADER.FIELDS) | pass, 135 ms | pass, 129 ms |
| QRESYNC resync: 3 VANISHED, 150 changed | pass **only with a drain task**; read afterwards: **98 of 150 arrive, no error** (side channel holds 100, `try_send(..).ok()`) | pass, 10 ms; `select_qresync` returns `vanished_earlier` and `changed` |
| IDLE: new mail → wake, then DONE | pass, immediate | pass, immediate; IDLE is a coroutine Tern drives (no client method); default refresh 29 s |
| UID MOVE | pass; COPYUID **not returned** | pass; COPYUID returned |
| 20 MB body, buffered | pass; +19 MB RSS | pass; +38 MB RSS (streaming fetch exists on the blocking client only) |
| Gmail `X-GM-MSGID/THRID/LABELS` in FETCH | pass; parsed by imap-proto (no `Fetch` accessor) | **FAIL: the whole FETCH is dropped silently**; imap-codec has no X-GM grammar (control without X-GM-* passes) |
| Probe code for the same checks | 232 lines | 321 lines (typed item names, a 35-line async driver, the IDLE loop) |
| Build / maturity | 52 crates; established | 115 crates (default features); 0.7, 5 months old, mostly one maintainer, imap-codec 2.0 **alpha**; fresh resolve **does not compile** without enabling `nom/alloc` |

Not checked here: Gmail and Fastmail behaviour against real accounts, and IDLE across a 29-minute refresh.

**Speed:** equal once `TCP_NODELAY` is set. Without it, async-imap's split writes cost ~40 ms per command on
loopback (Nagle + delayed ACK). Tern's current `sync.rs` does not set it: fix regardless of the library.

**Recommendation:** tied to the Gmail backend decision.
- Gmail via **API** (Fastmail and others on IMAP): **io-imap**. QRESYNC and COPYUID are what package 01's sync
  design needs, built in and typed; X-GM-* does not matter. Pin versions and keep the `nom/alloc` workaround.
- Gmail via **IMAP**: **async-imap**, unless io-imap gains X-GM-* support first (upstream change in imap-codec).
  QRESYNC then needs a drain task on the unsolicited channel and a raw command for COPYUID.

## Frontend

| Need | Choice | Alternatives | Why |
|---|---|---|---|
| Framework | SolidJS 1.9 | React, Svelte | Fine-grained signals, no VDOM diff on `j`/`k`; tiny bundle; already in. |
| Build | Vite 6 | — | Already in. |
| Rich text | ProseMirror core | Tiptap (ProseMirror + 100 kB), Lexical (React-flavoured), Quill, plain `contenteditable` | Schema control, keymaps, small footprint, no framework coupling. |
| Virtual list | own (`VirtualList.tsx`) | `@tanstack/virtual` | Fixed row height, 60 lines; nothing to gain from a library. |
| Fuzzy match | own | `fuse.js` | Palette needs prefix/word-start ranking on < 500 items; 60 lines. |
| Icons | Lucide (inline SVG, tree-shaken) | Tabler, Phosphor | Consistent stroke, permissive licence. |
| Fonts | Inter variable, JetBrains Mono (bundled woff2) | system-ui | Deterministic rendering across Omarchy and Windows. |
| Dates | `Intl.DateTimeFormat` + 30 lines of relative formatting | `date-fns`, `dayjs` | Enough. |
| State | signals + stores in `src/state/` | solid-store libraries | Keep it simple; the SQLite store is the real state. |

Bundle budget: 150 kB gzipped total. Measure every sprint (`vite build` prints it; the perf overlay shows it).

## Tauri 2 plugins (package IDs, not delivery order)

| Plugin | Sprint | Notes |
|---|---|---|
| `opener` | in | Links and the OAuth browser hop. |
| `dialog` | 3 | File picker for attachments. |
| `single-instance` | 8 | Must be registered first. `mailto:` on Linux/Windows arrives as argv in the second instance. |
| `notification` | 8 | freedesktop on Linux, WinRT on Windows. |
| `autostart` | 8 | XDG autostart / registry Run key. |
| `deep-link` | 8 | `mailto:` scheme; `.desktop` `MimeType`. |
| `clipboard-manager` | 8 | Copy address/link. |
| `updater` + `process` | 14 | Signed `latest.json`. |
| `log` | 6 | Optional; `tracing` to a file is enough. |

Not used: `tauri-plugin-sql` (we own the SQLite layer), `tauri-plugin-store` (settings live in SQLite), `tauri-plugin-stronghold` (keyring does the job).

## Linux specifics

- WebKitGTK 2.4x on Wayland: `WEBKIT_DISABLE_DMABUF_RENDERER=1` fixes blank windows on NVIDIA and some Mesa versions. Set it from `main.rs` when on Wayland unless already set.
- Secret Service needs an unlocked collection; on Omarchy `gnome-keyring` is installed but may need `pam_gnome_keyring` or a manual unlock; the first-run screen explains it.
- StatusNotifier tray works in Waybar via `libappindicator-gtk3`.
- PDF in iframes works in WebKitGTK ≥ 2.40 (built-in PDF.js-based viewer).

## Gmail API vs IMAP+X-GM (M0 decision, one initial Gmail path)

| | IMAP + X-GM-EXT-1 | Gmail API |
|---|---|---|
| Labels | `X-GM-LABELS` on FETCH/STORE; no colours; "Show in IMAP" per label must be on | Full, with colours/visibility |
| Threads | `X-GM-THRID` | `threadId` (same) |
| Incremental | CONDSTORE yes, QRESYNC **no** (verify in the Sprint 1 probe): changed flags are cheap via `UID FETCH 1:* (FLAGS) (CHANGEDSINCE n)`, but expunges need a periodic UID re-scan of All Mail | `history.list` — one call, exact, includes deletions |
| Push | IDLE on INBOX only | Polling (Pub/Sub needs a server) |
| Search | `X-GM-RAW` | `q=` (same syntax) |
| Drafts | APPEND to `[Gmail]/Drafts`, dedupe is fiddly | `drafts.*` native |
| Send | SMTP XOAUTH2 | `messages.send` |
| Scope | `https://mail.google.com/` (restricted) | `gmail.modify` (restricted, narrower) |
| Rate limits | Verify current account connection/bandwidth limits | Published 2026 new-project baseline: 6,000 units/user/project/minute; messages.get costs 20. Confirm actual project limits/legacy status; see decision research. |
| Code | shared IMAP transport with Gmail-specific semantics | Gmail adapter alongside Fastmail IMAP; not a required second Gmail implementation |

The deletion/history model is one argument for the API, not a decision by itself. Compare parser complexity,
quotas/backfill, draft correctness, freshness/polling and recovery using [the early gate](gmail-backend-decision.md).
History responses can require pagination and expired cursors require recovery; do not assume every delta
is one call. No Gmail transport is selected yet. A second Gmail backend and switching remain deferred.
