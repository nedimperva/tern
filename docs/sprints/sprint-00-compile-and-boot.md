# Sprint 0 — Compile and boot on Linux

**Status:** todo

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
- [ ] Install on the Omarchy machine: `sudo pacman -S --needed base-devel rustup nodejs npm webkit2gtk-4.1 libappindicator-gtk3 librsvg openssl gnome-keyring libsecret`, `rustup default stable`.
- [ ] Pin the toolchain: `rust-toolchain.toml` with `channel = "stable"` and `components = ["rustfmt", "clippy"]`.
- [ ] Add `LICENSE` (MIT, copyright Nedim Perva), fill `license = "MIT"` in all `Cargo.toml` and `package.json`.
- [ ] `.editorconfig`, `rustfmt.toml` (max_width 110 to match existing style), `.gitattributes` already present.

### Make `tern-core` compile
- [ ] Bump `async-imap` to `0.11` (active again: 0.11.2, Feb 2026). Read `docs.rs/async-imap/0.11` and fix
      `Session`, `select`, `uid_fetch`, `uid_search`, `capabilities`, `NameAttribute` usage in `sync.rs`.
      Replace the `Debug`-text role parsing with a match on `NameAttribute` variants.
- [ ] `mail-parser` 0.9 → check current (0.11.x). Fix `MessageParser`, `body_text`/`body_html`, address accessors in `mime.rs`.
- [ ] `keyring` 3: `Entry::new(service, user)?`, `set_password`, `get_password`, `delete_credential`.
- [ ] `lettre` 0.11: `AsyncSmtpTransport::<Tokio1Executor>::relay(host)?` / `starttls_relay`, `.credentials(...)`, `.build()`.
- [ ] `cargo test -p tern-core` green. Existing tests: store (insert/list/thread/search/outbox/undo), mime, sync batching and roles.
- [ ] `cargo run --release -p tern-core --example store_bench` and record numbers in this file under "Results".
- [ ] `cargo clippy -p tern-core -- -D warnings` clean (allow a few lints in `lib.rs` if they are noise).

### Make `src-tauri` compile and run
- [ ] Fix `tauri` 2 API use: `Emitter` for `app.emit`, `Manager` for `app.path().app_data_dir()`, `State`.
- [ ] Generate the missing icons (`icons/32x32.png`, `128x128.png`, `128x128@2x.png`) from `app-icon.png` with `npm run tauri icon app-icon.png`.
- [ ] On Linux, set `WEBKIT_DISABLE_DMABUF_RENDERER=1` in `main.rs` before the builder **only** when
      `WAYLAND_DISPLAY` is set and the env var is not already set. Document in README.
- [ ] Window opens on Hyprland. Check class with `hyprctl clients`; add the float rule to README if the class differs from `tern`.
- [ ] `npm install && npm run tauri dev` — fake mailbox must not appear (bridge detected), real `accounts` command returns `[]`.

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
store_bench, 50,000 messages:
  list page:
  thread open:
  search:
  archive 50:
```

## Notes for the agent
- Fix against the real crate docs; do not redesign. The design is in `CLAUDE.md`.
- If `async-imap` 0.11 is missing something (for example `Session::idle` shape changed), note it here; Sprint 1 decides on the library.
- Keep `commands.rs` thin. Anything that is not glue belongs in `tern-core`.

## Decisions

_None yet._

## Log

_No sessions yet._
