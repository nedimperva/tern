# Stack decisions

What we use, what we considered, and why. Update when a decision changes; note the sprint.

## Rust engine

| Need | Choice | Alternatives considered | Why |
|---|---|---|---|
| IMAP | `async-imap` 0.11 (upgrade in Sprint 0); **gate in Sprint 1** | `imap-next` 0.3 + `imap-client` (duesee/soywod); `imap` (sync, same lineage); `imap-codec` directly | `async-imap` is in the code already and had releases in Jul 2025 → Feb 2026. `imap-next` is the most correct codebase in the ecosystem (NLnet-funded, fuzzed, `ext_condstore_qresync` and `starttls` features) but has a small API surface area to build on. The Sprint 1 probe decides on evidence. |
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

### IMAP probe checklist (Sprint 1)

```
imap_probe --host imap.fastmail.com --user … 
  [ ] CAPABILITY parsed; ENABLE CONDSTORE QRESYNC accepted
  [ ] SELECT INBOX (QRESYNC (uidvalidity modseq)) → VANISHED + FETCH FLAGS MODSEQ parsed
  [ ] IDLE → wait for an EXISTS → DONE in < 100 ms
  [ ] UID FETCH 1:* (UID FLAGS INTERNALDATE RFC822.SIZE BODYSTRUCTURE BODY.PEEK[HEADER.FIELDS (…)]) in 1,000-UID batches
  [ ] UID MOVE
  [ ] AUTHENTICATE XOAUTH2 (against Gmail when the account exists)
  [ ] UID FETCH (X-GM-LABELS X-GM-THRID X-GM-MSGID) tolerated/parsed (Gmail)
  [ ] STARTTLS on 143
Result (fill in): async-imap: … / imap-next: … / Decision: …
```

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

## Tauri 2 plugins

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

## Gmail API vs IMAP+X-GM (for the Sprint 11 gate)

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
| Rate limits | connection limits (15 simultaneous), bandwidth caps (2,500 MB/day download) | 250 quota units/s/user, 1 billion/day |
| Code | one backend for all providers | second backend behind `MailBackend` |

The missing QRESYNC on Gmail IMAP is the strongest argument for the API: detecting deletions in a 100k-message All Mail folder needs a periodic UID re-scan over IMAP (ESEARCH helps, but it is still a scan), while `history.list` is one call that includes `messagesDeleted`.
