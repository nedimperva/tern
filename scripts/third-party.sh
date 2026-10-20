#!/usr/bin/env bash
# Writes THIRD_PARTY.md: the licences of the Rust crates the app is built from (cargo-about, with
# packaging/about.toml) and of the JavaScript and fonts in its window (scripts/third-party.mjs).
# Needs `cargo install cargo-about --locked --features cli` once, and `npm install`.
set -euo pipefail
cd "$(dirname "$0")/.."
cargo about generate -c packaging/about.toml -m src-tauri/Cargo.toml packaging/about.hbs -o THIRD_PARTY.md
node scripts/third-party.mjs >> THIRD_PARTY.md
echo "THIRD_PARTY.md: $(grep -c '^## \|^### ' THIRD_PARTY.md) sections"
