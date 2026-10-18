//! Writes a generated mailbox (see `common/mailbox.rs`) to a store file, to try the UI on a big mailbox:
//!
//!     cargo run --release -p tern-core --example gen_mailbox -- /tmp/tern-100k.db 100000
//!     TERN_DB=/tmp/tern-100k.db npm run tauri dev
//!
//! The account points at `imap.invalid`, so Tern shows it offline and never reaches a real server.

#[path = "common/mailbox.rs"]
mod mailbox;

use std::time::Instant;

use anyhow::{bail, Context};

fn main() -> anyhow::Result<()> {
    let mut args = std::env::args().skip(1);
    let path = args.next().context("usage: gen_mailbox PATH [MESSAGES]")?;
    let messages: u32 = args.next().map(|n| n.parse()).transpose()?.unwrap_or(100_000);
    if std::path::Path::new(&path).exists() {
        bail!("{path} exists; pick a new file so no mail database is overwritten");
    }
    let store = tern_core::Store::open(std::path::Path::new(&path))?;
    let started = Instant::now();
    mailbox::generate(&store, messages)?;
    println!("{messages} messages in {path} ({:.1} s)", started.elapsed().as_secs_f64());
    println!("Try it: TERN_DB={path} npm run tauri dev");
    Ok(())
}
