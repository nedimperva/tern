//! The one place Tern talks to its IMAP library (io-imap). Sync asks for what it needs in Tern's terms (folders,
//! UIDs, flags, bodies), so changing the library later means changing this file only.
//!
//! io-imap's commands are I/O-free coroutines: `Conn` answers their read and write requests on a tokio stream,
//! and io-imap's `ImapClientAsync` turns that into one async method per command.

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::mem;
use std::num::NonZeroU32;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use anyhow::{bail, Context, Result};
use io_imap::client::{ImapClientAsync, ImapClientError};
use io_imap::codec::fragmentizer::Fragmentizer;
use io_imap::coroutine::{ImapCoroutine, ImapCoroutineState, ImapYield};
use io_imap::rfc2177::idle::{ImapIdle, ImapIdleOptions, ImapIdleYield};
use io_imap::rfc2971::id::ImapServerIdOptions;
use io_imap::rfc3501::copy::ImapMessageCopyOptions;
use io_imap::rfc3501::fetch::ImapMessageFetchOptions;
use io_imap::rfc3501::login::ImapLoginOptions;
use io_imap::rfc3501::search::ImapMessageSearchOptions;
use io_imap::rfc3501::select::{ImapMailboxSelectData, ImapMailboxSelectOptions};
use io_imap::rfc3501::store::ImapMessageStoreOptions;
use io_imap::rfc6851::r#move::ImapMessageMoveOptions;
use io_imap::sasl::auth_plain::ImapAuthPlainOptions;
use io_imap::types::body::{BodyStructure, SpecificFields};
use io_imap::types::command::FetchModifier;
use io_imap::types::core::{AString, IString, NString, Vec1};
use io_imap::types::extensions::enable::CapabilityEnable;
use io_imap::types::fetch::{
    MacroOrMessageDataItemNames, MessageDataItem, MessageDataItemName, Part as FetchPart, Section,
};
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

use crate::models::{Part, Security};

/// Largest single server response accepted; a message body arrives as one response.
const MAX_RESPONSE: u32 = 100 * 1024 * 1024;

/// A folder as the server lists it. `attributes` are lowercase without the backslash: `noselect`, `sent`, `all`.
pub struct Folder {
    pub name: String,
    pub attributes: Vec<String>,
}

#[derive(Debug, Clone, Copy)]
pub struct Selected {
    pub exists: u32,
    pub uid_validity: Option<u32>,
    pub uid_next: Option<u32>,
    /// The folder's modification sequence (CONDSTORE), when the server keeps one.
    pub highest_modseq: Option<u64>,
}

/// A QRESYNC select: the folder, plus what changed since the modification sequence it was given.
pub struct Resync {
    pub selected: Selected,
    /// UIDs expunged since then.
    pub vanished: Vec<u32>,
    /// Messages whose flags changed (or that are new) since then, with UID and flags.
    pub changed: Vec<Fetched>,
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
    /// One part's content (BODY[section]), when a single part was asked for.
    pub part: Option<Vec<u8>>,
    /// The leaf parts from BODYSTRUCTURE.
    pub structure: Option<Vec<Part>>,
}

/// The header fields the list, threading and list handling need; the rest of the header comes with the body.
const LIST_HEADERS: [&str; 10] = [
    "FROM",
    "TO",
    "CC",
    "DATE",
    "SUBJECT",
    "MESSAGE-ID",
    "IN-REPLY-TO",
    "REFERENCES",
    "LIST-ID",
    "LIST-UNSUBSCRIBE",
];

pub struct Imap<S> {
    conn: Conn<S>,
    capabilities: Vec<Capability<'static>>,
    /// QRESYNC is ENABLEd on this connection.
    qresync: bool,
    /// CONDSTORE without QRESYNC: flag changes can be asked for since a modification sequence.
    condstore: bool,
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
        .map_err(|e| match e {
            // The connection broke while signing in: that says nothing about the password.
            ImapClientError::Io(io) => {
                anyhow::Error::new(io).context("The connection broke while signing in")
            }
            refused => anyhow::Error::new(refused).context(SignInRefused),
        })?;
        let mut imap = Self { conn, capabilities, qresync: false, condstore: false };
        // Some servers (Gmail) ask clients to say who they are. Nothing depends on the answer.
        if imap.has("ID") {
            imap.identify().await?;
        }
        Ok(imap)
    }

    async fn identify(&mut self) -> Result<()> {
        let field = |k: &str, v: &str| -> Result<(IString<'static>, NString<'static>)> {
            Ok((IString::try_from(k.to_string())?, NString(Some(IString::try_from(v.to_string())?))))
        };
        let parameters = vec![
            field("name", "Tern")?,
            field("version", env!("CARGO_PKG_VERSION"))?,
            field("support-url", "https://github.com/nedimperva/tern")?,
        ];
        match self.conn.id(ImapServerIdOptions { parameters: Some(parameters) }).await {
            Ok(_) => Ok(()),
            Err(ImapClientError::Io(e)) => Err(e.into()),
            Err(e) => {
                log::debug!("the server did not take ID: {e}");
                Ok(())
            }
        }
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
        Ok(selected(&data))
    }

    /// Turns on QRESYNC (RFC 7162) for this connection when the server has it. Returns whether it is on.
    pub async fn enable_qresync(&mut self) -> Result<bool> {
        if !self.qresync && self.has("QRESYNC") {
            self.conn.enable(Vec1::from(CapabilityEnable::try_from("QRESYNC")?)).await?;
            self.qresync = true;
        }
        Ok(self.qresync)
    }

    pub fn qresync(&self) -> bool {
        self.qresync
    }

    /// On a server with CONDSTORE but not QRESYNC, turns on modification sequences (ENABLE where offered;
    /// otherwise the first CHANGEDSINCE does it). Returns whether `flags_changed_since` can be used.
    pub async fn enable_condstore(&mut self) -> Result<bool> {
        if !self.qresync && !self.condstore && self.has("CONDSTORE") {
            if self.has("ENABLE") {
                self.conn.enable(Vec1::from(CapabilityEnable::try_from("CONDSTORE")?)).await?;
            }
            self.condstore = true;
        }
        Ok(self.condstore)
    }

    /// Flags of the messages in `uids` whose flags changed after `modseq` (CONDSTORE `CHANGEDSINCE`).
    pub async fn flags_changed_since(&mut self, uids: &str, modseq: u64) -> Result<Vec<Fetched>> {
        let since = std::num::NonZeroU64::new(modseq).context("modification sequence 0")?;
        let opts = ImapMessageFetchOptions { uid: true, modifiers: vec![FetchModifier::ChangedSince(since)] };
        let items = vec![MessageDataItemName::Uid, MessageDataItemName::Flags];
        let names = MacroOrMessageDataItemNames::MessageDataItemNames(items);
        let fetched = self.conn.fetch(SequenceSet::try_from(uids)?, names, opts).await?;
        Ok(fetched.into_values().filter_map(|items| fetched_from(items.into_iter().collect())).collect())
    }

    /// Selects `name` and has the server report what changed since `highest_modseq`: expunged UIDs and changed
    /// flags, in one round trip. Needs `enable_qresync` first.
    pub async fn select_since(
        &mut self,
        name: &str,
        uid_validity: u32,
        highest_modseq: u64,
    ) -> Result<Resync> {
        let validity = NonZeroU32::new(uid_validity).context("UIDVALIDITY 0")?;
        let data =
            self.conn.select_qresync(mailbox(name)?, validity, highest_modseq, &self.capabilities).await?;
        Ok(Resync {
            selected: selected(&data),
            vanished: data.vanished_earlier.iter().map(|u| u.get()).collect(),
            changed: data.changed.iter().filter_map(|c| fetched_from(c.items.as_ref().to_vec())).collect(),
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
            MessageDataItemName::BodyStructure,
            header,
        ];
        self.fetch(uids, items).await
    }

    /// The first `bytes` of one part (`section`, such as "1.1") of each message in `uids`, without marking them
    /// read. Comes back in `Fetched::part`.
    pub async fn part_start(&mut self, uids: &str, section: &str, bytes: u32) -> Result<Vec<Fetched>> {
        let numbers: Vec<NonZeroU32> = section
            .split('.')
            .map(|n| n.parse::<u32>().ok().and_then(NonZeroU32::new).context("bad section"))
            .collect::<Result<_>>()?;
        let part = MessageDataItemName::BodyExt {
            section: Some(Section::Part(FetchPart(Vec1::try_from(numbers)?))),
            partial: Some((0, NonZeroU32::new(bytes).context("zero bytes")?)),
            peek: true,
        };
        self.fetch(uids, vec![MessageDataItemName::Uid, part]).await
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
    ///
    /// Returns (uid here, uid in `dest`) for each message the server reported (COPYUID, RFC 4315); empty when it
    /// reported nothing.
    pub async fn move_to(&mut self, uids: &str, dest: &str) -> Result<Vec<(u32, u32)>> {
        let set = SequenceSet::try_from(uids)?;
        let copyuid = if self.has("MOVE") {
            self.conn.r#move(set, mailbox(dest)?, ImapMessageMoveOptions { uid: true }).await?
        } else {
            let copyuid =
                self.conn.copy(set.clone(), mailbox(dest)?, ImapMessageCopyOptions { uid: true }).await?;
            self.store_flag(uids, "\\Deleted", true).await?;
            if self.has("UIDPLUS") {
                self.conn.uid_expunge(set).await?;
            } else {
                log::warn!(
                    "no MOVE or UIDPLUS: messages {uids} left marked deleted rather than expunging all"
                );
            }
            copyuid
        };
        Ok(copyuid.map(|(_, from, to)| from.into_iter().zip(to).collect()).unwrap_or_default())
    }

    /// UIDs in the selected folder of messages with this Message-ID (given without angle brackets), by SEARCH
    /// HEADER. Some servers do not index Message-ID for that and find nothing (Stalwart); `message_ids` is the
    /// fallback that works everywhere.
    pub async fn find_message_id(&mut self, message_id: &str) -> Result<Vec<u32>> {
        let header = SearchKey::Header(
            AString::try_from("Message-ID")?,
            AString::try_from(format!("<{message_id}>"))?,
        );
        let found = self.conn.search(Vec1::from(header), ImapMessageSearchOptions { uid: true }).await?;
        Ok(found.into_iter().map(|u| u.get()).collect())
    }

    /// (uid, Message-ID without angle brackets) of the messages in `uids` that have one.
    pub async fn message_ids(&mut self, uids: &str) -> Result<Vec<(u32, String)>> {
        let field = MessageDataItemName::BodyExt {
            section: Some(Section::HeaderFields(None, Vec1::from(AString::try_from("MESSAGE-ID")?))),
            partial: None,
            peek: true,
        };
        let fetched = self.fetch(uids, vec![MessageDataItemName::Uid, field]).await?;
        Ok(fetched
            .into_iter()
            .filter_map(|f| {
                let header = String::from_utf8_lossy(f.header.as_deref()?).into_owned();
                let id = header
                    .split_once(':')?
                    .1
                    .trim()
                    .trim_start_matches('<')
                    .split('>')
                    .next()?
                    .trim()
                    .to_string();
                (!id.is_empty()).then_some((f.uid, id))
            })
            .collect())
    }
}

/// The server said no to the user name and password (or token). Trying again with the same ones will not help and
/// may lock the account, so callers wait for new ones.
#[derive(Debug)]
pub struct SignInRefused;

impl std::fmt::Display for SignInRefused {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("The server refused the sign-in")
    }
}

impl std::error::Error for SignInRefused {}

/// Whether `e` is the server refusing the sign-in.
pub fn sign_in_refused(e: &anyhow::Error) -> bool {
    e.downcast_ref::<SignInRefused>().is_some()
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

fn selected(data: &ImapMailboxSelectData) -> Selected {
    Selected {
        exists: data.exists.unwrap_or(0),
        uid_validity: data.uid_validity.map(|v| v.get()),
        uid_next: data.uid_next.map(|v| v.get()),
        highest_modseq: data.highest_mod_seq,
    }
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
    let mut f = Fetched {
        uid: 0,
        seen: false,
        flagged: false,
        size: None,
        header: None,
        body: None,
        part: None,
        structure: None,
    };
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
                    Some(Section::Part(_)) => f.part = bytes,
                    _ => f.body = bytes,
                }
            }
            MessageDataItem::BodyStructure(structure) => {
                let mut parts = Vec::new();
                leaf_parts(&structure, "", &mut parts);
                f.structure = Some(parts);
            }
            _ => {}
        }
    }
    (f.uid != 0).then_some(f)
}

/// Flattens a BODYSTRUCTURE into its leaf parts with their section numbers. A message/rfc822 part is one leaf (a
/// forwarded message is an attachment here, not more body).
fn leaf_parts(structure: &BodyStructure, prefix: &str, out: &mut Vec<Part>) {
    let text = |s: &IString| String::from_utf8_lossy(s.as_ref()).to_ascii_lowercase();
    let param = |list: &[(IString, IString)], key: &str| {
        list.iter()
            .find(|(k, _)| text(k) == key)
            .map(|(_, v)| String::from_utf8_lossy(v.as_ref()).into_owned())
    };
    match structure {
        BodyStructure::Multi { bodies, .. } => {
            for (i, body) in bodies.as_ref().iter().enumerate() {
                let section =
                    if prefix.is_empty() { format!("{}", i + 1) } else { format!("{prefix}.{}", i + 1) };
                leaf_parts(body, &section, out);
            }
        }
        BodyStructure::Single { body, extension_data } => {
            let mime = match &body.specific {
                SpecificFields::Basic { r#type, subtype } => format!("{}/{}", text(r#type), text(subtype)),
                SpecificFields::Message { .. } => "message/rfc822".to_string(),
                SpecificFields::Text { subtype, .. } => format!("text/{}", text(subtype)),
            };
            let disposition =
                extension_data.as_ref().and_then(|e| e.tail.as_ref()).and_then(|d| d.disposition.as_ref());
            let marked = disposition.is_some_and(|(kind, _)| text(kind) == "attachment");
            let name = disposition
                .and_then(|(_, params)| param(params, "filename"))
                .or_else(|| param(&body.basic.parameter_list, "name"));
            let inline_image = mime.starts_with("image/") && body.basic.id.0.is_some();
            let attachment = marked || (name.is_some() && !mime.starts_with("text/") && !inline_image);
            out.push(Part {
                // A single-part message's only part is section 1.
                section: if prefix.is_empty() { "1".to_string() } else { prefix.to_string() },
                mime,
                encoding: text(&body.basic.content_transfer_encoding),
                charset: param(&body.basic.parameter_list, "charset"),
                size: body.basic.size,
                name,
                attachment,
            });
        }
    }
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
    use super::*;
    use tokio::io::{AsyncBufReadExt, BufReader};

    use crate::scripted::{server, signed_in, GREETING};

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
        assert!(sign_in_refused(&err));
    }

    #[tokio::test]
    async fn says_who_it_is_where_asked() {
        let (stream, sent) = signed_in(
            "{tag} OK [CAPABILITY IMAP4rev1 ID] in\r\n",
            vec![("ID (", "* ID (\"name\" \"Example\")\r\n{tag} OK done\r\n")],
        );
        Imap::open(stream, "ada", "x").await.unwrap();
        assert!(sent.lock().unwrap()[2].contains("\"name\" \"Tern\""), "{:?}", sent.lock().unwrap());
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
        assert_eq!(imap.move_to("4", "Archive").await.unwrap(), [(4, 9)]);
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
        assert_eq!(imap.move_to("4", "Archive").await.unwrap(), [(4, 9)]);
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
        assert!(imap.move_to("4", "Archive").await.unwrap().is_empty(), "no COPYUID without UIDPLUS");
        imap.logout().await.unwrap();
        // A plain EXPUNGE would also delete other mail someone marked deleted.
        assert!(!sent.lock().unwrap().iter().any(|c| c.contains("EXPUNGE")));
    }

    #[tokio::test]
    async fn finds_a_message_by_message_id() {
        let (stream, sent) = signed_in(
            "{tag} OK [CAPABILITY IMAP4rev1] in\r\n",
            vec![
                ("UID SEARCH HEADER Message-ID", "* SEARCH 12\r\n{tag} OK done\r\n"),
                (
                    "UID FETCH 1:* (UID BODY.PEEK[HEADER.FIELDS (MESSAGE-ID)])",
                    "* 1 FETCH (UID 12 BODY[HEADER.FIELDS (MESSAGE-ID)] {32}\r\nMessage-ID: <a1@example.com>\r\n\r\n)\r\n\
                     * 2 FETCH (UID 13 BODY[HEADER.FIELDS (MESSAGE-ID)] {2}\r\n\r\n)\r\n\
                     {tag} OK done\r\n",
                ),
            ],
        );
        let mut imap = Imap::open(stream, "ada", "x").await.unwrap();
        assert_eq!(imap.find_message_id("a1@example.com").await.unwrap(), [12]);
        assert!(sent.lock().unwrap()[2].contains("<a1@example.com>"));
        assert_eq!(imap.message_ids("1:*").await.unwrap(), [(12, "a1@example.com".to_string())]);
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
                "UID FETCH 4 (UID FLAGS RFC822.SIZE BODYSTRUCTURE BODY.PEEK[HEADER.FIELDS (FROM TO CC DATE SUBJECT \
                 MESSAGE-ID IN-REPLY-TO REFERENCES LIST-ID LIST-UNSUBSCRIBE)])",
                // multipart/mixed: (alternative: plain, html), a PDF attachment, an inline image.
                "* 1 FETCH (UID 4 FLAGS (\\Seen) RFC822.SIZE 52000 BODYSTRUCTURE (\
                 ((\"TEXT\" \"PLAIN\" (\"CHARSET\" \"utf-8\") NIL NIL \"QUOTED-PRINTABLE\" 120 4 NIL NIL NIL NIL)\
                 (\"TEXT\" \"HTML\" (\"CHARSET\" \"utf-8\") NIL NIL \"7BIT\" 400 9 NIL NIL NIL NIL) \"ALTERNATIVE\")\
                 (\"APPLICATION\" \"PDF\" (\"NAME\" \"r.pdf\") NIL NIL \"BASE64\" 50000 NIL \
                 (\"ATTACHMENT\" (\"FILENAME\" \"r.pdf\")) NIL NIL)\
                 (\"IMAGE\" \"PNG\" (\"NAME\" \"logo.png\") \"<logo>\" NIL \"BASE64\" 900 NIL (\"INLINE\" NIL) NIL NIL) \
                 \"MIXED\") BODY[HEADER.FIELDS (FROM SUBJECT)] {28}\r\n\
                 From: a@b.c\r\nSubject: Hi\r\n\r\n)\r\n{tag} OK done\r\n",
            )],
        );
        let mut imap = Imap::open(stream, "ada", "x").await.unwrap();
        let fetched = imap.headers("4").await.unwrap();
        let f = &fetched[0];
        assert_eq!((f.uid, f.seen, f.size), (4, true, Some(52000)));
        assert_eq!(f.header.as_deref(), Some(&b"From: a@b.c\r\nSubject: Hi\r\n\r\n"[..]));
        assert!(f.body.is_none());
        let parts = f.structure.as_ref().expect("BODYSTRUCTURE parsed");
        let summary: Vec<_> =
            parts.iter().map(|p| (p.section.as_str(), p.mime.as_str(), p.attachment)).collect();
        assert_eq!(
            summary,
            [
                ("1.1", "text/plain", false),
                ("1.2", "text/html", false),
                ("2", "application/pdf", true),
                ("3", "image/png", false)
            ]
        );
        assert_eq!(parts[0].charset.as_deref(), Some("utf-8"));
        assert_eq!(parts[0].encoding, "quoted-printable");
        assert_eq!(parts[2].name.as_deref(), Some("r.pdf"));
        assert_eq!(Part::text_part(parts).unwrap().section, "1.1");
        assert!(
            sent.lock().unwrap().iter().any(|c| c.contains("BODY.PEEK[HEADER.FIELDS")),
            "must not mark read"
        );
    }

    #[tokio::test]
    async fn qresync_select_reports_vanished_and_changed_flags() {
        let (stream, sent) = signed_in(
            "{tag} OK [CAPABILITY IMAP4rev1 CONDSTORE QRESYNC ENABLE] in\r\n",
            vec![
                ("ENABLE QRESYNC", "* ENABLED QRESYNC\r\n{tag} OK enabled\r\n"),
                (
                    "SELECT INBOX (QRESYNC (7 100))",
                    "* 9 EXISTS\r\n* OK [UIDVALIDITY 7] v\r\n* OK [UIDNEXT 20] n\r\n* OK [HIGHESTMODSEQ 130] m\r\n\
                     * VANISHED (EARLIER) 3:4,8\r\n* 2 FETCH (UID 5 FLAGS (\\Seen \\Flagged) MODSEQ (125))\r\n\
                     {tag} OK [READ-WRITE] selected\r\n",
                ),
            ],
        );
        let mut imap = Imap::open(stream, "ada", "x").await.unwrap();
        assert!(imap.enable_qresync().await.unwrap());
        let r = imap.select_since("INBOX", 7, 100).await.unwrap();
        assert_eq!((r.selected.uid_next, r.selected.highest_modseq), (Some(20), Some(130)));
        assert_eq!(r.vanished, [3, 4, 8]);
        assert_eq!(
            r.changed.iter().map(|f| (f.uid, f.seen, f.flagged)).collect::<Vec<_>>(),
            [(5, true, true)]
        );
        assert_eq!(sent.lock().unwrap().len(), 4, "sign-in, ENABLE, one SELECT: nothing else");
    }

    #[tokio::test]
    async fn condstore_alone_asks_for_changed_flags_only() {
        let (stream, sent) = signed_in(
            "{tag} OK [CAPABILITY IMAP4rev1 CONDSTORE ENABLE] in\r\n",
            vec![
                ("ENABLE CONDSTORE", "* ENABLED CONDSTORE\r\n{tag} OK enabled\r\n"),
                (
                    "UID FETCH 1:* (UID FLAGS) (CHANGEDSINCE 100)",
                    "* 2 FETCH (UID 5 FLAGS (\\Seen) MODSEQ (120))\r\n{tag} OK done\r\n",
                ),
            ],
        );
        let mut imap = Imap::open(stream, "ada", "x").await.unwrap();
        assert!(!imap.enable_qresync().await.unwrap());
        assert!(imap.enable_condstore().await.unwrap());
        let changed = imap.flags_changed_since("1:*", 100).await.unwrap();
        assert_eq!(changed.iter().map(|f| (f.uid, f.seen)).collect::<Vec<_>>(), [(5, true)]);
        assert_eq!(sent.lock().unwrap().len(), 4);
    }

    #[tokio::test]
    async fn no_qresync_without_the_capability() {
        let (stream, sent) = signed_in("{tag} OK [CAPABILITY IMAP4rev1 CONDSTORE] in\r\n", vec![]);
        let mut imap = Imap::open(stream, "ada", "x").await.unwrap();
        assert!(!imap.enable_qresync().await.unwrap());
        assert_eq!(sent.lock().unwrap().len(), 2, "no ENABLE sent");
    }
}
