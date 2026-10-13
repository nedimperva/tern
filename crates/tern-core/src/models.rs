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
}

/// Work waiting to go to the server. Each carries what it takes to put the local store back if it is undone.
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
    },
    Move {
        folder: String,
        dest: String,
        uids: Vec<u32>,
        /// (message id, folder id, uid) before the change.
        revert: Vec<(i64, i64, Option<u32>)>,
    },
    Send(Draft),
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
}

/// What `Store::apply` did: hand `token` to `Store::undo` to take it back.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Applied {
    pub token: Vec<i64>,
    pub accounts: Vec<i64>,
}
