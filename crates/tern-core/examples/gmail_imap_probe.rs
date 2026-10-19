//! The IMAP half of the M0 Gmail backend comparison (docs/research/gmail-backend-decision.md): the same numbers
//! as `gmail_probe`, over IMAP with the app password Tern already keeps for the account.
//!
//!     cargo run --release -p tern-core --example gmail_imap_probe -- you@gmail.com
//!
//! Read-only: it selects All Mail and fetches headers with BODY.PEEK, so nothing is marked read or changed.
//! Headers are fetched as Tern's sync fetches them: the list's fields, size, flags and structure, 500 at a time.

use std::time::Instant;

use anyhow::{Context, Result};
use tern_core::{imap, secrets, Security};

/// The first screen: this many newest messages with their headers.
const PAGE: usize = 100;
/// As `sync::HEADER_CHUNK`.
const CHUNK: usize = 500;

fn set(uids: &[u32]) -> String {
    uids.iter().map(u32::to_string).collect::<Vec<_>>().join(",")
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<()> {
    let email = std::env::args().nth(1).context("Give the Gmail address Tern signs in with")?;
    let password = secrets::password(&email)?;

    let started = Instant::now();
    let mut s = imap::connect("imap.gmail.com", 993, Security::Tls, &email, &password).await?;
    let signed_in = started.elapsed();

    let folders = s.folders().await?;
    let all_mail = folders
        .iter()
        .find(|f| f.attributes.iter().any(|a| a == "all"))
        .map(|f| f.name.clone())
        .unwrap_or_else(|| "[Gmail]/All Mail".into());

    let t = Instant::now();
    let selected = s.select(&all_mail).await?;
    let mut uids: Vec<u32> = s.uids().await?.into_iter().collect();
    uids.sort_unstable_by(|a, b| b.cmp(a));
    let listed = t.elapsed();

    // The first screen: the newest messages' headers in one command.
    let t = Instant::now();
    let first = s.headers(&set(&uids[..PAGE.min(uids.len())])).await?;
    let first_screen = t.elapsed();

    // Everything, newest first, as the sync's backfill would.
    let t = Instant::now();
    let (mut got, mut bytes) = (0usize, 0usize);
    for chunk in uids.chunks(CHUNK) {
        let fetched = s.headers(&set(chunk)).await?;
        got += fetched.len();
        bytes += fetched.iter().filter_map(|f| f.header.as_ref()).map(Vec::len).sum::<usize>();
    }
    let backfill = t.elapsed();
    let _ = s.logout().await;

    println!("| IMAP ({all_mail}) | Measured |");
    println!("|---|---|");
    println!("| Sign-in (TCP, TLS, LOGIN) | {:.0} ms |", signed_in.as_secs_f64() * 1000.0);
    println!("| Folders | {} |", folders.len());
    println!(
        "| SELECT + UID SEARCH ALL | {:.0} ms, {} messages ({} listed) |",
        listed.as_secs_f64() * 1000.0,
        selected.exists,
        uids.len()
    );
    println!(
        "| First screen ({} messages with headers, one command) | {:.2} s, {} came back |",
        PAGE.min(uids.len()),
        first_screen.as_secs_f64(),
        first.len()
    );
    println!(
        "| Full header download ({} commands of {CHUNK}) | {:.1} s, {got} of {} came back, {:.1} MB of headers |",
        uids.len().div_ceil(CHUNK),
        backfill.as_secs_f64(),
        uids.len(),
        bytes as f64 / 1_000_000.0
    );
    println!("\nNo quota applies; Gmail limits IMAP by bandwidth per day (2,500 MB down).");
    Ok(())
}
