//! Package 01 probe: async-imap 0.12 over tokio-rustls against the dev mail server.

use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Context, Result};
use async_imap::extensions::idle::IdleResponse;
use async_imap::imap_proto::{MailboxDatum, Response};
use async_imap::types::{Fetch, UnsolicitedResponse};
use async_imap::{Authenticator, Client, Session};
use futures::TryStreamExt;
use imap_probe::*;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::TcpStream;
use tokio_rustls::client::TlsStream;

const FOLDER: &str = "probe-async-imap";
const NAIVE_FOLDER: &str = "probe-async-imap-naive";
type Tls = TlsStream<TcpStream>;

async fn login() -> Result<Session<Tls>> {
    let mut client = Client::new(tls_connect(IMAPS).await?);
    client.read_response().await?.context("no greeting")?;
    client.login(USER, password()?).await.map_err(|(e, _)| e.into())
}

struct Plain(String, String);
impl Authenticator for Plain {
    type Response = String;
    fn process(&mut self, _: &[u8]) -> String {
        format!("\0{}\0{}", self.0, self.1)
    }
}

struct XOAuth2;
impl Authenticator for XOAuth2 {
    type Response = Vec<u8>;
    fn process(&mut self, challenge: &[u8]) -> Vec<u8> {
        // The first call carries no challenge: send the token. A later one is Gmail's error JSON,
        // which RFC 7628 answers with an empty response.
        if challenge.is_empty() {
            format!("user={USER}\x01auth=Bearer not-a-real-token\x01\x01").into_bytes()
        } else {
            Vec::new()
        }
    }
}

async fn connect_tls() -> Result<String> {
    let mut s = login().await?;
    let caps = s.capabilities().await?;
    s.logout().await?;
    Ok(format!("{} capabilities", caps.iter().count()))
}

async fn starttls() -> Result<String> {
    // No STARTTLS helper: greet, ask for it by hand, then rebuild the client on the TLS stream.
    let mut plain = Client::new(tcp_connect(IMAP_STARTTLS).await?);
    plain.read_response().await?.context("no greeting")?;
    plain.run_command_and_check_ok("STARTTLS", None).await?;
    let tcp = plain.into_inner();
    let tls = tls_connector()?.connect(server_name(), tcp).await?;
    let client = Client::new(tls);
    let mut s = client.authenticate("PLAIN", Plain(USER.into(), password()?)).await.map_err(|(e, _)| e)?;
    s.select("INBOX").await?;
    s.logout().await?;
    Ok("STARTTLS by hand, then AUTHENTICATE PLAIN".into())
}

async fn xoauth2_rejected(
    stream: impl AsyncRead + AsyncWrite + Unpin + Send + std::fmt::Debug,
) -> Result<String> {
    let mut client = Client::new(stream);
    client.read_response().await?.context("no greeting")?;
    match client.authenticate("XOAUTH2", XOAuth2).await {
        Ok(_) => bail!("a fake token was accepted"),
        Err((e, _)) => Ok(format!("rejected cleanly: {e}")),
    }
}

async fn headers_first() -> Result<String> {
    let mut s = login().await?;
    s.select(FOLDER).await?;
    let items = "(UID FLAGS INTERNALDATE RFC822.SIZE BODYSTRUCTURE \
                 BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE MESSAGE-ID REFERENCES)])";
    let fetches: Vec<Fetch> = s.uid_fetch("1:*", items).await?.try_collect().await?;
    let complete = fetches
        .iter()
        .filter(|f| f.uid.is_some() && f.size.is_some() && f.internal_date().is_some())
        .filter(|f| f.bodystructure().is_some() && f.header().is_some_and(|h| !h.is_empty()))
        .count();
    s.logout().await?;
    if complete != fetches.len() || complete != (SMALL + 1) as usize {
        bail!("{complete} of {} complete", fetches.len());
    }
    Ok(format!("{complete} messages, every item parsed"))
}

async fn qresync() -> Result<String> {
    let mut s = login().await?;
    s.run_command_and_check_ok("ENABLE QRESYNC").await?;
    let mailbox = s.select_condstore(FOLDER).await?;
    let validity = mailbox.uid_validity.context("no UIDVALIDITY")?;
    let modseq = mailbox.highest_modseq.context("no HIGHESTMODSEQ")?;
    s.run_command_and_check_ok("UNSELECT").await?;

    let gone = change_out_of_band(FOLDER).await?;

    // VANISHED and the changed FETCHes are "unsolicited" here. They go to a channel that holds 100 and drops
    // the rest without a word, so drain it from a second task while the SELECT runs.
    let rx = s.unsolicited_responses.clone();
    let drain = tokio::spawn(async move {
        let (mut vanished, mut changed) = (Vec::new(), 0u32);
        while let Ok(Ok(item)) = tokio::time::timeout(Duration::from_secs(2), rx.recv()).await {
            if let UnsolicitedResponse::Other(data) = item {
                match data.parsed() {
                    Response::Vanished { uids, .. } => {
                        vanished.extend(uids.iter().flat_map(|r| r.clone()));
                    }
                    Response::Fetch(..) => changed += 1,
                    _ => {}
                }
            }
        }
        (vanished, changed)
    });
    s.run_command_and_check_ok(format!("SELECT \"{FOLDER}\" (QRESYNC ({validity} {modseq}))")).await?;
    let (vanished, changed) = drain.await?;
    s.logout().await?;

    let note = format!("vanished {:?}, changed {changed} (expected {gone:?} and {FLAGGED})", vanished);
    if vanished != gone || changed != FLAGGED {
        bail!(note);
    }
    Ok(note)
}

/// The same resync used the obvious way: run the SELECT, then read the channel.
async fn qresync_naive() -> Result<String> {
    prepare_folder(NAIVE_FOLDER).await?;
    let mut s = login().await?;
    s.run_command_and_check_ok("ENABLE QRESYNC").await?;
    let mailbox = s.select_condstore(NAIVE_FOLDER).await?;
    let (validity, modseq) = (mailbox.uid_validity.unwrap(), mailbox.highest_modseq.unwrap());
    s.run_command_and_check_ok("UNSELECT").await?;
    change_out_of_band(NAIVE_FOLDER).await?;
    s.run_command_and_check_ok(format!("SELECT \"{NAIVE_FOLDER}\" (QRESYNC ({validity} {modseq}))")).await?;
    let (mut vanished, mut changed) = (0, 0);
    while let Ok(item) = s.unsolicited_responses.try_recv() {
        if let UnsolicitedResponse::Other(data) = item {
            match data.parsed() {
                Response::Vanished { .. } => vanished += 1,
                Response::Fetch(..) => changed += 1,
                _ => {}
            }
        }
    }
    s.logout().await?;
    let note =
        format!("received {changed} of {FLAGGED} changes, {vanished} VANISHED line(s); no error raised");
    if changed != FLAGGED {
        bail!(note);
    }
    Ok(note)
}

async fn idle() -> Result<String> {
    let mut s = login().await?;
    s.select("INBOX").await?;
    let mut handle = s.idle();
    handle.init().await?;
    let sent = tokio::spawn(async {
        tokio::time::sleep(Duration::from_millis(300)).await;
        smtp_deliver("idle async-imap").await.map(|_| Instant::now())
    });
    let (wait, _stop) = handle.wait_with_timeout(Duration::from_secs(20));
    let response = wait.await?;
    let arrived = Instant::now();
    let delivered = sent.await??;
    // New mail shows as EXISTS, or as STATUS with a message count (Stalwart sends the latter).
    let is_new_mail = matches!(&response, IdleResponse::NewData(d)
        if matches!(d.parsed(), Response::MailboxData(MailboxDatum::Exists(_) | MailboxDatum::Status { .. })));
    let done_start = Instant::now();
    let mut s = handle.done().await?;
    let done_ms = done_start.elapsed().as_millis();
    s.logout().await?;
    if !is_new_mail {
        bail!("woke with {response:?}");
    }
    Ok(format!(
        "woke {} ms after SMTP accepted; DONE took {done_ms} ms",
        arrived.saturating_duration_since(delivered).as_millis()
    ))
}

async fn uid_move() -> Result<String> {
    let mut s = login().await?;
    s.select(FOLDER).await?;
    s.uid_mv("1", "Archive").await?;
    s.logout().await?;
    // uid_mv returns (): the COPYUID code with the message's new UID in Archive is not surfaced.
    Ok("moved; new UID (COPYUID) not returned".into())
}

async fn big_body() -> Result<String> {
    let mut s = login().await?;
    s.select(FOLDER).await?;
    let before = rss_mb();
    let fetches: Vec<Fetch> =
        s.uid_fetch((SMALL + 1).to_string(), "BODY.PEEK[]").await?.try_collect().await?;
    let len = fetches.first().and_then(|f| f.body()).map_or(0, <[u8]>::len);
    let held = rss_mb();
    s.logout().await?;
    if len < BIG_BYTES {
        bail!("body was {len} bytes");
    }
    Ok(format!(
        "{} MB body; RSS {before:.0} → {held:.0} MB while held (whole body in memory)",
        len / 1_000_000
    ))
}

async fn gmail_items() -> Result<String> {
    let mut client = Client::new(fake_server(vec![
        Say::Greeting("* OK Gimap ready\r\n"),
        Say::Reply("{tag} OK user@gmail.com authenticated (Success)\r\n"),
        Say::Reply("* 1 EXISTS\r\n{tag} OK [READ-WRITE] [Gmail]/All Mail selected. (Success)\r\n"),
        Say::Reply(GMAIL_FETCH),
    ]));
    client.read_response().await?.context("no greeting")?;
    let mut s = client.login("user@gmail.com", "x").await.map_err(|(e, _)| anyhow!(e))?;
    s.select("[Gmail]/All Mail").await?;
    let fetches: Vec<Fetch> =
        s.uid_fetch("4", "(UID FLAGS X-GM-MSGID X-GM-THRID X-GM-LABELS)").await?.try_collect().await?;
    let f = fetches.first().context("no FETCH parsed")?;
    let seen = f.flags().any(|fl| matches!(fl, async_imap::types::Flag::Seen));
    if f.uid != Some(4) || !seen {
        bail!("UID {:?}, seen {seen}", f.uid);
    }
    // imap-proto parses X-GM-LABELS/MSGID/THRID into typed values; Fetch just has no shortcut method for them.
    Ok("UID and FLAGS parsed; X-GM-* parsed by imap-proto, no Fetch accessor".into())
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<()> {
    prepare_folder(FOLDER).await?;
    let mut r = Report::default();
    r.check("TLS connect + login", connect_tls()).await;
    r.check("STARTTLS + AUTH PLAIN", starttls()).await;
    r.check("XOAUTH2 rejected (dev server)", async { xoauth2_rejected(tls_connect(IMAPS).await?).await })
        .await;
    r.check(
        "XOAUTH2 Gmail error challenge",
        xoauth2_rejected(fake_server(vec![
            Say::Greeting("* OK Gimap ready\r\n"),
            Say::Reply("+ \r\n"),
            Say::Reply(GMAIL_XOAUTH2_CHALLENGE),
            Say::Reply("{tag} NO [AUTHENTICATIONFAILED] Invalid credentials (Failure)\r\n"),
        ])),
    )
    .await;
    r.check("headers-first fetch", headers_first()).await;
    r.check("QRESYNC resync", qresync()).await;
    r.check("QRESYNC, channel read after", qresync_naive()).await;
    r.check("IDLE new mail", idle()).await;
    r.check("UID MOVE", uid_move()).await;
    r.check("20 MB body", big_body()).await;
    r.check("Gmail X-GM-* items", gmail_items()).await;
    r.print("async-imap 0.12");
    Ok(())
}
