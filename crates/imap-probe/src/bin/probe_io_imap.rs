//! Package 01 probe: io-imap 0.7 over tokio-rustls against the dev mail server.
//!
//! io-imap's commands are I/O-free coroutines. `Conn` below is the whole async driver Tern would need:
//! it answers the coroutines' read and write requests on a tokio stream, and `ImapClientAsync` turns that
//! into one async method per command.

use std::future::Future;
use std::mem;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};
use imap_probe::*;
use io_imap::client::{ImapClientAsync, ImapClientError};
use io_imap::codec::fragmentizer::Fragmentizer;
use io_imap::coroutine::{ImapCoroutine, ImapCoroutineState, ImapYield};
use io_imap::rfc2177::idle::{ImapIdle, ImapIdleOptions, ImapIdleYield};
use io_imap::rfc3501::fetch::ImapMessageFetchOptions;
use io_imap::rfc3501::select::ImapMailboxSelectOptions;
use io_imap::rfc6851::r#move::ImapMessageMoveOptions;
use io_imap::sasl::auth_plain::ImapAuthPlainOptions;
use io_imap::sasl::auth_xoauth2::ImapAuthXoauth2Options;
use io_imap::types::core::{AString, Vec1};
use io_imap::types::extensions::enable::CapabilityEnable;
use io_imap::types::fetch::{MacroOrMessageDataItemNames, MessageDataItem, MessageDataItemName, Section};
use io_imap::types::flag::{Flag, FlagFetch};
use io_imap::types::mailbox::Mailbox;
use io_imap::types::response::Data;
use io_imap::types::sequence::SequenceSet;
use io_imap::types::status::StatusDataItem;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::TcpStream;

const FOLDER: &str = "probe-io-imap";

struct Conn<S> {
    stream: S,
    fragmentizer: Fragmentizer,
}

impl<S: AsyncRead + AsyncWrite + Unpin + Send> Conn<S> {
    fn new(stream: S) -> Self {
        Self { stream, fragmentizer: Fragmentizer::new(100 * 1024 * 1024) }
    }
}

impl<S: AsyncRead + AsyncWrite + Unpin + Send> ImapClientAsync for Conn<S> {
    #[allow(clippy::manual_async_fn)]
    fn run<C, T, E>(&mut self, mut coroutine: C) -> impl Future<Output = Result<T, ImapClientError>> + Send
    where
        C: ImapCoroutine<Yield = ImapYield, Return = Result<T, E>> + Send,
        T: Send,
        E: Send,
        ImapClientError: From<E>,
    {
        async move {
            let mut buf = vec![0u8; 64 * 1024];
            let mut arg: Option<usize> = None;
            loop {
                match coroutine.resume(&mut self.fragmentizer, arg.take().map(|n| &buf[..n])) {
                    ImapCoroutineState::Complete(out) => return out.map_err(Into::into),
                    ImapCoroutineState::Yielded(ImapYield::WantsRead) => {
                        let n = self.stream.read(&mut buf).await?;
                        if n == 0 {
                            return Err(std::io::Error::from(std::io::ErrorKind::UnexpectedEof).into());
                        }
                        arg = Some(n);
                    }
                    ImapCoroutineState::Yielded(ImapYield::WantsWrite(bytes)) => {
                        self.stream.write_all(&bytes).await?;
                    }
                }
            }
        }
    }
}

type Tls = tokio_rustls::client::TlsStream<TcpStream>;

async fn login() -> Result<Conn<Tls>> {
    let mut c = Conn::new(tls_connect(IMAPS).await?);
    c.greeting().await?;
    c.auth_plain(None, USER, &password()?, ImapAuthPlainOptions::default()).await?;
    Ok(c)
}

fn mailbox(name: &str) -> Result<Mailbox<'static>> {
    Ok(Mailbox::try_from(name.to_string())?)
}

fn uid_opts() -> ImapMessageFetchOptions {
    ImapMessageFetchOptions { uid: true, ..Default::default() }
}

async fn connect_tls() -> Result<String> {
    let mut c = Conn::new(tls_connect(IMAPS).await?);
    c.greeting().await?;
    let caps = c.auth_plain(None, USER, &password()?, ImapAuthPlainOptions::default()).await?;
    c.logout().await?;
    Ok(format!("{} capabilities", caps.len()))
}

async fn starttls() -> Result<String> {
    let mut plain = Conn::new(tcp_connect(IMAP_STARTTLS).await?);
    // starttls() reads the greeting itself; calling greeting() first leaves it waiting for a second one.
    plain.starttls().await?;
    let tls = tls_connector()?.connect(server_name(), plain.stream).await?;
    let mut c = Conn { stream: tls, fragmentizer: plain.fragmentizer };
    c.capability().await?;
    c.auth_plain(None, USER, &password()?, ImapAuthPlainOptions::default()).await?;
    c.select(mailbox("INBOX")?, ImapMailboxSelectOptions::default()).await?;
    c.logout().await?;
    Ok("starttls() (reads the greeting itself), upgrade the socket; AUTHENTICATE PLAIN".into())
}

async fn xoauth2_rejected(stream: impl AsyncRead + AsyncWrite + Unpin + Send) -> Result<String> {
    let mut c = Conn::new(stream);
    c.greeting().await?;
    match c.auth_xoauth2(USER, "not-a-real-token", ImapAuthXoauth2Options::default()).await {
        Ok(_) => bail!("a fake token was accepted"),
        Err(e) => Ok(format!("rejected cleanly: {e}")),
    }
}

async fn headers_first() -> Result<String> {
    let mut c = login().await?;
    c.select(mailbox(FOLDER)?, ImapMailboxSelectOptions::default()).await?;
    let fields = ["FROM", "SUBJECT", "DATE", "MESSAGE-ID", "REFERENCES"]
        .map(|f| AString::try_from(f).unwrap())
        .to_vec();
    let items = MacroOrMessageDataItemNames::MessageDataItemNames(vec![
        MessageDataItemName::Uid,
        MessageDataItemName::Flags,
        MessageDataItemName::InternalDate,
        MessageDataItemName::Rfc822Size,
        MessageDataItemName::BodyStructure,
        MessageDataItemName::BodyExt {
            section: Some(Section::HeaderFields(None, Vec1::try_from(fields)?)),
            partial: None,
            peek: true,
        },
    ]);
    let fetched = c.fetch(SequenceSet::try_from("1:*")?, items, uid_opts()).await?;
    let complete = fetched
        .values()
        .filter(|items| {
            let has = |p: fn(&MessageDataItem) -> bool| items.as_ref().iter().any(p);
            has(|i| matches!(i, MessageDataItem::Uid(_)))
                && has(|i| matches!(i, MessageDataItem::Rfc822Size(_)))
                && has(|i| matches!(i, MessageDataItem::InternalDate(_)))
                && has(|i| matches!(i, MessageDataItem::BodyStructure(_)))
                && has(|i| matches!(i, MessageDataItem::BodyExt { data, .. } if data.0.as_ref().is_some_and(|d| !d.as_ref().is_empty())))
        })
        .count();
    c.logout().await?;
    if complete != fetched.len() || complete != (SMALL + 1) as usize {
        bail!("{complete} of {} complete", fetched.len());
    }
    Ok(format!("{complete} messages, every item parsed"))
}

async fn qresync() -> Result<String> {
    let mut c = Conn::new(tls_connect(IMAPS).await?);
    c.greeting().await?;
    let caps = c.auth_plain(None, USER, &password()?, ImapAuthPlainOptions::default()).await?;
    c.enable(Vec1::from(CapabilityEnable::try_from("QRESYNC")?)).await?;
    let first = c.select(mailbox(FOLDER)?, ImapMailboxSelectOptions::default()).await?;
    let validity = first.uid_validity.context("no UIDVALIDITY")?;
    let modseq = first.highest_mod_seq.context("no HIGHESTMODSEQ")?;
    c.unselect().await?;

    let gone = change_out_of_band(FOLDER).await?;

    let start = Instant::now();
    let data = c.select_qresync(mailbox(FOLDER)?, validity, modseq, &caps).await?;
    let ms = start.elapsed().as_millis();
    c.logout().await?;
    let vanished: Vec<u32> = data.vanished_earlier.iter().map(|u| u.get()).collect();
    let note = format!(
        "vanished {vanished:?}, changed {} in {ms} ms (expected {gone:?} and {FLAGGED})",
        data.changed.len()
    );
    if vanished != gone || data.changed.len() != FLAGGED as usize {
        bail!(note);
    }
    Ok(note)
}

async fn idle() -> Result<String> {
    let mut c = login().await?;
    c.select(mailbox("INBOX")?, ImapMailboxSelectOptions::default()).await?;
    let done = Arc::new(AtomicBool::new(false));
    let mut co = ImapIdle::new(done.clone(), ImapIdleOptions { timeout: Some(Duration::from_secs(25 * 60)) });
    let sent = tokio::spawn(async {
        tokio::time::sleep(Duration::from_millis(300)).await;
        smtp_deliver("idle io-imap").await.map(|_| Instant::now())
    });
    // IDLE has no client method: drive its coroutine here, and resume it without data to make it send DONE.
    let mut buf = vec![0u8; 16 * 1024];
    let mut arg: Option<usize> = None;
    let mut arrived = None;
    let mut done_at = None;
    let mut kick = true;
    loop {
        match co.resume(&mut c.fragmentizer, arg.take().map(|n| &buf[..n])) {
            ImapCoroutineState::Complete(r) => {
                r?;
                break;
            }
            ImapCoroutineState::Yielded(ImapIdleYield::WantsWrite(bytes)) => {
                c.stream.write_all(&bytes).await?
            }
            ImapCoroutineState::Yielded(ImapIdleYield::Event(event)) => {
                let new_mail = event.data.iter().any(|d| {
                    matches!(d, Data::Exists(_))
                        || matches!(d, Data::Status { items, .. }
                            if items.iter().any(|i| matches!(i, StatusDataItem::Messages(_))))
                });
                if new_mail && arrived.is_none() {
                    arrived = Some(Instant::now());
                    done.store(true, Ordering::SeqCst);
                    done_at = Some(Instant::now());
                }
            }
            ImapCoroutineState::Yielded(ImapIdleYield::WantsRead) => {
                if done.load(Ordering::SeqCst) {
                    // The first time, resume without bytes so the coroutine sees `done` and sends DONE;
                    // after that it is waiting for the tagged OK, so read.
                    if mem::take(&mut kick) {
                        continue;
                    }
                    arg = Some(c.stream.read(&mut buf).await?);
                    continue;
                }
                tokio::select! {
                    n = c.stream.read(&mut buf) => arg = Some(n?),
                    _ = tokio::time::sleep(Duration::from_secs(20)) => bail!("no new-mail event in 20 s"),
                }
            }
        }
    }
    let done_ms = done_at.map_or(0, |t| t.elapsed().as_millis());
    let delivered = sent.await??;
    c.logout().await?;
    let arrived = arrived.context("never woke")?;
    Ok(format!(
        "woke {} ms after SMTP accepted; DONE took {done_ms} ms",
        arrived.saturating_duration_since(delivered).as_millis()
    ))
}

async fn uid_move() -> Result<String> {
    let mut c = login().await?;
    c.select(mailbox(FOLDER)?, ImapMailboxSelectOptions::default()).await?;
    let copyuid = c
        .r#move(SequenceSet::try_from("1")?, mailbox("Archive")?, ImapMessageMoveOptions { uid: true })
        .await?;
    c.logout().await?;
    let (_, from, to) = copyuid.context("no COPYUID")?;
    Ok(format!("moved; COPYUID maps {from:?} → {to:?} in Archive"))
}

async fn big_body() -> Result<String> {
    let mut c = login().await?;
    c.select(mailbox(FOLDER)?, ImapMailboxSelectOptions::default()).await?;
    let before = rss_mb();
    let items = MacroOrMessageDataItemNames::MessageDataItemNames(vec![MessageDataItemName::BodyExt {
        section: None,
        partial: None,
        peek: true,
    }]);
    let fetched =
        c.fetch(SequenceSet::try_from((SMALL + 1).to_string().as_str())?, items, uid_opts()).await?;
    let len = fetched
        .values()
        .flat_map(|items| items.as_ref().iter())
        .find_map(|i| match i {
            MessageDataItem::BodyExt { data, .. } => data.0.as_ref().map(|d| d.as_ref().len()),
            _ => None,
        })
        .unwrap_or(0);
    let held = rss_mb();
    c.logout().await?;
    if len < BIG_BYTES {
        bail!("body was {len} bytes");
    }
    Ok(format!(
        "{} MB body; RSS {before:.0} → {held:.0} MB while held (buffered fetch; a streaming fetch exists only on the blocking client)",
        len / 1_000_000
    ))
}

async fn gmail_items() -> Result<String> {
    fetch_from_fake(GMAIL_FETCH).await
}

/// The same fake exchange without the X-GM-* items, to tell a parser gap from a probe mistake.
async fn control_fetch() -> Result<String> {
    fetch_from_fake("* 1 FETCH (UID 4 FLAGS (\\Seen))\r\n{tag} OK Success\r\n").await.map(|_| "parsed".into())
}

async fn fetch_from_fake(fetch_reply: &'static str) -> Result<String> {
    let mut c = Conn::new(fake_server(vec![
        Say::Greeting("* OK [CAPABILITY IMAP4rev1 X-GM-EXT-1 AUTH=PLAIN] Gimap ready\r\n"),
        Say::Reply("{tag} OK user@gmail.com authenticated (Success)\r\n"),
        Say::Reply("* 1 EXISTS\r\n{tag} OK [READ-WRITE] [Gmail]/All Mail selected. (Success)\r\n"),
        Say::Reply(fetch_reply),
    ]));
    c.greeting().await?;
    c.auth_plain(
        None,
        "user@gmail.com",
        "x",
        ImapAuthPlainOptions { initial_request: true, ..Default::default() },
    )
    .await?;
    c.select(mailbox("[Gmail]/All Mail")?, ImapMailboxSelectOptions::default()).await?;
    let items = MacroOrMessageDataItemNames::MessageDataItemNames(vec![
        MessageDataItemName::Uid,
        MessageDataItemName::Flags,
    ]);
    let fetched = c.fetch(SequenceSet::try_from("4")?, items, uid_opts()).await?;
    let items = fetched.values().next().context("no FETCH parsed")?.as_ref();
    let uid = items.iter().find_map(|i| match i {
        MessageDataItem::Uid(u) => Some(u.get()),
        _ => None,
    });
    let seen = items
        .iter()
        .any(|i| matches!(i, MessageDataItem::Flags(f) if f.iter().any(|f| matches!(f, FlagFetch::Flag(Flag::Seen)))));
    if uid != Some(4) || !seen {
        bail!("UID {uid:?}, seen {seen}");
    }
    Ok(format!("UID and FLAGS parsed alongside X-GM-* ({} items kept)", items.len()))
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
            Say::Greeting("* OK [CAPABILITY IMAP4rev1 AUTH=XOAUTH2 SASL-IR] Gimap ready\r\n"),
            Say::Reply(GMAIL_XOAUTH2_CHALLENGE),
            Say::Reply("{tag} NO [AUTHENTICATIONFAILED] Invalid credentials (Failure)\r\n"),
        ])),
    )
    .await;
    r.check("headers-first fetch", headers_first()).await;
    r.check("QRESYNC resync", qresync()).await;
    r.check("IDLE new mail", idle()).await;
    r.check("UID MOVE", uid_move()).await;
    r.check("20 MB body", big_body()).await;
    r.check("Gmail X-GM-* items", gmail_items()).await;
    r.check("control: same FETCH without X-GM-*", control_fetch()).await;
    r.print("io-imap 0.7");
    Ok(())
}
