# Tern: notes for agent sessions

Tern is a local-first desktop mail client for any IMAP account. It has a Rust engine (`crates/tern-core`), a Tauri 2
shell (`src-tauri`) and a SolidJS UI (`src`). The README covers layout, setup and keys; this file covers state and
decisions that aren't visible from the code.

## Where things stand (2026-10-13)

- The project was scaffolded on Windows, on a machine with **no Rust toolchain**. **No Rust code has ever been
  compiled.** Expect compile errors on the first `cargo build`, mostly where the code was written from memory of
  library APIs:
  - `async-imap` 0.10 (`sync.rs`): `Session` type, `select`/`uid_fetch`/`uid_search` return types, how capabilities
    and folder attributes (`NameAttribute`) are read. Roles are currently parsed from the attribute's `Debug` text,
    which is a stopgap: match on the enum variants once it compiles.
  - `mail-parser` 0.9 (`mime.rs`): `MessageParser`, `body_text`/`body_html`, address accessors.
  - `keyring` 3 (`secrets.rs`): `Entry::new`, `delete_credential`.
  - `lettre` 0.11 (`smtp.rs`): `AsyncSmtpTransport::<Tokio1Executor>::relay` / `starttls_relay`.
  - `tauri` 2 (`src-tauri/src/main.rs`, `commands.rs`): `Emitter`, `Manager`, `path().app_data_dir()`.
  Fix these against the real crate docs (docs.rs) rather than rewriting the design.
- The frontend builds (`npm run build`) and was tested in a browser against the fake mailbox in `src/api.ts`, which
  is used whenever `window.__TAURI_INTERNALS__` is missing. The real Tauri bridge has never run.
- The user is moving to Linux first: **Omarchy** (Arch + Hyprland, Wayland). Linux is now the primary target;
  Windows comes later.

## First steps for the next session

1. `cargo test -p tern-core` and fix until it compiles and the store/mime/sync tests pass.
2. `cargo run --release -p tern-core --example store_bench` and compare against the speed targets in the README.
3. `npm install && npm run tauri dev`. Check the window opens on Hyprland (see Linux notes below).
4. Add a real IMAP account (Fastmail or Gmail with an app password are the easiest) and check: folders appear, inbox
   fills newest-first, archive/star/read reach the server after the 5-second undo window, send works.
5. Then work down "Next" in the README, starting with IMAP IDLE.

## Design decisions to keep

- **Local-first.** The UI only ever reads SQLite. The network never sits between a keypress and the screen.
- **Outbox with undo.** Every change is applied locally, then queued in `outbox` with `not_before = now + 5s` and
  the data needed to revert it. `Store::undo(token)` reverts and deletes the queued rows. The sync worker sends due
  rows. Don't add code paths that talk to the server directly from a UI command (except `check_login`).
- **Moves and UIDs.** A moved message gets a new UID in the destination folder. Locally the row moves at once with
  `uid = NULL`; when the destination folder syncs, `insert_messages` claims that row by `Message-ID` instead of
  inserting a duplicate. Sync must never delete or overwrite rows with pending outbox ops (`pending_uids`).
- **Keyset paging** (`Cursor {date, id}`), never OFFSET. Bodies live in `bodies`, apart from `messages`, so list
  queries never touch them.
- **FTS5 is contentless** (`contentless_delete=1`), filled on insert, cleared by trigger.
- **Mail HTML is untrusted.** It renders in an `<iframe sandbox="allow-same-origin">` (no scripts) with a CSP that
  blocks remote images until the user clicks "Load images". Links open through the opener plugin. Keep it that way.
- **Passwords** only in the OS keyring (service `tern-mail`), never in SQLite or files.
- This is a fresh codebase. It was designed after studying Mach (`D:\GitHub\mach-main` on the Windows machine, a Swift
  Gmail/Outlook client licensed PolyForm Noncommercial). **Do not copy code from Mach**; it is a reference only.

## Linux / Omarchy notes

- System packages (Arch):
  `sudo pacman -S --needed base-devel rustup nodejs npm webkit2gtk-4.1 libappindicator-gtk3 librsvg openssl gnome-keyring libsecret`
  then `rustup default stable`.
- Passwords use the Secret Service D-Bus API (`keyring` feature `sync-secret-service`). That needs a running
  provider such as gnome-keyring with an unlocked "login" collection. If saving a password fails with "no such
  collection" or a D-Bus error, that's the cause, not a Tern bug. `seahorse` shows what's stored.
- WebKitGTK on Wayland: if the window is blank, or crashes on NVIDIA, run with
  `WEBKIT_DISABLE_DMABUF_RENDERER=1 npm run tauri dev`. If that fixes it, consider setting it in `main.rs` before
  the builder on Linux.
- Hyprland tiles new windows; Tauri's `minWidth`/`minHeight` still apply. To float it while testing:
  `windowrulev2 = float, class:^(tern)$` (check the real class with `hyprctl clients`).
- Fonts: the CSS asks for Segoe UI first and falls back to `system-ui`, which on Omarchy is whatever fontconfig
  picks. Consider adding "Inter" / the Omarchy default near the front if it looks off.
- Packaging later: `npm run tauri build` gives .deb/.rpm/AppImage. For Arch, a PKGBUILD is the natural target.

## Conventions

- Rust: `anyhow::Result` in the engine and commands; commands return `Result<T, String>` to the UI. Serde types are
  `camelCase` on the wire. Store methods are synchronous (rusqlite behind a `Mutex`); call them from async code via
  `spawn_blocking` if they grow slow.
- UI: SolidJS signals, no state library. Keyboard handling lives in `App.tsx`. Keep the JS bundle small (currently
  about 34 kB); avoid adding UI frameworks.
- Comments explain why, not what. Short, plain sentences in docs and UI text.

## Roadmap

The sprint-by-sprint plan lives in `docs/PLAN.md` with one file per sprint in `docs/sprints/` and the
research behind the decisions in `docs/research/`. Start a session by reading the current sprint file.
Work on a `sprint/NN-name` branch and open a PR to `main`; `main` must always build.
