use serde::{Deserialize, Serialize};

/// How to reach one mailbox. The password is not here: it lives in the system keychain (see `secrets`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountConfig {
    pub email: String,
    pub display_name: String,
    pub username: String,
    pub imap_host: String,
    pub imap_port: u16,
    pub imap_security: Security,
    pub smtp_host: String,
    pub smtp_port: u16,
    pub smtp_security: Security,
}

/// How a connection is encrypted. There is no unencrypted option: passwords never cross the network in clear.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Security {
    /// TLS from the first byte (IMAP 993, SMTP 465).
    Tls,
    /// Plain connection upgraded with STARTTLS before signing in (IMAP 143, SMTP 587).
    Starttls,
}

impl Security {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Tls => "tls",
            Self::Starttls => "starttls",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "tls" => Some(Self::Tls),
            "starttls" => Some(Self::Starttls),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub id: i64,
    #[serde(flatten)]
    pub config: AccountConfig,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Folder {
    pub id: i64,
    pub account_id: i64,
    pub name: String,
    /// inbox, archive, all, sent, drafts, trash, junk or other.
    pub role: String,
    pub unread: i64,
}

/// One row of a message list: everything the list draws, nothing it does not.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageRow {
    pub id: i64,
    pub account_id: i64,
    pub folder_id: i64,
    pub thread_id: String,
    pub subject: String,
    pub from_name: String,
    pub from_addr: String,
    /// Unix seconds.
    pub date: i64,
    pub snippet: String,
    pub seen: bool,
    pub flagged: bool,
    pub has_attachments: bool,
}

/// One conversation in a list: its newest message in the listed folder(s), and what the whole conversation (in
/// every folder) adds up to.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadRow {
    #[serde(flatten)]
    pub latest: MessageRow,
    /// Messages in the conversation, each counted once however many folders hold it.
    pub count: i64,
    pub unread: i64,
    pub flagged: bool,
    /// Who wrote in it, first to last, each once (names where known), at most four.
    pub participants: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadMessage {
    #[serde(flatten)]
    pub row: MessageRow,
    pub message_id: Option<String>,
    pub to_addrs: String,
    pub body_text: Option<String>,
    pub body_html: Option<String>,
    /// False while only the headers are here; the body is on its way (or fetched when the message is opened).
    pub body_loaded: bool,
    /// Files attached, as far as known (from BODYSTRUCTURE or the parsed body).
    pub attachments: Vec<Attachment>,
}

/// An attached file, for the strip under a message.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Attachment {
    pub name: String,
    pub mime: String,
    pub size: u32,
}

/// A message as it came off the server, parsed.
#[derive(Debug, Clone, Default)]
pub struct NewMessage {
    pub uid: u32,
    pub message_id: Option<String>,
    pub in_reply_to: Option<String>,
    pub references: Vec<String>,
    pub subject: String,
    pub from_name: String,
    pub from_addr: String,
    pub to_addrs: String,
    pub date: i64,
    pub snippet: String,
    pub seen: bool,
    pub flagged: bool,
    pub has_attachments: bool,
    pub body_text: Option<String>,
    pub body_html: Option<String>,
    /// Size on the server (RFC822.SIZE), when known.
    pub size: Option<u32>,
    /// Only the headers were fetched: no body, no snippet yet.
    pub headers_only: bool,
    /// List-Id and List-Unsubscribe, raw, for mailing-list handling later.
    pub list_id: Option<String>,
    pub list_unsubscribe: Option<String>,
    /// The message's parts from BODYSTRUCTURE, when the server sent it with the headers.
    pub parts: Option<Vec<Part>>,
}

/// One leaf part of a message, from BODYSTRUCTURE: enough to fetch just that part, or to list it as an attachment
/// without fetching it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Part {
    /// IMAP section number: "1" for a single-part message, "1.2" for the second part of the first multipart.
    pub section: String,
    /// Lowercase type/subtype, such as "text/plain".
    pub mime: String,
    /// Content-Transfer-Encoding, lowercase.
    pub encoding: String,
    pub charset: Option<String>,
    pub size: u32,
    pub name: Option<String>,
    /// Shown as an attachment: marked so, or a named part that is not text and not an inline image.
    pub attachment: bool,
}

impl Part {
    /// The part to read a snippet from: the first plain-text body part, else the first HTML one.
    pub fn text_part(parts: &[Part]) -> Option<&Part> {
        let body = |mime: &str| parts.iter().find(|p| p.mime == mime && !p.attachment);
        body("text/plain").or_else(|| body("text/html"))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Action {
    Archive,
    Trash,
    MarkRead,
    MarkUnread,
    Star,
    Unstar,
}

/// Which list to show: one folder, or every folder with a role (`{"role": "inbox"}` is the unified inbox).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ListTarget {
    Folder(i64),
    Role(String),
}

/// Where the previous page ended, for keyset paging (no OFFSET, so page 500 costs what page 1 does).
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct Cursor {
    pub date: i64,
    pub id: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Draft {
    pub to: Vec<String>,
    #[serde(default)]
    pub cc: Vec<String>,
    pub subject: String,
    pub body: String,
    #[serde(default)]
    pub in_reply_to: Option<String>,
    /// Set when the send is queued and kept, so a second try after an uncertain one is the same message to the
    /// recipient (and to Tern, matching the copy in Sent).
    #[serde(default)]
    pub message_id: Option<String>,
}

/// Work waiting to go to the server. Each carries what it takes to put the local store back if it is undone.
///
/// `uids` only mean something under the folder's `validity` (UIDVALIDITY) at the time; when the server has
/// renumbered the folder since, the messages are found again by Message-ID. `waiting` are messages whose uid in
/// `folder` was not known yet because an earlier move there had not finished: that move fills them in when the
/// server says where the messages went (COPYUID), or they are found by Message-ID when this work runs.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum OutboxOp {
    Flags {
        folder: String,
        uids: Vec<u32>,
        flag: String,
        add: bool,
        /// (message id, seen, flagged) before the change.
        revert: Vec<(i64, bool, bool)>,
        #[serde(default)]
        validity: Option<u32>,
        #[serde(default)]
        waiting: Vec<i64>,
    },
    Move {
        folder: String,
        dest: String,
        uids: Vec<u32>,
        /// (message id, folder id, uid) before the change.
        revert: Vec<(i64, i64, Option<u32>)>,
        #[serde(default)]
        validity: Option<u32>,
        #[serde(default)]
        waiting: Vec<i64>,
    },
    Send(Draft),
    /// A copy of a sent message for the Sent folder, exactly as it went out.
    Append {
        folder: String,
        subject: String,
        message: String,
    },
}

/// Where a folder's sync stands, kept between passes.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct FolderState {
    pub uid_validity: Option<u32>,
    /// UIDNEXT once every message below it is here. None while new mail is still to fetch, so the next pass looks.
    pub uid_next: Option<u32>,
    /// The modification sequence every flag change and expunge up to has been applied from (CONDSTORE/QRESYNC).
    pub highest_modseq: Option<i64>,
}

/// Queued work Tern stopped retrying, waiting for the person to retry or discard it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutboxProblem {
    pub id: i64,
    pub account_id: i64,
    /// What the work was, in a few words: "Send “Lunch?”", "Archive 3 messages".
    pub what: String,
    pub attempts: i64,
    pub last_error: String,
    pub gave_up_at: i64,
    /// A send that broke off after the message was handed to the server: it may well have gone out.
    pub maybe_sent: bool,
}

/// How a try at queued work went wrong, which decides what happens to it next.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Failure {
    /// Might work later: try again after a wait.
    Retry,
    /// The server said no in a way that trying again cannot change.
    Permanent,
    /// A send that may have gone out. Sending it again could deliver it twice, so the person decides.
    MaybeSent,
}

/// What `Store::apply` did: hand `token` to `Store::undo` to take it back.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Applied {
    pub token: Vec<i64>,
    pub accounts: Vec<i64>,
}
