# Tern

A fast, local-first mail app for Windows and Linux (and macOS) that works with any IMAP account.

Everything you see comes from a SQLite database on your device, so lists, threads and search never wait on the network.
When you archive, star or send, the change shows immediately and goes to the server in the background after a
5-second undo window. If you're offline, it goes once you're back.

## Layout

```
crates/tern-core/        the engine (Rust, no UI)
  src/store.rs           SQLite schema, list/thread/search queries, the outbox with undo
  src/sync.rs            IMAP sync worker: folders, new mail, flags, sending the outbox
  src/mime.rs            parsing raw messages
  src/smtp.rs            sending
  src/secrets.rs         passwords in Credential Manager / Secret Service / Keychain
  src/presets.rs         server settings for well-known providers
  examples/store_bench.rs  timings on a 50,000-message mailbox
src-tauri/               the desktop shell: commands the UI calls, one sync worker per account
src/                     the UI (SolidJS): virtualized list, thread view, compose, command bar
```

## Setup

**Windows**

1. Install Rust from https://rustup.rs, using the default MSVC toolchain.
2. Install the Visual Studio Build Tools with the "Desktop development with C++" workload. On Windows 11 the WebView2
   runtime is already there.

**Linux (Arch, including Omarchy)**

```sh
sudo pacman -S --needed base-devel rustup nodejs npm webkit2gtk-4.1 libappindicator-gtk3 librsvg \
  openssl gnome-keyring libsecret
rustup default stable
```

Passwords are stored through the Secret Service, so a keyring such as gnome-keyring must be running and unlocked.
If the window comes up blank on Wayland or NVIDIA, start it with `WEBKIT_DISABLE_DMABUF_RENDERER=1`.

**Linux (Debian/Ubuntu)**

```sh
sudo apt install build-essential curl wget file libssl-dev pkg-config \
  libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev libdbus-1-dev
curl https://sh.rustup.rs -sSf | sh
```

**Then, on either system:**

```sh
npm install
npm run tauri dev       # the app, with hot reload for the UI
npm run tauri build     # an installer: .msi/.exe on Windows, .deb/.rpm/.AppImage on Linux
```

To work on the UI alone, run `npm run dev` and open http://localhost:1420. With no Tauri around, the UI runs
against a fake mailbox of 5,000 messages.

```sh
cargo test -p tern-core                                      # engine tests
cargo run --release -p tern-core --example store_bench       # timings
```

## Keys

These follow Gmail's shortcuts. `Ctrl K` opens the command bar.

| | |
|---|---|
| `j` / `k` | next / previous message |
| `e` | archive |
| `#` | move to Trash |
| `s` | star |
| `Shift I` / `Shift U` | mark read / unread |
| `z` | undo |
| `c` | compose |
| `r` | reply |
| `Ctrl Enter` | send |
| `/` | search |
| `g i` | All Inboxes |

## Speed targets

| What | Target |
|---|---|
| Moving down the list, per key | < 5 ms |
| One page of a list from the store | < 1 ms |
| Search across 50,000 messages | < 5 ms |
| Opening a thread | < 50 ms |
| Archiving 50 messages | < 20 ms |

## Next

- IMAP IDLE on the inbox, so new mail appears within a second; replaces the 60-second poll in `sync.rs`
- CONDSTORE/QRESYNC, so checking a folder that hasn't changed costs one round trip
- Fetch headers and a short preview first, then whole bodies, so a new account fills its inbox faster
- STARTTLS on port 143, plus OAuth (XOAUTH2) for Gmail and Microsoft, since Microsoft no longer accepts passwords
- A conversation list (one row per thread) in place of the current one row per message
- Saving drafts to the server, attachments in compose, and copying sent mail to Sent where the server doesn't
- Notifications, a tray icon, starting at login, and auto-update on Windows
