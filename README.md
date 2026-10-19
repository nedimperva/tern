<div align="center">

<img src="src-tauri/icons/icon.svg" alt="" width="96" height="96">

# Tern

**A fast, local-first, keyboard-first mail client for any IMAP account.**

[![check](https://github.com/nedimperva/tern/actions/workflows/check.yml/badge.svg)](https://github.com/nedimperva/tern/actions/workflows/check.yml)
[![release](https://img.shields.io/github/v/release/nedimperva/tern?include_prereleases&sort=semver)](https://github.com/nedimperva/tern/releases)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Linux first, then Windows · Rust · Tauri 2 · SolidJS · SQLite

</div>

> [!WARNING]
> **Tern is early alpha software (0.3.x).** It syncs and sends real mail and its author uses it every day, but
> expect rough edges. Try it with a test account, or keep another mail client around. Installers are not
> code-signed yet.

## Why Tern

Everything you see comes from a SQLite database on your device, so lists, threads and search never wait on the
network. When you archive, star or send, the change shows at once and goes to the server in the background after
a 5-second undo window. If you're offline, it goes once you're back.

## Features

- **Any IMAP/SMTP account.** IDLE for new mail, QRESYNC for fast resyncs, headers first so the inbox fills quickly.
  Gmail and Google Workspace sign in with Google in the browser, or with an app password. See [Gmail](#gmail).
- **Keyboard first.** Gmail-style keys and a command bar (`Ctrl K`) for every action. See [Keys](#keys).
- **Undo everything.** Archive, move, star and send wait 5 seconds before reaching the server; `z` takes them back.
  A send that may already have gone out is never retried on its own.
- **Triage.** Important / Other splits, local snooze, and fast full-text search with filters.
- **Compose.** Drafts, attachments, signatures, address autocomplete, snippets (`;`) and quoting a selection.
- **Desktop integration.** Tray icon, notifications, background running, start at login and `mailto:` links.
- **Private by default.** Remote images are blocked until you load them, mail HTML runs without scripts, sender
  logos are off unless you turn them on, and there is no telemetry.

## Install

Download the latest build from [Releases](https://github.com/nedimperva/tern/releases):

| System | File |
|---|---|
| Arch, Omarchy | `yay -S tern-bin` (from the AUR) |
| Linux | `.AppImage` (any distro), `.deb` (Debian/Ubuntu), `.rpm` (Fedora/openSUSE) |
| Windows 10/11 | `-setup.exe` or `.msi` |

The AppImage and the Windows installers update themselves: a new version downloads in the background and
"Restart to update" appears in the status strip. AUR, `.deb` and `.rpm` installs update through the package
manager. What changed in each version is in [CHANGELOG.md](CHANGELOG.md).

On Hyprland the window's class is `tern`. It tiles like any window (Tern's minimum is 720×480); to float it
instead, add a rule to `~/.config/hypr/hyprland.lua` on Omarchy:

```lua
o.window("^(tern)$", { float = true, center = true, size = { 1280, 820 } })
```

The launcher entry has a **Compose** action (`tern --compose`), so a launcher such as Walker can start a new
message directly.

On Linux, passwords are kept by the Secret Service, so a keyring such as gnome-keyring or KWallet must be running
and unlocked. On Windows, SmartScreen warns on first run because the installer is not signed yet; choose
"More info" → "Run anyway".

## Gmail

Gmail syncs over IMAP like any other account, with no Gmail API quotas in the way. To add one, either:

- choose **Continue with Google** and sign in in your browser. Tern stores no password, only a Google token in
  the system keyring; or
- use an [app password](https://myaccount.google.com/apppasswords) (needs 2-Step Verification).

An account on an app password can switch to Google sign-in later in Settings.

"Continue with Google" needs a Google OAuth client built into the app. The source doesn't ship one: if you build
Tern yourself, create your own (free, about ten minutes) and put it in `secrets/google-client.json`. Without one,
Gmail works with an app password. Step-by-step setup, the Testing and production limits, and troubleshooting are
in [docs/gmail.md](docs/gmail.md).

## Security and privacy

- Passwords and Google sign-in tokens live only in the OS keyring (Credential Manager, Secret Service or
  Keychain), never in the database or in files.
- Google sign-in runs in your own browser with PKCE, so Tern never sees your Google password.
- IMAP and SMTP use TLS (rustls with the platform's certificate verifier). Nothing links OpenSSL.
- Mail HTML is untrusted: it renders in a sandboxed frame with no scripts, under a content security policy that
  blocks remote content until you choose "Load images". Links open in your browser.
- Unless you load a message's images or turn on sender logos, Tern talks only to your mail servers. It sends no
  analytics or crash reports.

Found a vulnerability? Please report it privately; see [SECURITY.md](SECURITY.md).

## Building from source


### Windows

1. Install Rust from https://rustup.rs, using the default MSVC toolchain.
2. Install the Visual Studio Build Tools with the "Desktop development with C++" workload. On Windows 11 the WebView2
   runtime is already there.

### Linux (Arch, including Omarchy)

```sh
sudo pacman -S --needed base-devel rustup nodejs npm webkit2gtk-4.1 libayatana-appindicator librsvg \
  openssl gnome-keyring libsecret
rustup default stable
```

Passwords are stored through the Secret Service, so a keyring such as gnome-keyring must be running and unlocked.
On Wayland, Tern sets `WEBKIT_DISABLE_DMABUF_RENDERER=1` itself, because WebKitGTK's DMA-BUF renderer can leave
the window blank or crash on some setups (NVIDIA among them). Set the variable to `0` before starting Tern to opt out.

### Linux (Debian/Ubuntu)

```sh
sudo apt install build-essential curl wget file libssl-dev pkg-config \
  libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev libdbus-1-dev
curl https://sh.rustup.rs -sSf | sh
```

### Then, on any system

```sh
npm install
npm run tauri dev       # the app, with hot reload for the UI
npm run tauri build     # an installer: .msi/.exe on Windows, .deb/.rpm/.AppImage on Linux
```

For "Continue with Google", add your own Google OAuth client first: see
[Building Tern with Google sign-in](docs/gmail.md#building-tern-with-google-sign-in).

To work on the UI alone, run `npm run dev` and open http://localhost:1420. With no Tauri around, the UI runs
against a fake mailbox of 5,000 messages.

```sh
cargo test --workspace                                       # all tests
cargo run --release -p tern-core --example store_bench       # timings
```

### A local mail server for testing

Development uses a local IMAP/SMTP server, never a real mailbox. `scripts/dev-mail-server.sh` sets up
[Stalwart](https://stalw.art) 0.15 on 127.0.0.1 (IMAPS 1993, IMAP + STARTTLS 1143, SMTPS 1465, SMTP + STARTTLS 1587) with one test account and a local
test CA. Nothing needs root, and the system trust store is left alone: Tern trusts the test CA only when
started through the script.

```sh
scripts/dev-mail-server.sh setup      # once: download (checksum-verified), CA, config, test account
scripts/dev-mail-server.sh start      # in its own terminal
scripts/dev-mail-server.sh seed 20    # an Archive folder and 20 test messages
scripts/dev-mail-server.sh account    # what to type into "Add an account"
scripts/dev-mail-server.sh tern       # npm run tauri dev, trusting the test CA
```

CI (`.github/workflows/check.yml`) runs on every pull request, on Linux and Windows: the frontend build, then
`cargo fmt --check` (Linux), `cargo clippy --workspace --all-targets -- -D warnings` and `cargo test --workspace`.
Run the same before pushing. The Linux job installs the Debian/Ubuntu packages listed above.

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
| `h` / `Shift H` | snooze / back from snooze now |
| `Tab` | next split (Important, Other, Starred) |
| `c` | compose |
| `r` | reply (with text selected in the message, quote just that) |
| `v` | view the conversation's attachments (`←` / `→` between them) |
| `Ctrl Enter` | send |
| `;` | insert a snippet while writing (`;shortcut` then `Space`) |
| `/` | search |
| `g i` | Inbox (Important) |
| `g h` | Snoozed |
| `g ;` | edit snippets |
| `Ctrl Q` | quit (closing the window keeps Tern in the tray) |

## Speed targets

| What | Target |
|---|---|
| Moving down the list, per key | < 5 ms |
| One page of a list from the store | < 1 ms |
| Search across 50,000 messages | < 10 ms |
| Opening a thread | < 50 ms |
| Archiving 50 messages | < 20 ms |

## Project layout


```
crates/tern-core/        the engine (Rust, no UI)
  src/store.rs           SQLite schema, list/thread/search queries, the outbox with undo
  src/sync.rs            IMAP sync worker: folders, new mail, flags, sending the outbox
  src/imap.rs            the only code that talks to the IMAP library (io-imap)
  src/mime.rs            parsing raw messages
  src/smtp.rs            sending
  src/secrets.rs         passwords in Credential Manager / Secret Service / Keychain
  src/presets.rs         server settings for well-known providers
  examples/store_bench.rs  timings on a 50,000-message mailbox
src-tauri/               the desktop shell: commands the UI calls, one sync worker per account
src/                     the UI (SolidJS): virtualized list, thread view, compose, command bar
```

## Roadmap

Delivery follows milestones: safe foundation → Linux private alpha → focused Linux beta → Windows release →
expansion. Tern is in the Linux beta now. Next up are Gmail labels, wider provider testing and Linux packaging.
Optional AI (off by default), calendar and more providers come later. See [docs/PLAN.md](docs/PLAN.md).

## Contributing

Bug reports, ideas and pull requests are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) first.

## License

[MIT](LICENSE) © Nedim Perva
