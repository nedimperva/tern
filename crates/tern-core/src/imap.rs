//! The one place Tern talks to its IMAP library (io-imap). Sync asks for what it needs in Tern's terms (folders,
//! UIDs, flags, bodies), so changing the library later means changing this file only.
//!
//! io-imap's commands are I/O-free coroutines: `Conn` answers their read and write requests on a tokio stream,
//! and io-imap's `ImapClientAsync` turns that into one async method per command.

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::mem;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use anyhow::{bail, Context, Result};
use io_imap::client::{ImapClientAsync, ImapClientError};
use io_imap::codec::fragmentizer::Fragmentizer;
use io_imap::coroutine::{ImapCoroutine, ImapCoroutineState, ImapYield};
use io_imap::rfc2177::idle::{ImapIdle, ImapIdleOptions, ImapIdleYield};
use io_imap::rfc3501::copy::ImapMessageCopyOptions;
use io_imap::rfc3501::fetch::ImapMessageFetchOptions;
use io_imap::rfc3501::login::ImapLoginOptions;
use io_imap::rfc3501::search::ImapMessageSearchOptions;
use io_imap::rfc3501::select::ImapMailboxSelectOptions;
use io_imap::rfc3501::store::ImapMessageStoreOptions;
use io_imap::rfc6851::r#move::ImapMessageMoveOptions;
use io_imap::sasl::auth_plain::ImapAuthPlainOptions;
use io_imap::types::core::{AString, Vec1};
use io_imap::types::fetch::{MacroOrMessageDataItemNames, MessageDataItem, MessageDataItemName, Section};
use io_imap::types::flag::{Flag, FlagFetch, StoreType};
use io_imap::types::mailbox::{ListMailbox, Mailbox};
use io_imap::types::response::Capability;
use io_imap::types::search::SearchKey;
use io_imap::types::sequence::SequenceSet;
use rustls::pki_types::ServerName;
use rustls_platform_verifier::ConfigVerifierExt;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio_rustls::client::TlsStream;
use tokio_rustls::TlsConnector;

use crate::models::Security;

/// Largest single server response accepted; a message body arrives as one response.
const MAX_RESPONSE: u32 = 100 * 1024 * 1024;

/// A folder as the server lists it. `attributes` are lowercase without the backslash: `noselect`, `sent`, `all`.
pub struct Folder {
    pub name: String,
    pub attributes: Vec<String>,
}

pub struct Selected {
    pub exists: u32,
    pub uid_validity: Option<u32>,
    pub uid_next: Option<u32>,
}

/// How an IDLE ended.
#[derive(Debug, PartialEq, Eq)]
pub enum Idled {
    /// The server reported a change in the selected folder: new mail, a deletion, or changed flags.
    Changed,
    /// Nothing happened within the time limit.
    Quiet,
}

/// What a FETCH returned for one message. `size`, `header` and `body` are there only when asked for.
pub struct Fetched {
    pub uid: u32,
    pub seen: bool,
    pub flagged: bool,
    pub size: Option<u32>,
    pub header: Option<Vec<u8>>,
    pub body: Option<Vec<u8>>,
}

/// The header fields the list and threading need; the rest of the header comes with the body.
const LIST_HEADERS: [&str; 8] =
    ["FROM", "TO", "CC", "DATE", "SUBJECT", "MESSAGE-ID", "IN-REPLY-TO", "REFERENCES"];

pub struct Imap<S> {
    conn: Conn<S>,
    capabilities: Vec<Capability<'static>>,
}

pub type TlsImap = Imap<TlsStream<TcpStream>>;

/// Connects, encrypts the connection as `security` says, and signs in.
pub async fn connect(
    host: &str,
    port: u16,
    security: Security,
    username: &str,
    password: &str,
) -> Result<TlsImap> {
    let tcp = open_tcp(host, port).await?;
    let name =
        ServerName::try_from(host.to_string()).with_context(|| format!("{host} is not a valid host name"))?;
    match security {
        Security::Tls => {
            let tls =
                tls_connector()?.connect(name, tcp).await.context("Could not make a secure connection")?;
            Imap::open(tls, username, password).await
        }
        Security::Starttls => {
            let mut plain = Conn::new(tcp);
            // starttls() reads the greeting itself, then sends STARTTLS.
            let after_ok = plain.starttls().await.context("The server did not start TLS")?;
            // RFC 3501 forbids anything after the OK; bytes there could only be an attacker's commands waiting
            // to be read as if they came over TLS.
            if !after_ok.is_empty() {
                bail!("The server sent data before TLS started; refusing the connection");
            }
            // A server that answered NO fails here at the handshake: there is no fall back to plain text.
            let tls = tls_connector()?
                .connect(name, plain.stream)
                .await
                .context("Could not make a secure connection")?;
            let mut conn = Conn { stream: tls, fragmentizer: plain.fragmentizer };
            // Capabilities from before TLS cannot be trusted; ask again.
            let capabilities = conn.capability().await?;
            Imap::sign_in(conn, &capabilities, username, password).await
        }
    }
}

/// A TCP connection with Nagle's algorithm off. IMAP is many small commands that each wait for a reply; with
/// Nagle on, a command split across writes waits for the server's delayed ACK, about 40 ms every time.
pub(crate) async fn open_tcp(host: &str, port: u16) -> Result<TcpStream> {
    let tcp =
        TcpStream::connect((host, port)).await.with_context(|| format!("Could not reach {host}:{port}"))?;
    tcp.set_nodelay(true)?;
    Ok(tcp)
}

/// rustls with the operating system's certificate checks (trust store, and revocation where the OS has it).
fn tls_connector() -> Result<TlsConnector> {
    static CONFIG: OnceLock<Arc<rustls::ClientConfig>> = OnceLock::new();
    if let Some(config) = CONFIG.get() {
        return Ok(TlsConnector::from(config.clone()));
    }
    let _ = rustls::crypto::ring::default_provider().install_default();
    let config = Arc::new(
        rustls::ClientConfig::with_platform_verifier().context("Could not load the system's certificates")?,
    );
    Ok(TlsConnector::from(CONFIG.get_or_init(|| config).clone()))
}

impl<S: AsyncRead + AsyncWrite + Unpin + Send> Imap<S> {
    /// Reads the greeting and signs in on a stream that is already connected (and encrypted).
    pub async fn open(stream: S, username: &str, password: &str) -> Result<Self> {
        let mut conn = Conn::new(stream);
        let greeting = conn.greeting().await.context("Could not read the server's greeting")?;
        Self::sign_in(conn, &greeting.capability, username, password).await
    }

    async fn sign_in(
        mut conn: Conn<S>,
        offered: &[Capability<'static>],
        username: &str,
        password: &str,
    ) -> Result<Self> {
        // AUTHENTICATE PLAIN sends the password base64-encoded, so no server has to unquote it; some
        // (SmarterMail) reject LOGIN's quoted string when the password holds quotes, backslashes or non-ASCII
        // letters. LOGIN is only for servers that do not offer PLAIN.
        let plain = offered.iter().any(|c| c.to_string().eq_ignore_ascii_case("AUTH=PLAIN"));
        let capabilities = if plain {
            let opts = ImapAuthPlainOptions { ensure_capabilities: true, ..Default::default() };
            conn.auth_plain(None, username, password, opts).await
        } else {
            let opts = ImapLoginOptions { ensure_capabilities: true, ..Default::default() };
            conn.login(username, password, opts).await
        }
        .context("The server refused the sign-in")?;
        Ok(Self { conn, capabilities })
    }

    /// Whether the server advertised `name` (for example `MOVE` or `UIDPLUS`).
    pub fn has(&self, name: &str) -> bool {
        self.capabilities.iter().any(|c| c.to_string().eq_ignore_ascii_case(name))
    }

    pub async fn logout(mut self) -> Result<()> {
        Ok(self.conn.logout().await?)
    }

    pub async fn folders(&mut self) -> Result<Vec<Folder>> {
        let listing = self.conn.list(Mailbox::try_from("")?, ListMailbox::try_from("*")?).await?;
        Ok(listing
            .into_iter()
            .map(|(mailbox, _, attributes)| Folder {
                name: mailbox_name(&mailbox),
                attributes: attributes
                    .iter()
                    .map(|a| a.to_string().trim_start_matches('\\').to_ascii_lowercase())
                    .collect(),
            })
            .collect())
    }

    pub async fn select(&mut self, name: &str) -> Result<Selected> {
        let data = self.conn.select(mailbox(name)?, ImapMailboxSelectOptions::default()).await?;
        Ok(Selected {
            exists: data.exists.unwrap_or(0),
            uid_validity: data.uid_validity.map(|v| v.get()),
            uid_next: data.uid_next.map(|v| v.get()),
        })
    }

    /// Every UID in the selected folder.
    pub async fn uids(&mut self) -> Result<HashSet<u32>> {
        let opts = ImapMessageSearchOptions { uid: true };
        let found = self.conn.search(Vec1::from(SearchKey::All), opts).await?;
        Ok(found.into_iter().map(|u| u.get()).collect())
    }

    /// Flags of the messages in `uids` (a UID set such as `1:*` or `4,7,9`).
    pub async fn flags(&mut self, uids: &str) -> Result<Vec<Fetched>> {
        self.fetch(uids, vec![MessageDataItemName::Uid, MessageDataItemName::Flags]).await
    }

    pub async fn sizes(&mut self, uids: &str) -> Result<HashMap<u32, u32>> {
        let fetched =
            self.fetch(uids, vec![MessageDataItemName::Uid, MessageDataItemName::Rfc822Size]).await?;
        Ok(fetched.into_iter().filter_map(|f| Some((f.uid, f.size?))).collect())
    }

    /// Header fields, size and flags: what the list needs, a few hundred bytes a message.
    pub async fn headers(&mut self, uids: &str) -> Result<Vec<Fetched>> {
        let fields = LIST_HEADERS.map(|f| AString::try_from(f).expect("valid atom")).to_vec();
        let header = MessageDataItemName::BodyExt {
            section: Some(Section::HeaderFields(None, Vec1::try_from(fields)?)),
            partial: None,
            peek: true,
        };
        let items = vec![
            MessageDataItemName::Uid,
            MessageDataItemName::Flags,
            MessageDataItemName::Rfc822Size,
            header,
        ];
        self.fetch(uids, items).await
    }

    /// Whole messages, without marking them read.
    pub async fn bodies(&mut self, uids: &str) -> Result<Vec<Fetched>> {
        let body = MessageDataItemName::BodyExt { section: None, partial: None, peek: true };
        self.fetch(uids, vec![MessageDataItemName::Uid, MessageDataItemName::Flags, body]).await
    }

    async fn fetch(&mut self, uids: &str, items: Vec<MessageDataItemName<'static>>) -> Result<Vec<Fetched>> {
        let opts = ImapMessageFetchOptions { uid: true, ..Default::default() };
        let names = MacroOrMessageDataItemNames::MessageDataItemNames(items);
        let fetched = self.conn.fetch(SequenceSet::try_from(uids)?, names, opts).await?;
        Ok(fetched.into_values().filter_map(|items| fetched_from(items.into_iter().collect())).collect())
    }

    /// Adds or removes one flag (for example `\Seen`) on `uids` in the selected folder.
    pub async fn store_flag(&mut self, uids: &str, flag: &str, add: bool) -> Result<()> {
        let flag = match flag {
            "\\Seen" => Flag::Seen,
            "\\Flagged" => Flag::Flagged,
            "\\Deleted" => Flag::Deleted,
            "\\Answered" => Flag::Answered,
            "\\Draft" => Flag::Draft,
            other => bail!("unsupported flag {other}"),
        };
        let kind = if add { StoreType::Add } else { StoreType::Remove };
        let opts = ImapMessageStoreOptions { uid: true };
        self.conn.store(SequenceSet::try_from(uids)?, kind, vec![flag], opts).await?;
        Ok(())
    }

    /// Waits in IDLE on the selected folder until the server reports a change or `limit` passes, then ends the
    /// IDLE with DONE so the connection can be used again.
    pub async fn idle(&mut self, limit: Duration) -> Result<Idled> {
        let done = Arc::new(AtomicBool::new(false));
        // The coroutine's own refresh timer is pushed past `limit`; the deadline below decides when to stop.
        let opts = ImapIdleOptions { timeout: Some(limit + Duration::from_secs(60)) };
        let mut idle = ImapIdle::new(done.clone(), opts);
        let deadline = tokio::time::Instant::now() + limit;
        let mut outcome = Idled::Quiet;
        let mut buf = vec![0u8; 16 * 1024];
        let mut read: Option<usize> = None;
        let mut sent_done = false;
        loop {
            match idle.resume(&mut self.conn.fragmentizer, read.take().map(|n| &buf[..n])) {
                ImapCoroutineState::Complete(result) => {
                    result.context("IDLE failed")?;
                    return Ok(outcome);
                }
                ImapCoroutineState::Yielded(ImapIdleYield::WantsWrite(bytes)) => {
                    self.conn.stream.write_all(&bytes).await?;
                }
                ImapCoroutineState::Yielded(ImapIdleYield::Event(_)) => {
                    outcome = Idled::Changed;
                    done.store(true, Ordering::SeqCst);
                }
                ImapCoroutineState::Yielded(ImapIdleYield::WantsRead) => {
                    // Once `done` is set, resuming without bytes makes the coroutine send DONE; after that it
                    // waits for the server's OK like any command.
                    if done.load(Ordering::SeqCst) && !mem::replace(&mut sent_done, true) {
                        continue;
                    }
                    let n = if sent_done {
                        self.conn.stream.read(&mut buf).await?
                    } else {
                        tokio::select! {
                            n = self.conn.stream.read(&mut buf) => n?,
                            _ = tokio::time::sleep_until(deadline) => {
                                done.store(true, Ordering::SeqCst);
                                continue;
                            }
                        }
                    };
                    if n == 0 {
                        bail!("the server hung up during IDLE");
                    }
                    read = Some(n);
                }
            }
        }
    }

    /// Moves `uids` from the selected folder to `dest`. MOVE where the server has it; otherwise COPY, mark
    /// deleted, and UID EXPUNGE, which removes only these messages. Without UIDPLUS there is no expunge that
    /// spares other deleted mail, so the originals stay marked deleted and the server or user expunges later.
    pub async fn move_to(&mut self, uids: &str, dest: &str) -> Result<()> {
        let set = SequenceSet::try_from(uids)?;
        if self.has("MOVE") {
            self.conn.r#move(set, mailbox(dest)?, ImapMessageMoveOptions { uid: true }).await?;
            return Ok(());
        }
        self.conn.copy(set.clone(), mailbox(dest)?, ImapMessageCopyOptions { uid: true }).await?;
        self.store_flag(uids, "\\Deleted", true).await?;
        if self.has("UIDPLUS") {
            self.conn.uid_expunge(set).await?;
        } else {
            log::warn!("no MOVE or UIDPLUS: messages {uids} left marked deleted rather than expunging all");
        }
        Ok(())
    }
}

/// Whether `e` came from the connection itself failing (reading or writing the socket), rather than from the
/// server answering NO or BAD. io-imap wraps the I/O error transparently, so it is not in the error's source
/// chain and has to be recognised by its variant.
pub fn connection_lost(e: &anyhow::Error) -> bool {
    e.chain().any(|c| {
        c.is::<std::io::Error>()
            || matches!(c.downcast_ref::<ImapClientError>(), Some(ImapClientError::Io(_)))
    })
}

fn mailbox(name: &str) -> Result<Mailbox<'static>> {
    Ok(Mailbox::try_from(name.to_string())?)
}

fn mailbox_name(mailbox: &Mailbox) -> String {
    match mailbox {
        Mailbox::Inbox => "INBOX".to_string(),
        Mailbox::Other(other) => String::from_utf8_lossy(other.as_ref()).into_owned(),
    }
}

fn fetched_from(items: Vec<MessageDataItem<'static>>) -> Option<Fetched> {
    let mut f = Fetched { uid: 0, seen: false, flagged: false, size: None, header: None, body: None };
    for item in items {
        match item {
            MessageDataItem::Uid(uid) => f.uid = uid.get(),
            MessageDataItem::Flags(flags) => {
                for flag in flags {
                    match flag {
                        FlagFetch::Flag(Flag::Seen) => f.seen = true,
                        FlagFetch::Flag(Flag::Flagged) => f.flagged = true,
                        _ => {}
                    }
                }
            }
            MessageDataItem::Rfc822Size(size) => f.size = Some(size),
            MessageDataItem::BodyExt { section, data, .. } => {
                let bytes = data.0.map(|d| d.as_ref().to_vec());
                match section {
                    Some(Section::HeaderFields(..)) => f.header = bytes,
                    _ => f.body = bytes,
                }
            }
            _ => {}
        }
    }
    (f.uid != 0).then_some(f)
}

/// Runs io-imap's coroutines against a tokio stream.
struct Conn<S> {
    stream: S,
    fragmentizer: Fragmentizer,
}

impl<S> Conn<S> {
    fn new(stream: S) -> Self {
        Self { stream, fragmentizer: Fragmentizer::new(MAX_RESPONSE) }
    }
}

impl<S: AsyncRead + AsyncWrite + Unpin + Send> ImapClientAsync for Conn<S> {
    // An `async fn` here could not promise a Send future, which tokio::spawn needs.
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
            let mut read: Option<usize> = None;
            loop {
                match coroutine.resume(&mut self.fragmentizer, read.take().map(|n| &buf[..n])) {
                    ImapCoroutineState::Complete(out) => return out.map_err(Into::into),
                    ImapCoroutineState::Yielded(ImapYield::WantsRead) => {
                        let n = self.stream.read(&mut buf).await?;
                        if n == 0 {
                            let eof =
                                std::io::Error::new(std::io::ErrorKind::UnexpectedEof, "the server hung up");
                            return Err(eof.into());
                        }
                        read = Some(n);
                    }
                    ImapCoroutineState::Yielded(ImapYield::WantsWrite(bytes)) => {
                        self.stream.write_all(&bytes).await?;
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use tokio::io::{AsyncBufReadExt, BufReader, DuplexStream};

    use super::*;

    /// One expected client command (matched by prefix, tag stripped) and the server's reply. `{tag}` in the reply
    /// becomes the tag of the most recent tagged command; an empty `expect` matches any line.
    type Script = Vec<(&'static str, &'static str)>;

    /// A scripted IMAP server. Returns the client end and every line the client sent, tags stripped.
    fn server(greeting: &'static str, script: Script) -> (DuplexStream, Arc<Mutex<Vec<String>>>) {
        let (client, server) = tokio::io::duplex(1 << 16);
        let sent = Arc::new(Mutex::new(Vec::new()));
        let log = sent.clone();
        tokio::spawn(async move {
            let (r, mut w) = tokio::io::split(server);
            let mut r = BufReader::new(r);
            w.write_all(greeting.as_bytes()).await.unwrap();
            let mut tag = String::new();
            for (expect, reply) in script {
                let mut line = String::new();
                if r.read_line(&mut line).await.unwrap() == 0 {
                    return;
                }
                let line = line.trim_end().to_string();
                let mut words = line.splitn(2, ' ');
                let (first, rest) = (words.next().unwrap_or(""), words.next());
                let command = match rest {
                    Some(rest) if rest.starts_with(|c: char| c.is_ascii_alphabetic()) => {
                        tag = first.to_string();
                        rest.to_string()
                    }
                    _ => line.clone(),
                };
                assert!(command.starts_with(expect), "expected {expect:?}, client sent {command:?}");
                log.lock().unwrap().push(command);
                w.write_all(reply.replace("{tag}", &tag).as_bytes()).await.unwrap();
            }
        });
        (client, sent)
    }

    const GREETING: &str = "* OK [CAPABILITY IMAP4rev1 AUTH=PLAIN] ready\r\n";

    fn signed_in(capabilities: &'static str, script: Script) -> (DuplexStream, Arc<Mutex<Vec<String>>>) {
        let mut all: Script = vec![("AUTHENTICATE PLAIN", "+ \r\n"), ("", capabilities)];
        all.extend(script);
        server(GREETING, all)
    }

    #[tokio::test]
    async fn imap_sockets_have_nagle_off() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let tcp = open_tcp("127.0.0.1", port).await.unwrap();
        assert!(tcp.nodelay().unwrap());
    }

    #[tokio::test]
    async fn signs_in_with_plain_when_offered() {
        let (stream, sent) = signed_in("{tag} OK [CAPABILITY IMAP4rev1 MOVE UIDPLUS] in\r\n", vec![]);
        let imap = Imap::open(stream, "ada@example.com", "pa\"ss").await.unwrap();
        assert!(imap.has("MOVE") && imap.has("uidplus"));
        let sent = sent.lock().unwrap();
        assert_eq!(sent[0], "AUTHENTICATE PLAIN");
        // The password travels base64-encoded, so its quote needs no escaping.
        assert_eq!(sent[1], "AGFkYUBleGFtcGxlLmNvbQBwYSJzcw==");
    }

    #[tokio::test]
    async fn signs_in_with_login_without_plain() {
        let (stream, sent) = server(
            "* OK [CAPABILITY IMAP4rev1] ready\r\n",
            vec![("LOGIN", "{tag} OK [CAPABILITY IMAP4rev1] in\r\n")],
        );
        Imap::open(stream, "ada", "secret").await.unwrap();
        assert!(sent.lock().unwrap()[0].starts_with("LOGIN"));
    }

    #[tokio::test]
    async fn wrong_password_is_an_error() {
        let (stream, _) = server(
            GREETING,
            vec![("AUTHENTICATE PLAIN", "+ \r\n"), ("", "{tag} NO [AUTHENTICATIONFAILED] wrong\r\n")],
        );
        let err = Imap::open(stream, "ada", "wrong").await.err().unwrap();
        assert!(format!("{err:#}").contains("refused the sign-in"));
    }

    #[tokio::test]
    async fn lists_folders_with_plain_attributes() {
        let (stream, _) = signed_in(
            "{tag} OK [CAPABILITY IMAP4rev1] in\r\n",
            vec![(
                "LIST",
                "* LIST (\\HasNoChildren) \"/\" INBOX\r\n* LIST (\\Sent \\HasNoChildren) \"/\" \"Sent Items\"\r\n\
                 * LIST (\\Noselect) \"/\" Shared\r\n{tag} OK done\r\n",
            )],
        );
        let mut imap = Imap::open(stream, "ada", "x").await.unwrap();
        let folders = imap.folders().await.unwrap();
        let by_name: HashMap<_, _> = folders.iter().map(|f| (f.name.as_str(), &f.attributes)).collect();
        assert_eq!(by_name["INBOX"], &vec!["hasnochildren".to_string()]);
        assert_eq!(by_name["Sent Items"], &vec!["sent".to_string(), "hasnochildren".to_string()]);
        assert_eq!(by_name["Shared"], &vec!["noselect".to_string()]);
    }

    #[tokio::test]
    async fn selects_searches_and_fetches_by_uid() {
        let (stream, sent) = signed_in(
            "{tag} OK [CAPABILITY IMAP4rev1] in\r\n",
            vec![
                ("SELECT INBOX", "* 2 EXISTS\r\n* OK [UIDVALIDITY 7] v\r\n* OK [UIDNEXT 12] n\r\n{tag} OK [READ-WRITE] s\r\n"),
                ("UID SEARCH ALL", "* SEARCH 4 11\r\n{tag} OK done\r\n"),
                ("UID FETCH 1:* (UID FLAGS)", "* 1 FETCH (UID 4 FLAGS (\\Seen))\r\n* 2 FETCH (UID 11 FLAGS (\\Flagged))\r\n{tag} OK done\r\n"),
                ("UID FETCH 4,11 (UID RFC822.SIZE)", "* 1 FETCH (UID 4 RFC822.SIZE 120)\r\n* 2 FETCH (UID 11 RFC822.SIZE 3000)\r\n{tag} OK done\r\n"),
                ("UID FETCH 4 (UID FLAGS BODY.PEEK[])", "* 1 FETCH (UID 4 FLAGS (\\Seen) BODY[] {9}\r\nSubject:\n)\r\n{tag} OK done\r\n"),
            ],
        );
        let mut imap = Imap::open(stream, "ada", "x").await.unwrap();
        let selected = imap.select("INBOX").await.unwrap();
        assert_eq!((selected.exists, selected.uid_validity, selected.uid_next), (2, Some(7), Some(12)));
        assert_eq!(imap.uids().await.unwrap(), HashSet::from([4, 11]));

        let mut flags = imap.flags("1:*").await.unwrap();
        flags.sort_by_key(|f| f.uid);
        assert_eq!(
            flags.iter().map(|f| (f.uid, f.seen, f.flagged)).collect::<Vec<_>>(),
            [(4, true, false), (11, false, true)]
        );

        assert_eq!(imap.sizes("4,11").await.unwrap(), HashMap::from([(4, 120), (11, 3000)]));

        let bodies = imap.bodies("4").await.unwrap();
        assert_eq!(bodies[0].body.as_deref(), Some(&b"Subject:\n"[..]));
        // PEEK: fetching a body must not mark it read on the server.
        assert!(sent.lock().unwrap().iter().any(|c| c.contains("BODY.PEEK[]")));
    }

    #[tokio::test]
    async fn moves_with_move_when_advertised() {
        let (stream, sent) = signed_in(
            "{tag} OK [CAPABILITY IMAP4rev1 MOVE UIDPLUS] in\r\n",
            vec![("UID MOVE 4 Archive", "* OK [COPYUID 7 4 9] moved\r\n* 1 EXPUNGE\r\n{tag} OK done\r\n")],
        );
        let mut imap = Imap::open(stream, "ada", "x").await.unwrap();
        imap.move_to("4", "Archive").await.unwrap();
        assert_eq!(sent.lock().unwrap().len(), 3);
    }

    #[tokio::test]
    async fn without_move_expunges_only_the_moved_uids() {
        let (stream, sent) = signed_in(
            "{tag} OK [CAPABILITY IMAP4rev1 UIDPLUS] in\r\n",
            vec![
                ("UID COPY 4 Archive", "{tag} OK [COPYUID 7 4 9] copied\r\n"),
                (
                    "UID STORE 4 +FLAGS (\\Deleted)",
                    "* 1 FETCH (UID 4 FLAGS (\\Deleted))\r\n{tag} OK done\r\n",
                ),
                ("UID EXPUNGE 4", "* 1 EXPUNGE\r\n{tag} OK done\r\n"),
            ],
        );
        let mut imap = Imap::open(stream, "ada", "x").await.unwrap();
        imap.move_to("4", "Archive").await.unwrap();
        assert!(!sent.lock().unwrap().iter().any(|c| c == "EXPUNGE"));
    }

    #[tokio::test]
    async fn without_uidplus_never_expunges() {
        let (stream, sent) = signed_in(
            "{tag} OK [CAPABILITY IMAP4rev1] in\r\n",
            vec![
                ("UID COPY 4 Archive", "{tag} OK copied\r\n"),
                ("UID STORE 4 +FLAGS (\\Deleted)", "{tag} OK done\r\n"),
                ("LOGOUT", "* BYE bye\r\n{tag} OK done\r\n"),
            ],
        );
        let mut imap = Imap::open(stream, "ada", "x").await.unwrap();
        imap.move_to("4", "Archive").await.unwrap();
        imap.logout().await.unwrap();
        // A plain EXPUNGE would also delete other mail someone marked deleted.
        assert!(!sent.lock().unwrap().iter().any(|c| c.contains("EXPUNGE")));
    }

    /// A server that slips a response in right after its STARTTLS OK, while the line is still plain text.
    #[tokio::test]
    async fn refuses_data_injected_before_starttls() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (sock, _) = listener.accept().await.unwrap();
            let (r, mut w) = tokio::io::split(sock);
            w.write_all(b"* OK [CAPABILITY IMAP4rev1 STARTTLS] ready\r\n").await.unwrap();
            let mut line = String::new();
            BufReader::new(r).read_line(&mut line).await.unwrap();
            let tag = line.split_whitespace().next().unwrap().to_string();
            w.write_all(
                format!("{tag} OK Begin TLS\r\n* OK [CAPABILITY IMAP4rev1 AUTH=PLAIN] injected\r\n")
                    .as_bytes(),
            )
            .await
            .unwrap();
            tokio::time::sleep(std::time::Duration::from_secs(5)).await;
        });
        let err = connect("localhost", port, Security::Starttls, "ada", "x").await.err().unwrap();
        assert!(format!("{err:#}").contains("before TLS started"), "{err:#}");
    }

    #[tokio::test]
    async fn a_dropped_connection_counts_as_lost_and_a_no_does_not() {
        let (stream, _) = signed_in(
            "{tag} OK [CAPABILITY IMAP4rev1] in\r\n",
            vec![("SELECT Gone", "{tag} NO no such folder\r\n")],
        );
        let mut imap = Imap::open(stream, "ada", "x").await.unwrap();
        let refused = imap.select("Gone").await.err().unwrap();
        assert!(!connection_lost(&refused), "{refused:#}");
        // The script is used up, so the fake server goes away: the next command hits a closed socket.
        let dropped = imap.select("INBOX").await.err().unwrap();
        assert!(connection_lost(&dropped), "{dropped:#}");
    }

    #[tokio::test]
    async fn idle_ends_on_new_mail_and_the_connection_still_works() {
        let (stream, sent) = signed_in(
            "{tag} OK [CAPABILITY IMAP4rev1 IDLE] in\r\n",
            vec![
                ("SELECT INBOX", "* 2 EXISTS\r\n{tag} OK [READ-WRITE] s\r\n"),
                ("IDLE", "+ idling\r\n* 3 EXISTS\r\n"),
                ("DONE", "{tag} OK IDLE terminated\r\n"),
                ("NOOP", "{tag} OK done\r\n"),
            ],
        );
        let mut imap = Imap::open(stream, "ada", "x").await.unwrap();
        imap.select("INBOX").await.unwrap();
        let started = std::time::Instant::now();
        assert_eq!(imap.idle(Duration::from_secs(30)).await.unwrap(), Idled::Changed);
        assert!(started.elapsed() < Duration::from_secs(5), "woke on the event, not the time limit");
        imap.conn.noop().await.unwrap();
        assert_eq!(sent.lock().unwrap().last().unwrap(), "NOOP");
    }

    #[tokio::test]
    async fn idle_returns_quiet_after_the_time_limit() {
        let (stream, sent) = signed_in(
            "{tag} OK [CAPABILITY IMAP4rev1 IDLE] in\r\n",
            vec![
                ("SELECT INBOX", "* 2 EXISTS\r\n{tag} OK [READ-WRITE] s\r\n"),
                ("IDLE", "+ idling\r\n"),
                ("DONE", "{tag} OK IDLE terminated\r\n"),
            ],
        );
        let mut imap = Imap::open(stream, "ada", "x").await.unwrap();
        imap.select("INBOX").await.unwrap();
        assert_eq!(imap.idle(Duration::from_millis(200)).await.unwrap(), Idled::Quiet);
        assert_eq!(sent.lock().unwrap().last().unwrap(), "DONE");
    }

    #[tokio::test]
    async fn fetches_header_fields_without_the_body() {
        let (stream, sent) = signed_in(
            "{tag} OK [CAPABILITY IMAP4rev1] in\r\n",
            vec![(
                "UID FETCH 4 (UID FLAGS RFC822.SIZE BODY.PEEK[HEADER.FIELDS (FROM TO CC DATE SUBJECT MESSAGE-ID IN-REPLY-TO REFERENCES)])",
                "* 1 FETCH (UID 4 FLAGS (\\Seen) RFC822.SIZE 52000 BODY[HEADER.FIELDS (FROM SUBJECT)] {28}\r\n\
                 From: a@b.c\r\nSubject: Hi\r\n\r\n)\r\n{tag} OK done\r\n",
            )],
        );
        let mut imap = Imap::open(stream, "ada", "x").await.unwrap();
        let fetched = imap.headers("4").await.unwrap();
        let f = &fetched[0];
        assert_eq!((f.uid, f.seen, f.size), (4, true, Some(52000)));
        assert_eq!(f.header.as_deref(), Some(&b"From: a@b.c\r\nSubject: Hi\r\n\r\n"[..]));
        assert!(f.body.is_none());
        assert!(
            sent.lock().unwrap().iter().any(|c| c.contains("BODY.PEEK[HEADER.FIELDS")),
            "must not mark read"
        );
    }
}
