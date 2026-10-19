//! The Gmail API half of the M0 backend comparison (docs/research/gmail-backend-decision.md). Signs in to the test
//! account through the browser, then measures what the API costs for Tern's first screen and for a full backfill:
//!
//!     cargo run --release -p tern-core --example gmail_probe -- secrets/google-client.json
//!
//! Read-only: it lists and reads, never changes the mailbox. Tokens are kept in the keyring under
//! `gmail-probe/oauth`; while the Cloud project is in Testing, Google expires them after 7 days.

use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};
use serde_json::Value;
use tern_core::oauth::{self, Provider, Tokens};
use tern_core::secrets;

const SCOPES: &[&str] = &["https://www.googleapis.com/auth/gmail.modify", "openid", "email"];
const API: &str = "https://gmail.googleapis.com/gmail/v1/users/me";
const KEY: &str = "gmail-probe";
/// The first screen: this many newest inbox messages with their headers.
const PAGE: usize = 100;
/// Published 2026 cost per method and per-user budget; check the project's own quota page too.
const UNITS_PER_MINUTE: f64 = 6_000.0;

struct Probe {
    agent: ureq::Agent,
    token: String,
    units: u64,
}

/// Requests in flight at once for the parallel first screen.
const IN_FLIGHT: usize = 10;

fn fetch(agent: &ureq::Agent, token: &str, path: &str) -> Result<Value> {
    let url = format!("{API}{path}");
    let mut response = agent
        .get(&url)
        .header("Authorization", &format!("Bearer {token}"))
        .call()
        .with_context(|| format!("GET {path}"))?;
    let status = response.status();
    let text = response.body_mut().read_to_string()?;
    if !status.is_success() {
        bail!("GET {path}: {status}: {text}");
    }
    Ok(serde_json::from_str(&text)?)
}

impl Probe {
    fn get(&mut self, path: &str, units: u64) -> Result<Value> {
        self.units += units;
        fetch(&self.agent, &self.token, path)
    }
}

fn open_browser(url: &str) -> Result<()> {
    println!("Opening the browser to sign in. If nothing opens, visit:\n{url}\n");
    let opener = if cfg!(windows) { "explorer" } else { "xdg-open" };
    let _ = std::process::Command::new(opener).arg(url).spawn();
    Ok(())
}

fn tokens(provider: &Provider) -> Result<Tokens> {
    if let Ok(saved) = secrets::tokens(KEY) {
        if saved.fresh(tern_core::store::now()) {
            return Ok(saved);
        }
        if let Some(refresh) = &saved.refresh_token {
            match oauth::refresh(provider, refresh) {
                Ok(t) => {
                    secrets::set_tokens(KEY, &t)?;
                    return Ok(t);
                }
                Err(e) if oauth::is_revoked(&e) => println!("The saved sign-in expired; signing in again."),
                Err(e) => return Err(e),
            }
        }
    }
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build()?;
    let t = runtime.block_on(oauth::sign_in(provider, None, open_browser, Duration::from_secs(300)))?;
    secrets::set_tokens(KEY, &t)?;
    Ok(t)
}

fn main() -> Result<()> {
    let path = std::env::args().nth(1).unwrap_or_else(|| "secrets/google-client.json".into());
    let json = std::fs::read_to_string(&path)
        .with_context(|| format!("No client file at {path}; see docs/research/gmail-test-setup.md"))?;
    let provider = Provider::google_from_json(&json, SCOPES)?;
    let started = Instant::now();
    let t = tokens(&provider)?;
    println!(
        "Signed in{} in {:.1} s\n",
        t.email.as_deref().map(|e| format!(" as {e}")).unwrap_or_default(),
        started.elapsed().as_secs_f64()
    );
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .http_status_as_error(false)
        .tls_config(
            ureq::tls::TlsConfig::builder().root_certs(ureq::tls::RootCerts::PlatformVerifier).build(),
        )
        .build()
        .into();
    let mut p = Probe { agent, token: t.access_token, units: 0 };

    let profile = p.get("/profile", 1)?;
    let (total, threads) =
        (profile["messagesTotal"].as_u64().unwrap_or(0), profile["threadsTotal"].as_u64().unwrap_or(0));
    let history_id = profile["historyId"].as_str().unwrap_or("").to_string();

    let labels = p.get("/labels", 1)?;
    let labels = labels["labels"].as_array().cloned().unwrap_or_default();
    let user: Vec<&str> =
        labels.iter().filter(|l| l["type"] == "user").filter_map(|l| l["name"].as_str()).collect();

    // The first screen: newest inbox ids, then each one's headers (what Tern's list shows). An inbox kept near zero
    // has too few to measure, so then it is the newest mail anywhere (All Mail), which costs the same.
    let ids_of = |list: &Value| -> Vec<String> {
        list["messages"]
            .as_array()
            .map(|m| m.iter().filter_map(|m| m["id"].as_str().map(Into::into)).collect())
            .unwrap_or_default()
    };
    let mut first = Instant::now();
    let mut ids = ids_of(&p.get(&format!("/messages?labelIds=INBOX&maxResults={PAGE}"), 5)?);
    let mut source = "inbox";
    if ids.len() < PAGE {
        first = Instant::now();
        ids = ids_of(&p.get(&format!("/messages?maxResults={PAGE}"), 5)?);
        source = "All Mail (the inbox holds fewer)";
    }
    let listed = first.elapsed();
    let fields =
        "metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date&metadataHeaders=Message-ID";
    let mut thread_ids = std::collections::HashSet::new();
    let mut multi_label = 0;
    for id in &ids {
        let m = p.get(&format!("/messages/{id}?format=metadata&{fields}"), 20)?;
        thread_ids.insert(m["threadId"].as_str().unwrap_or("").to_string());
        if m["labelIds"].as_array().is_some_and(|l| {
            l.iter().filter(|x| x.as_str().is_some_and(|x| x.starts_with("Label_"))).count() > 1
        }) {
            multi_label += 1;
        }
    }
    let page = first.elapsed();

    // The same messages again with IN_FLIGHT requests at a time: how much of the wait was the requests' order.
    let parallel = Instant::now();
    let chunks: Vec<&[String]> = ids.chunks(ids.len().div_ceil(IN_FLIGHT).max(1)).collect();
    let errors = std::thread::scope(|scope| {
        let workers: Vec<_> = chunks
            .into_iter()
            .map(|chunk| {
                let (agent, token) = (p.agent.clone(), p.token.clone());
                scope.spawn(move || {
                    chunk
                        .iter()
                        .filter(|id| {
                            fetch(&agent, &token, &format!("/messages/{id}?format=metadata&{fields}"))
                                .is_err()
                        })
                        .count()
                })
            })
            .collect();
        workers.into_iter().map(|w| w.join().unwrap_or(0)).sum::<usize>()
    });
    let parallel = parallel.elapsed();
    p.units += 20 * ids.len() as u64;

    // Incremental sync: what changed since the profile's historyId (nothing, a moment later).
    let changes = Instant::now();
    let history = p.get(&format!("/history?startHistoryId={history_id}"), 2)?;
    let changes = changes.elapsed();

    let backfill_units = total as f64 * 20.0 + (total as f64 / 500.0).ceil() * 5.0;
    println!("| Gmail API | Measured |");
    println!("|---|---|");
    println!("| Mailbox | {total} messages, {threads} conversations |");
    println!("| Labels | {} in all, {} user: {} |", labels.len(), user.len(), user.join(", "));
    println!("| First list call ({PAGE} ids from {source}) | {:.0} ms |", listed.as_secs_f64() * 1000.0);
    println!(
        "| First screen ({} messages with headers, one request each) | {:.1} s, {} conversations, {multi_label} with 2+ user labels |",
        ids.len(),
        page.as_secs_f64(),
        thread_ids.len()
    );
    println!(
        "| First screen again, {IN_FLIGHT} requests in flight | {:.1} s, {errors} refused |",
        parallel.as_secs_f64()
    );
    println!("| history.list, no changes | {:.0} ms |", changes.as_secs_f64() * 1000.0);
    println!(
        "| history answer | {} |",
        if history["history"].is_null() { "empty, as expected" } else { "had changes" }
    );
    println!("| Quota used by this run | {} units |", p.units);
    println!(
        "| Full metadata backfill (estimate) | {backfill_units:.0} units = {:.0} min at {UNITS_PER_MINUTE:.0} units/min, before any other use |",
        backfill_units / UNITS_PER_MINUTE
    );
    println!(
        "\nThe first pass made its requests one at a time, the second {IN_FLIGHT} at once; batch HTTP cuts round \
         trips, not quota units."
    );
    Ok(())
}
