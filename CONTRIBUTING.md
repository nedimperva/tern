# Contributing to Tern

Thanks for your interest in Tern. Bug reports, ideas and pull requests are all welcome.

## Before you start

- **Bugs:** search [existing issues](https://github.com/nedimperva/tern/issues) first, then open one with the
  bug template.
- **Features:** open an issue to talk it over before writing a large change. The order of work follows
  [docs/PLAN.md](docs/PLAN.md), so a feature may wait for its milestone.
- **Security problems:** report them privately, as [SECURITY.md](SECURITY.md) describes, not in an issue.

## Setting up

The [README](README.md#building-from-source) lists the system packages for Linux and Windows. Then:

```sh
npm install
npm run tauri dev
```

**Never develop against a real mailbox.** Use the local test server instead:

```sh
scripts/dev-mail-server.sh setup   # once
scripts/dev-mail-server.sh start   # in its own terminal
scripts/dev-mail-server.sh seed 20
scripts/dev-mail-server.sh tern
```

## Before you open a pull request

Run what CI runs:

```sh
npm run build
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

Then:

- Keep each pull request to one change, and explain what a user would notice.
- Add a test for engine changes. Store and sync behaviour is tested in `crates/tern-core`.
- Before UI work, read [docs/design/ui.md](docs/design/ui.md): it holds the design tokens, layout and review
  checklist.
- Schema changes go through `store::migrate()` with a test that starts from the previous version.

## Rules that keep mail safe

These come from [CLAUDE.md](CLAUDE.md) and the design docs. Pull requests that break them won't be merged:

- **Local first.** The UI reads only SQLite. No network call sits between a keypress and the screen.
- **Changes go through the outbox.** Every change is applied locally and queued with an undo window. Don't talk
  to the server directly from a UI command.
- **A send that may already have gone out is never retried automatically.**
- **Mail HTML is untrusted.** It stays in the sandboxed frame with no scripts and remote content blocked.
- **Passwords only go in the OS keyring.**
- **Don't copy code from other mail clients** unless their license allows it and you say where it came from.

## Style

- Rust: `anyhow::Result` in the engine. Commands return `Result<T, String>` to the UI. Serde types are
  `camelCase` on the wire.
- UI: SolidJS signals, no state library. Keep the bundle small and don't add UI frameworks.
- Comments say why, not what. Docs and UI text use short, plain sentences.

## Releases (maintainer)

1. Bump the version in `package.json`, `src-tauri/tauri.conf.json` and both `Cargo.toml` files, and turn
   `## [Unreleased]` in `CHANGELOG.md` into `## [0.3.2] - YYYY-MM-DD` (with a fresh empty Unreleased above it).
   Merge.
2. Push a tag such as `v0.3.2`. The `release` workflow builds the Windows installers (`-setup.exe`, `.msi`) and
   the Linux AppImage, `.deb` and `.rpm`, signs the updates and attaches everything, with `latest.json`, to a
   draft release whose notes are the version's CHANGELOG section. A tag without that section fails.
3. Try the draft's installers, then publish it. Installed AppImage and Windows copies see it within a day.
4. Update the AUR package: see [packaging/aur/README.md](packaging/aur/README.md).

The updater signing key is in the repository secrets (`TAURI_SIGNING_PRIVATE_KEY`, `..._PASSWORD`); the owner
keeps a backup. Installed copies only accept updates signed with it, so a lost key means asking everyone to
reinstall once.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
