# Sprint 13 — Windows

**Status:** in progress

## Delivery scope

**M0 compile/smoke; M3 Windows release.** Compile/test CI plus a basic WebView2/compose/keyring smoke test starts in M0. Installer, notifications/tray, scaling, sleep/resume and release polish follow the focused Linux beta in M3. Calendar, AI, Outlook and a second Gmail backend are not prerequisites.

Package number is a stable ID, not a delivery week. [PLAN.md](../PLAN.md) defines order and release gates.

## Overview

Same app, native on Windows 10/11.

## Goal

`npm run tauri build` on Windows produces an MSI and an NSIS installer; the app uses Credential Manager,
WebView2, Windows notifications and tray; `mailto:` registration works; fonts and spacing look right.

## Tasks

### Build
- [x] Rust MSVC toolchain, VS Build Tools "Desktop development with C++"; WebView2 runtime is on Windows 11, NSIS installer bootstraps it on 10.
- [x] `rustls` means no OpenSSL headaches; confirm `cargo build --release` is clean on Windows with no `-sys` crates needing vcpkg.
- [x] `keyring` feature `windows-native` already on; verify OAuth JSON fits Credential Manager's 2,560-byte limit (split across two entries if not).
- [x] `tauri.conf.json` → `bundle.windows`: `wix` and `nsis` targets, `webviewInstallMode: downloadBootstrapper`, per-user install, code signing left unsigned for now (SmartScreen will warn; document it).

### Platform behaviour
- [x] Notifications via the plugin (WinRT toasts); click-through to the conversation; tray via the core tray API.
- [x] `mailto:` registration through the deep-link plugin (registry under `HKCU`); "Make default" opens `ms-settings:defaultapps`.
- [x] Autostart via the plugin (registry `Run` key).
- [x] Key display: `Ctrl` everywhere; `Alt` menus do not exist; make sure `Ctrl+K`, `Ctrl+Enter`, `Ctrl+Shift+…` are not swallowed by WebView2 (`Ctrl+F` and `F5` need `preventDefault`).
- [ ] Fonts: keep bundled Inter; fall back to Segoe UI only if the user picks "system font". Check ClearType rendering at 100 % / 125 % / 150 %.
- [x] Window: custom title bar? No — keep the native frame in v1; dark title bar via `tauri`'s `theme` option.
- [x] Sleep/resume and network change via `tokio` timers (D-Bus code is `#[cfg(target_os = "linux")]`).
- [x] Paths: `app_data_dir()` under `%APPDATA%\app.tern.mail`; attachments cache under `%LOCALAPPDATA%`.

### CI
- [x] GitHub Actions `windows-latest` job: `cargo test --workspace`, `npm run tauri build`, upload artifacts. Compile/test checks run on PRs from M0; add installer artifacts for M3.

## Cut first
NSIS (keep MSI), ms-settings deep link.

## Acceptance
- Install from the MSI on a clean Windows 11 VM; add Fastmail and Gmail; everything from the Sprint 0 acceptance list passes.
- Notification click opens the right conversation; tray menu works; `mailto:` from Edge opens compose.
- No OpenSSL DLLs in the install directory.

## Decisions

- 2026-10-20 — Windows notifications are toasts from `tauri-winrt-notification` (the crate Tauri's own plugin
  uses), not `notify-rust`: they report a click and their buttons while Tern runs, which in the tray it does. Body
  click opens the conversation; one conversation gets Archive and Reply, as on Linux. A build from source shows
  them under PowerShell's app id, since only the installer registers Tern's. A click on an old toast in the Action
  Center after Tern has quit does nothing (that needs a COM activator; not worth it while Tern lives in the tray).
- 2026-10-20 — The web view's own keys and menu go in released builds (`src/browserKeys.ts`): F5, Ctrl+R, Ctrl+P,
  Ctrl+F, Alt+Left and the like, and the right-click menu except on text fields and selections (also inside a
  message's frame). Builds from source keep them for development.
- 2026-10-20 — The title bar follows Tern's theme (`setTheme`), "System" leaves it to Windows.
- 2026-10-20 — Already true before this package: CI checks Windows on every PR, releases build the NSIS `.exe` and
  the `.msi` and sign them for the updater, passwords use Credential Manager (Google's tokens are well under its
  2,560-byte limit), received attachments are cached under `%LOCALAPPDATA%`, sleep/resume is noticed by a clock
  jump on every platform. The SmartScreen warning is in docs/beta.md. Fonts are Inter, bundled.

## Log

- 2026-10-20 — Audit of the package against 0.3.7 on the owner's Windows 11; built the toasts with actions, the
  browser keys and menu, the title bar theme, explicit `bundle.windows` settings (per-user NSIS, WebView2
  bootstrapper) and the [M3 checklist](../acceptance/m3-windows.md). Checked with clippy on Windows, `tsc`,
  `vite build`. Tried in `tauri build --debug --no-bundle` (production UI) on the owner's Windows 11 with a copy of
  the owner's database: F5, Ctrl+R, Ctrl+P, Ctrl+F and Alt+Left neither reload nor leave the page; the right-click
  menu is gone on the list and kept in the search field; the title bar is dark with Tern dark and light with Tern
  light on a light Windows. Notifications wait for the owner (they need new mail).

- 2026-10-20 — The owner tried the toasts in a build from #73: a click on the toast opens the conversation (after
  the `launch` fix), Reply opens a reply with nothing on top, Archive archives. Merged.
