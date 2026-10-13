# Sprint 13 — Windows

**Week 14.** Same app, native on Windows 10/11.

## Goal

`npm run tauri build` on Windows produces an MSI and an NSIS installer; the app uses Credential Manager,
WebView2, Windows notifications and tray; `mailto:` registration works; fonts and spacing look right.

## Tasks

### Build
- [ ] Rust MSVC toolchain, VS Build Tools "Desktop development with C++"; WebView2 runtime is on Windows 11, NSIS installer bootstraps it on 10.
- [ ] `rustls` means no OpenSSL headaches; confirm `cargo build --release` is clean on Windows with no `-sys` crates needing vcpkg.
- [ ] `keyring` feature `windows-native` already on; verify OAuth JSON fits Credential Manager's 2,560-byte limit (split across two entries if not).
- [ ] `tauri.conf.json` → `bundle.windows`: `wix` and `nsis` targets, `webviewInstallMode: downloadBootstrapper`, per-user install, code signing left unsigned for now (SmartScreen will warn; document it).

### Platform behaviour
- [ ] Notifications via the plugin (WinRT toasts); click-through to the conversation; tray via the core tray API.
- [ ] `mailto:` registration through the deep-link plugin (registry under `HKCU`); "Make default" opens `ms-settings:defaultapps`.
- [ ] Autostart via the plugin (registry `Run` key).
- [ ] Key display: `Ctrl` everywhere; `Alt` menus do not exist; make sure `Ctrl+K`, `Ctrl+Enter`, `Ctrl+Shift+…` are not swallowed by WebView2 (`Ctrl+F` and `F5` need `preventDefault`).
- [ ] Fonts: keep bundled Inter; fall back to Segoe UI only if the user picks "system font". Check ClearType rendering at 100 % / 125 % / 150 %.
- [ ] Window: custom title bar? No — keep the native frame in v1; dark title bar via `tauri`'s `theme` option.
- [ ] Sleep/resume and network change via `tokio` timers (D-Bus code is `#[cfg(target_os = "linux")]`).
- [ ] Paths: `app_data_dir()` under `%APPDATA%\app.tern.mail`; attachments cache under `%LOCALAPPDATA%`.

### CI
- [ ] GitHub Actions `windows-latest` job: `cargo test --workspace`, `npm run tauri build`, upload artifacts. Runs on PRs to `main` from this sprint on.

## Cut first
NSIS (keep MSI), ms-settings deep link.

## Acceptance
- Install from the MSI on a clean Windows 11 VM; add Fastmail and Gmail; everything from the Sprint 0 acceptance list passes.
- Notification click opens the right conversation; tray menu works; `mailto:` from Edge opens compose.
- No OpenSSL DLLs in the install directory.
