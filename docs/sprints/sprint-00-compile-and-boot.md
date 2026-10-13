# Sprint 0 — Compile and boot on Linux

**Status:** in progress · started 2026-10-13

## Delivery scope

**M0 — safe foundation.** Required: Linux and Windows compile/test CI, first Linux boot, early Windows boot/render/keyring smoke test, and safe Fastmail round-trips. This is not a one-week timebox. CI and offline/restart tests are not optional.

Package number is a stable ID, not a delivery week. [PLAN.md](../PLAN.md) defines order and release gates.

## Overview

Nothing new. Make what exists real: compile the Rust, run the Tauri bridge, sync a Fastmail account.

## Goal

`npm run tauri dev` opens Tern on Hyprland, a Fastmail account syncs its inbox newest-first, and
archive / star / mark-read / send reach the server after the 5-second undo window.

## Tasks

### Toolchain
- [x] Install on the Omarchy machine: `sudo pacman -S --needed base-devel rustup nodejs npm webkit2gtk-4.1 libappindicator-gtk3 librsvg openssl gnome-keyring libsecret`, `rustup default stable`.
- [x] Pin the toolchain: `rust-toolchain.toml` with `channel = "stable"` and `components = ["rustfmt", "clippy"]`.
- [x] Add `LICENSE` (MIT, copyright Nedim Perva), fill `license = "MIT"` in all `Cargo.toml` and `package.json`.
- [x] `.editorconfig`, `rustfmt.toml` (max_width 110 to match existing style), `.gitattributes` already present.

### Make `tern-core` compile
- [-] ~~Bump `async-imap` to `0.11`~~ — moved to package 01. 0.12 is out, and package 01's library gate compares
      `async-imap` with `imap-next`, so an upgrade here could be thrown away. Owner approved 2026-10-13.
      Destination: package 01, decision gate "IMAP library".
- [ ] `mail-parser` 0.9 → check current (0.11.x). Fix `MessageParser`, `body_text`/`body_html`, address accessors in `mime.rs`.
- [x] `keyring` 3: `Entry::new(service, user)?`, `set_password`, `get_password`, `delete_credential`.
- [x] `lettre` 0.11: `AsyncSmtpTransport::<Tokio1Executor>::relay(host)?` / `starttls_relay`, `.credentials(...)`, `.build()`.
- [x] `cargo test -p tern-core` green. Existing tests: store (insert/list/thread/search/outbox/undo), mime, sync batching and roles.
- [x] `cargo run --release -p tern-core --example store_bench` and record numbers in this file under "Results".
- [x] `cargo clippy -p tern-core -- -D warnings` clean (allow a few lints in `lib.rs` if they are noise).

### Make `src-tauri` compile and run
- [x] Fix `tauri` 2 API use: `Emitter` for `app.emit`, `Manager` for `app.path().app_data_dir()`, `State`.
- [x] Generate the missing icons (`icons/32x32.png`, `128x128.png`, `128x128@2x.png`) from `app-icon.png` with `npm run tauri icon app-icon.png`.
- [x] On Linux, set `WEBKIT_DISABLE_DMABUF_RENDERER=1` in `main.rs` before the builder **only** when
      `WAYLAND_DISPLAY` is set and the env var is not already set. Document in README.
- [x] Window opens on Hyprland. Check class with `hyprctl clients`; add the float rule to README if the class differs from `tern`.
- [x] `npm install && npm run tauri dev` — fake mailbox must not appear (bridge detected), real `accounts` command returns `[]`.

### First real account
- [ ] Add Fastmail (app password). Folder list appears with correct roles (Inbox, Archive, Sent, Drafts, Trash, Junk).
- [ ] Inbox fills newest-first; open a message; HTML renders in the sandboxed iframe; "Load images" works.
- [ ] Archive, star, mark read/unread: local change is instant; `z` within 5 s reverts; after 5 s the server shows it.
- [ ] Send a message to yourself; it arrives; a copy is in Sent (Fastmail does this server-side).
- [ ] Kill the network mid-sync; app stays responsive; reconnects when back.

### Early Windows validation (before feature expansion)
- [ ] Add Linux and Windows CI for engine/workspace checks, tests and frontend build; document required system dependencies.
- [ ] On Windows, boot the existing Tauri shell and smoke-test WebView2 mail rendering, basic compose/keyboard handling, and Credential Manager.
- [ ] Record actual results; a cross-compile alone is not a Windows runtime smoke test.

#### Windows smoke test steps (owner)

Needs the Fastmail test account. Clean checkout of this branch on Windows 11.

1. Install Rust (MSVC toolchain), Node 22 LTS and Visual Studio Build Tools ("Desktop development with C++").
2. `npm ci`, then `npm run tauri dev`. **Expect:** the Tern window opens with the "Add an account" form, not the
   fake mailbox. Report the time to first window and any console errors.
3. Add the Fastmail test account (app password). **Expect:** folders appear, Inbox fills newest first.
4. Open Credential Manager → Windows Credentials. **Expect:** an entry for service `tern-mail` with the
   test address. Close and reopen Tern: it signs in without asking for the password.
5. Open an HTML newsletter. **Expect:** it renders in the reading pane, remote images blocked until
   "Load images"; links open in the default browser.
6. Keyboard: `j`/`k` move, `e` archives, `z` undoes within 5 s, `c` opens compose, `Ctrl Enter` sends a
   message to the test address. **Expect:** each works with no mouse; the sent message arrives.
7. Note Windows version, display scaling (100/125/150%), and anything that looks wrong, with a screenshot.

### Reliability gate
- [ ] Before mutations on a real inbox, exercise safe move/expunge fallback, UIDVALIDITY validation, dependent pending operations and restart recovery.
- [ ] Test ambiguous SMTP acceptance separately from safe-to-retry failure; surface unknown outcomes rather than blindly resending.
- [ ] Add a minimal scripted transport seam and offline/crash/migration tests; do not wait for the Outlook abstraction package.
- [ ] Obtain the Gmail test account/Cloud project; run the early comparison and begin domain/privacy/scope preparation.

### Hygiene
- [ ] Update `CLAUDE.md` "Where things stand" to reflect a compiled, running app, and list any API gotchas found.
- [ ] Require `.github/workflows/check.yml` on PRs with Linux and Windows checks/tests and frontend builds. Package 14 extends it for release artifacts later.

## Cut first
Editor/style configuration polish. Never cut CI, offline/restart tests, early Windows validation or the undo round-trip test to meet a calendar date.

## Acceptance
- `cargo test --workspace` and `npm run build` pass on Linux and Windows; the early Windows smoke-test result is recorded.
- The five "first real account" checks pass against Fastmail.
- `store_bench` numbers recorded below and within the README targets, or a note on what missed and why.

## Results (fill in)
```
store_bench, 50,000 messages (2026-10-13, release build, Omarchy laptop):
  list page:     0.103 ms median, 0.109 ms p95   (target < 1 ms)    ok
  page 250:      0.104 ms median, 0.220 ms p95
  unified inbox: 0.154 ms median, 0.287 ms p95
  thread open:   0.007 ms median                 (target < 50 ms)   ok
  search:       72.9 ms median, 87.4 ms p95      (target < 10 ms)   MISSED
  archive 50:    1.75 ms median, 3.80 ms p95     (with undo; target < 20 ms) ok
```
Search misses by about 7x. It belongs to package 06 (search and speed); recorded here, not fixed in this package.

## Notes for the agent
- Fix against the real crate docs; do not redesign. The design is in `CLAUDE.md`.
- If `async-imap` 0.11 is missing something (for example `Session::idle` shape changed), note it here; Sprint 1 decides on the library.
- Keep `commands.rs` thin. Anything that is not glue belongs in `tern-core`.

## Decisions

- 2026-10-13 — **Test mailbox.** The plan says Fastmail before any primary inbox. Tern was first run against the
  owner's real divgroup.eu mailbox (SmarterMail) and archived one message there. Owner decided: get a
  Fastmail test account; do not sync divgroup.eu again until the reliability gate passes.
- 2026-10-13 — **Windows.** Owner runs the runtime smoke test on a Windows machine from 2026-10-14; steps above.
  CI covers compile and tests meanwhile.
- 2026-10-13 — **Gmail.** Owner asked to start M0 Gmail preparation now. Owner checklist:
  `docs/research/gmail-test-setup.md`. Backend choice stays pending until the probe evidence exists.
- 2026-10-13 — **Fixes merged outside the process.** Before the plan landed, three fixes found against
  SmarterMail went to `main` directly as e7addb9 (no PR): read the IMAP greeting before authenticating;
  AUTHENTICATE PLAIN with LOGIN fallback (SmarterMail rejected LOGIN's quoted password); timeouts on every
  IMAP command, size-capped body batches and a 15 s backfill budget per pass (one 22 MB message had stalled
  the worker, inbox and outbox forever); env_logger. Recorded here so package 01 reviews them: package 01
  plans a different transport and may replace this code.
- 2026-10-13 — **No Fastmail.** Fastmail refuses IMAP sign-in without an app password, and app passwords need a
  paid plan (not available on the trial). Owner decided: **local test server only for now**. M0 runs against a
  Stalwart IMAP/SMTP server on the dev machine (no root, high ports, a local test CA trusted only through
  `SSL_CERT_FILE` when launching Tern). The "first real account" checks below run against it; the
  real-provider check moves to whichever provider the owner picks later. PLAN.md's "Fastmail first" needs
  revisiting at that point.
- 2026-10-13 — **async-imap upgrade.** Planned here as 0.10 → 0.11; 0.12 is current and package 01 may replace the
  library. Owner decided: skip it in package 00; package 01's library gate decides version or replacement.

## Log

- 2026-10-13 — Workspace compiles; `cargo test --workspace` (9 tests), strict clippy and `npm run build` pass
  (13.3 kB JS gzipped). App booted on Hyprland and synced a real SmarterMail account (see Decisions).
  Added toolchain pin, rustfmt/editorconfig, MIT license, Wayland DMA-BUF default, Linux + Windows CI,
  Gmail owner checklist. Open: async-imap 0.11 and mail-parser bumps, Hyprland class check, Fastmail
  checks (waiting on the test account), Windows smoke test (owner, 2026-10-14), reliability gate.
- 2026-10-13 — Wayland default verified: window renders with no variable set; Hyprland class is `tern`.
  Fastmail trial has no app passwords; switched M0 testing to a local Stalwart server (see Decisions).
- 2026-10-13 — `scripts/dev-mail-server.sh`: Stalwart 0.15.5 (0.16 moved settings into its database behind a
  separate CLI), checksum-pinned, loopback only, local test CA via `SSL_CERT_FILE`. Advertises MOVE, UIDPLUS,
  CONDSTORE, QRESYNC and IDLE. Default limit of 5 SMTP connections a second per IP; seeding is paced.
