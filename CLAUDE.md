# Tern: notes for agent sessions

Tern is a local-first desktop mail client for any IMAP account. It has a Rust engine (`crates/tern-core`), a Tauri 2
shell (`src-tauri`) and a SolidJS UI (`src`). The README covers layout, setup and keys; this file covers state and
decisions that aren't visible from the code.

## Where things stand (2026-10-15)

- The workspace compiles and runs on Linux (Omarchy/Hyprland); CI checks Linux and Windows on every PR. The app
  syncs real mail: the owner's SmarterMail account worked before it was paused, and the local dev server
  (`scripts/dev-mail-server.sh`, Stalwart) is what development uses now. No real-provider account is in use
  until the reliability gate passes (package 00).
- Built and tested against the dev server: sync (IDLE, QRESYNC, headers first), conversations and the keyboard
  shell (package 02), compose with drafts, attachments, signatures and autocomplete (package 03), received
  attachments open/save, and the status strip's "changes waiting" / problems lists (package 08's M1 slice).
  Search filters (package 06). Package 08's M2 slice: tray, background running, notifications, single instance,
  login start and `mailto:`. Package 05's basics: Important/Other splits and a local snooze (see its Decisions).
  Common-word search walks the date index (package 06 Decisions) and basic snippets (`;` in compose, package 07).
  Owner acceptance is tracked in `docs/acceptance/m1-alpha.md`; the owner ticks it.
  Package 14's Linux distribution slice: the AppImage and Windows builds update themselves from signed releases
  (`src-tauri/src/update.rs`; .deb/.rpm/AUR never do), release notes come from `CHANGELOG.md` (a tag without its
  section fails), and `packaging/aur/tern-bin` repackages the `.deb`. Releases are no longer pre-releases: the
  updater reads `releases/latest`. The signing key lives in the repo secrets and the owner's `~/.tauri/`.
  Package 08 polish (Pause sync, tray dot, notification Archive/Reply, quiet hours, `tern --compose`) and
  package 06 progress: the strip says "Downloading mail: X of Y" from each folder's server count (schema v18).
  `cargo run --release -p tern-core --example gen_mailbox -- PATH` makes a 100k test store; `TERN_DB=PATH` opens it.
  Package 10's first AI slice (2026-10-26, branch `sprint/10-ai`): Claude with the person's own Anthropic key,
  manual summaries and Write with AI, off by default (`crates/tern-core/src/ai/`). No local model yet (owner).
  Then OpenAI and Gemini, suggested replies (Q) and a per-account style note (schema v26), all on request.
  `store_bench` exits non-zero on a missed target and runs in CI with `TERN_BENCH_SLACK=3`.
  Reading (2026-10-27, branch `sprint/05-morning`, ui.md §4.2a–c): the column beside a conversation with what the
  newest message holds (`src/facts.ts`, local only), marks and notes (schema v27, CSS Custom Highlight API in
  `src/marks.ts`), newsletters in reading view by default. The fake's newest conversation and its newsletter carry
  facts and parts to try them on.
  Look (2026-10-28, canvas "Tern warm directions", A): warm tokens, Tern's own title bar (`decorations: false`,
  `src/components/TitleBar.tsx`) and the sidebar docked beside the list (`settings.sidebar`, `docked()` in state.ts).
- IMAP goes through **io-imap** 0.7 (provisional owner decision, package 01), and only `crates/tern-core/src/imap.rs`
  touches it. It is pinned exactly and needs `nom` with `alloc` (see `Cargo.toml`). Its parser drops FETCH
  responses that carry Gmail X-GM-* items. Gmail still goes through IMAP, signed in with Google (XOAUTH2), with labels
  read from label folders (owner decision 2026-10-19, `docs/research/gmail-backend-decision.md`).
- TLS is rustls with the platform verifier for IMAP and SMTP; nothing links OpenSSL. The verifier honours
  `SSL_CERT_FILE`, which is how the dev server's test CA is trusted. Each account stores `imap_security` and
  `smtp_security` (tls or starttls); never infer them from the port in code.
- **Debug builds use `<app data>/dev/mail.db`**, never the installed Tern's `mail.db`: migrations only go forward, so a
  dev build on a newer schema would leave the installed version unable to open its mail. To test with real mail,
  copy the installed database there first (SQLite backup API, Tern quit or not). Before running a *release* build
  from a branch over the real database, back it up. The keyring is shared: a dev sign-in stores the same entries.
- Schema changes go through `store::migrate()` (numbered steps on top of the v1 `SCHEMA`), each with a test that
  starts from the previous version. See `docs/research/data-model.md`.
- Gotchas: IMAP sockets need `TCP_NODELAY` (about 40 ms per command without it); io-imap's `starttls()` reads the
  greeting itself; its `auth_login` is SASL `AUTHENTICATE LOGIN`, the IMAP `LOGIN` command is `login`. It drops a
  response it cannot parse without an error (an X-GM-* item, a malformed literal): compare what came back with what
  was asked for.
  `rust-ini` is held at 0.21.1 in Cargo.lock: 0.21.3 added struct fields that break `tauri-plugin-deep-link` 2.6.2.
  Every write to the IMAP stream is flushed: rustls can keep the end of a long write (an APPEND) buffered, and
  then server and client wait on each other until the command times out.
- The user is moving to Linux first: **Omarchy** (Arch + Hyprland, Wayland). Linux is now the primary target;
  Windows comes later.

## Planning decisions (2026-10-13)

The owner approved a narrower first release and milestone delivery order in `docs/PLAN.md`:
safe foundation → Linux private alpha → focused Linux beta → Windows release → expansion.
Existing sprint numbers are work-package IDs, not weeks. Read each package's Delivery scope before its
checkboxes; deferred work does not automatically block a milestone. Keep Windows compiling/tested and
perform an early WebView2/keyring smoke test in M0; release polish is M3, not gated on calendar or AI.
The early Gmail IMAP/API comparison ran in M0; the owner chose IMAP with Google sign-in (2026-10-19).
Optional AI remains wanted, off by default, in expansion; remote transfers need accurate privacy/Google
policy review. No implementation or real-provider acceptance was completed by this documentation revision.

## First steps for the next session

1. `cargo test -p tern-core` and fix until it compiles and the store/mime/sync tests pass.
2. `cargo run --release -p tern-core --example store_bench` and compare against the speed targets in the README.
3. `npm install && npm run tauri dev`. Check the window opens on Hyprland (see Linux notes below).
4. Use a dedicated Fastmail test account after the M0 mutation/recovery safety checks (do not start with a primary inbox). Check: folders appear, inbox
   fills newest-first, archive/star/read reach the server after the 5-second undo window, send works.
5. Establish Linux/Windows CI and the early Windows smoke test. Follow milestone-selected slices in PLAN.md, not numeric sprint order or every item in README Next.

## Design decisions to keep

- **Local-first.** The UI only ever reads SQLite. The network never sits between a keypress and the screen.
- **Outbox with undo.** Every change is applied locally, then queued in `outbox` with `not_before = now + 5s` and
  the data needed to revert it. `Store::undo(token)` reverts and deletes the queued rows. The sync worker sends due
  rows. Don't add code paths that talk to the server directly from a UI command (except `check_login`, and
  `sync::download` for the first open of a received attachment, of a message's inline `cid:` images, or for Show
  original: a read, on its own connection).
  Failed work retries with backoff and stops after 5 tries, or at once on a permanent refusal (SMTP 5xx); it then
  waits in `outbox_problems` for retry or discard (discard reverts like undo). It is never dropped on its own, and a
  failure never stops the rest of the pass; only a lost connection does.
- **Uncertain sends are never resent on their own.** SMTP runs step by step (`smtp::transmit`): a failure up to
  DATA is safe to retry; a break after the message was written, or Tern stopping mid-send (`claimed = 2`), makes
  a `maybe_sent` problem the person resolves ("Send again" / "Don't send"). Sent mail gets a Message-ID at the
  sender's domain (lettre adds none by itself).
- **Queued uids are checked before use.** Ops carry the folder's UIDVALIDITY; on a mismatch, and for `waiting`
  messages (acted on before an earlier move went out), messages are found by Message-ID (SEARCH HEADER, else one
  FETCH of every Message-ID in the folder: Stalwart cannot search that header). A move's COPYUID fills in waiting
  work at once. Undo refuses a move that later queued work depends on. Tests for these run against
  `scripted::signed_in` (a scripted IMAP server) in `sync::tests::outbox`.
- **Folders follow the server.** Each connect (and any pass where a folder is refused) re-reads LIST; folders it no
  longer lists are dropped with their messages unless queued work or a draft still names them. A role the server
  marks with SPECIAL-USE belongs to that folder alone; name matches only fill roles nobody marked.
- **Moves and UIDs.** A moved message gets a new UID in the destination folder. Locally the row moves at once with
  `uid = NULL`; when the destination folder syncs, `insert_messages` claims that row by `Message-ID` instead of
  inserting a duplicate. Sync must never delete or overwrite rows with pending outbox ops (`pending_uids`).
- **Keyset paging** (`Cursor {date, id}`), never OFFSET. Bodies live in `bodies`, apart from `messages`, so list
  queries never touch them.
- **FTS5 is contentless** (`contentless_delete=1`), filled on insert, cleared by trigger.
- **Mail HTML is untrusted.** It renders in an `<iframe sandbox="allow-same-origin">` (no scripts) with a CSP that
  blocks remote images until the user clicks "Load images". Links open through the opener plugin. Keep it that way.
  The CSP lets fonts load from the app itself (Inter for text mail), nothing else. A picture attachment's card
  preview only reads a file already downloaded; expanding a message never downloads its files.
- **Passwords** only in the OS keyring (service `tern-mail`), never in SQLite or files. The AI keys too
  (`ai/<provider>`). The one exception is a backup the person asks for with a passphrase: `tern_core::backup` seals
  them in it, in the engine, so they never reach the window.
- **AI is opt-in and on request.** Every AI call goes through `ai::allowed` (on, feature on, account ticked) before
  the keyring is read or anything is sent. No background AI, no tools for the model, mail sent as material in tags,
  never attachments. Don't add an AI path that skips the gate.
- This is a fresh codebase. It was designed after studying Mach (`D:\GitHub\mach-main` on the Windows machine, a Swift
  Gmail/Outlook client licensed PolyForm Noncommercial). **Do not copy code from Mach**; it is a reference only.

## Linux / Omarchy notes

- System packages (Arch):
  `sudo pacman -S --needed base-devel rustup nodejs npm webkit2gtk-4.1 libayatana-appindicator librsvg openssl gnome-keyring libsecret`
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
- UI: SolidJS signals, no state library. The main window's state is module-level signals in `src/app/state.ts`;
  what the keys do is in `src/app/` (`bindings.ts` is the one key table), and `App.tsx` only lays it out. Keep the JS bundle small (about 250 kB,
  85 kB gzipped, at 1.3); avoid adding UI frameworks.
- Comments explain why, not what. Short, plain sentences in docs and UI text.

## Roadmap

The milestone plan lives in `docs/PLAN.md` with retained work-package files in `docs/sprints/` and the
research behind the decisions in `docs/research/`. Start a session by reading the current sprint file.
Work on a `sprint/NN-name` branch and open a PR to `main`; `main` must always build.
Before any UI work, read `docs/design/ui.md`; it holds the tokens, layout and review checklist. How to tick
tasks and mark a sprint complete is in `docs/sprints/README.md`.
