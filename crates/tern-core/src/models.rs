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
    /// How the account signs in. Older callers and stores without it mean a password.
    #[serde(default)]
    pub auth: Auth,
}

/// How an account proves who it is. Either way the secret itself is in the keychain, never here.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Auth {
    /// A password or app password.
    #[default]
    Password,
    /// Signed in with Google in the browser (XOAUTH2 on IMAP and SMTP); no password exists.
    Google,
}

impl Auth {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Password => "password",
            Self::Google => "google",
        }
    }
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
    /// inbox, archive, all, sent, drafts, trash, junk or other; on Gmail also `label` (a label, read for its
    /// membership only).
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
    /// When a snoozed conversation comes back (Unix seconds).
    pub snoozed_until: Option<i64>,
    /// A follow-up reminder on a sent message came due with no reply: pinned at the top of the inbox until done.
    pub follow_up: bool,
    /// Gmail labels on any of its messages, by name.
    pub labels: Vec<String>,
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
    /// Set when this is a draft being written in Tern: compose reopens it.
    pub draft_id: Option<i64>,
    /// The List-Unsubscribe header, raw (`<mailto:…>, <https://…>`), for the Unsubscribe button.
    pub list_unsubscribe: Option<String>,
}

/// The start of the day (what Tern shows on the first open of a day, and the line above the inbox): counts since
/// the person was last here, and the conversations that need them.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DayStart {
    /// When the person was last here (Unix seconds), as asked.
    pub since: i64,
    /// Inbox conversations with mail since then.
    pub new_since: i64,
    /// Important conversations whose newest message is someone else's, waiting longest first.
    pub need_you: Vec<ThreadRow>,
    /// Snoozed conversations that came back since then.
    pub back: Vec<ThreadRow>,
    /// Follow-ups that came due with no answer yet.
    pub waiting: Vec<ThreadRow>,
    /// Conversations with mail since then in Other (updates, lists).
    pub rest: i64,
}

/// A passage the person marked while reading, with an optional note. Only on this computer.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Mark {
    pub id: i64,
    /// The message it is in (its row in the conversation that asked).
    pub message: i64,
    pub text: String,
    pub note: String,
    /// Unix seconds.
    pub created: i64,
}

/// How someone writes from an account (package 10), as a note the AI follows when they ask it to.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiStyle {
    pub account_id: i64,
    pub note: String,
    /// Sent messages it was learned from.
    pub samples: i64,
    /// Unix seconds.
    pub updated: i64,
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
    /// `Precedence: bulk` (or list, junk): sent to many at once.
    pub precedence_bulk: bool,
    /// Addresses only, comma-separated, as `to_addrs`. Kept for reply-all.
    pub cc_addrs: String,
    pub reply_to: String,
    pub followup_to: String,
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
    /// Move to the account's junk folder (mark spam).
    Junk,
    /// Back to the inbox (Superhuman's "Mark Not Done").
    Inbox,
    /// Move to this folder. Messages of other accounts than the folder's are left where they are.
    MoveTo(i64),
    MarkRead,
    MarkUnread,
    Star,
    Unstar,
}

impl Action {
    /// Whether the action moves messages to another folder (so a list showing their folder loses them).
    pub fn moves(self) -> bool {
        matches!(self, Action::Archive | Action::Trash | Action::Junk | Action::Inbox | Action::MoveTo(_))
    }
}

/// Which list to show: one folder, every folder with a role (`{"role": "inbox"}` is the unified inbox), or a Gmail
/// label (`{"label": folder id}`: All Mail's messages that the label folder holds).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ListTarget {
    Folder(i64),
    Role(String),
    Label(i64),
}

/// Where the previous page ended, for keyset paging (no OFFSET, so page 500 costs what page 1 does).
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct Cursor {
    pub date: i64,
    pub id: i64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Draft {
    pub to: Vec<String>,
    #[serde(default)]
    pub cc: Vec<String>,
    pub subject: String,
    /// The text, plain; with `html` it is the plain-text version of the same message.
    pub body: String,
    /// The message as rich text, from the compose editor.
    #[serde(default)]
    pub html: Option<String>,
    #[serde(default)]
    pub bcc: Vec<String>,
    #[serde(default)]
    pub in_reply_to: Option<String>,
    /// The conversation's Message-IDs, oldest first, ending with the one answered (References).
    #[serde(default)]
    pub references: Vec<String>,
    /// Files to attach (Tern's own copies, so the draft keeps them whatever happens to the originals).
    #[serde(default)]
    pub attachments: Vec<OutgoingAttachment>,
    /// A forward also carries the original's attachments, fetched from the server when it is sent.
    #[serde(default)]
    pub forward_of: Option<ForwardOf>,
    /// Set when the send is queued and kept, so a second try after an uncertain one is the same message to the
    /// recipient (and to Tern, matching the copy in Sent).
    #[serde(default)]
    pub message_id: Option<String>,
    /// The HTML signature (`Signature::custom`) compose shows under the text, so a reopened draft shows it again.
    #[serde(default)]
    pub html_signature: Option<i64>,
    /// With such a signature, what goes out: the text and HTML with the signature in its place. `body` and `html`
    /// stay what the editor holds.
    #[serde(default)]
    pub out_body: Option<String>,
    #[serde(default)]
    pub out_html: Option<String>,
}

impl Draft {
    /// The text and HTML that go out.
    pub fn outgoing(&self) -> (&str, Option<&str>) {
        match (&self.out_body, &self.out_html) {
            (Some(body), Some(html)) => (body, Some(html)),
            _ => (&self.body, self.html.as_deref()),
        }
    }
}

/// Someone to suggest as a recipient.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Contact {
    pub email: String,
    pub name: String,
}

/// What Tern knows about a person, for the card on their name in a conversation.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContactCard {
    pub email: String,
    pub name: String,
    /// Messages you sent them, and they sent you, as counted for suggestions.
    pub sent: i64,
    pub received: i64,
    /// The newest message of each of your latest conversations with them.
    pub recent: Vec<MessageRow>,
}

/// A file attached to a draft, as Tern keeps it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutgoingAttachment {
    pub path: String,
    pub name: String,
    pub mime: String,
    pub size: u64,
    /// A picture put in the text: the Content-ID its `<img src="cid:…">` names. It goes out beside the HTML, not as
    /// a file, while the text still shows it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cid: Option<String>,
}

/// Where a forwarded message is on the server, to fetch its attachments when the forward is sent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForwardOf {
    pub folder: String,
    pub uid: u32,
    pub validity: Option<u32>,
    pub message_id: Option<String>,
}

impl ForwardOf {
    /// A name for the message's downloaded files that a different message never gets. Row ids are reused once
    /// the newest rows are deleted, so they can't be it: a new message would be shown the old one's files. The
    /// Message-ID stays with the message across moves; without one, its place on the server stands in.
    pub fn cache_key(&self, account_id: i64) -> String {
        let name = match &self.message_id {
            Some(id) => format!("{account_id}\nid\n{id}"),
            None => format!("{account_id}\nat\n{}\n{:?}\n{}", self.folder, self.validity, self.uid),
        };
        let digest = ring::digest::digest(&ring::digest::SHA256, name.as_bytes());
        digest.as_ref()[..16].iter().map(|b| format!("{b:02x}")).collect()
    }
}

/// A draft as compose last saved it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftRecord {
    pub id: i64,
    pub account_id: i64,
    pub draft: Draft,
    pub updated_at: i64,
}

/// What a pass does about one draft on the server.
#[derive(Debug, Clone)]
pub enum DraftSync {
    /// Put this version in the Drafts folder, then delete the copy before it (`previous`: validity, uid).
    Upload { id: i64, draft: Box<Draft>, version: i64, folder: String, previous: Option<(u32, u32)> },
    /// The draft was sent or discarded: delete its server copy, if any, and forget it.
    Remove { id: i64, folder: Option<String>, copy: Option<(u32, u32)> },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ReplyKind {
    Reply,
    ReplyAll,
    Forward,
}

/// What a reply, reply-all or forward starts with, worked out from the message's headers. The UI writes the quote
/// header in the person's locale from `quote_*`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplyInit {
    pub account_id: i64,
    pub to: Vec<String>,
    pub cc: Vec<String>,
    pub subject: String,
    pub in_reply_to: Option<String>,
    pub references: Vec<String>,
    pub quote_from: String,
    pub quote_date: i64,
    pub quote_text: String,
    /// For a forward, the other headers of the original (To, Cc), for the forwarded-message block.
    pub quote_to: String,
    pub quote_cc: String,
    /// For a forward of a message the server has, where it is (its attachments go along).
    pub forward_of: Option<ForwardOf>,
}

/// Work waiting to go to the server. Each carries what it takes to put the local store back if it is undone.
///
/// `uids` only mean something under the folder's `validity` (UIDVALIDITY) at the time; when the server has
/// renumbered the folder since, the messages are found again by Message-ID. `waiting` are messages whose uid in
/// `folder` was not known yet because an earlier move there had not finished: that move fills them in when the
/// server says where the messages went (COPYUID), or they are found by Message-ID when this work runs.
// A few at a time, read from SQLite and gone once done: a Send's size is no cost worth boxing it for.
#[allow(clippy::large_enum_variant)]
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
    /// A Gmail label added to messages (a COPY from All Mail into the label's folder) or taken off (deleting them
    /// from the label's folder, which in Gmail removes only the label). `uids` are All Mail's.
    Label {
        folder: String,
        uids: Vec<u32>,
        label: String,
        label_folder: i64,
        add: bool,
        /// Bare Message-IDs of the messages, which find them in the label's folder and put membership back on undo.
        message_ids: Vec<String>,
        /// The rows in All Mail, to find the messages again after a renumbering.
        ids: Vec<i64>,
        #[serde(default)]
        validity: Option<u32>,
    },
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

/// What a search found.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub rows: Vec<MessageRow>,
    /// The query has words, and some mail has no body here yet: words in those bodies were not searched.
    pub partial: bool,
}

/// Queued work not yet on the server and not given up, for the "changes waiting" list.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutboxWaiting {
    pub id: i64,
    pub account_id: i64,
    /// As in `OutboxProblem::what`.
    pub what: String,
    /// Unix seconds when it is next tried: the end of the undo window, or of the wait after a failed try.
    pub not_before: i64,
    pub attempts: i64,
    /// Why the last try failed; empty if none did.
    pub last_error: String,
    /// The sync worker has it in hand right now.
    pub sending: bool,
    /// Whether discarding it would leave nothing stranded: not in hand, and no later work depends on it.
    pub can_discard: bool,
    /// A message sent later on purpose (`not_before` is the time picked), not work held up.
    pub scheduled: bool,
    /// A scheduled send whose time passed while Tern was closed: it waits for "Send now" or Edit.
    pub held: bool,
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

/// What `Store::apply` did: hand `token` to `Store::undo` to take it back, and each of `drafts` (drafts deleted
/// from a Drafts folder, which are discarded rather than queued) to `Store::undo_discard`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Applied {
    pub token: Vec<i64>,
    pub accounts: Vec<i64>,
    pub drafts: Vec<i64>,
}

/// How far one account's download has come (`Store::sync_progress`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncProgress {
    pub account_id: i64,
    /// Messages here, in folders the server has counted, against that count.
    pub have: i64,
    pub total: i64,
    /// Folders not checked yet, whose size is unknown.
    pub unchecked: i64,
    /// Messages here with their text (searchable in full), out of all messages here.
    pub with_text: i64,
    pub messages: i64,
}

/// A message that just arrived, for a notification.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NewMail {
    pub id: i64,
    pub account_id: i64,
    pub thread_id: String,
    pub from_name: String,
    pub from_addr: String,
    pub subject: String,
    pub snippet: String,
    /// It sits in the inbox's Other split, which notifies only for accounts set to "Important and Other".
    pub other: bool,
}

/// A saved piece of text that compose inserts when its shortcut is typed after `;`. The body is plain text with
/// `{first_name}`-style places that compose fills in.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snippet {
    /// 0 for one not saved yet.
    pub id: i64,
    pub shortcut: String,
    pub name: String,
    pub body: String,
    /// Offered only when writing from this account; none for every account.
    #[serde(default)]
    pub account_id: Option<i64>,
    /// Becomes the subject when compose has none yet.
    #[serde(default)]
    pub subject: Option<String>,
    /// Added to Cc.
    #[serde(default)]
    pub cc: Vec<String>,
    /// How often it was used, and when last (Unix seconds). Counted by the store; saving leaves them be.
    #[serde(default)]
    pub used: i64,
    #[serde(default)]
    pub last_used: Option<i64>,
}

/// One of an account's signatures. An account has at most one for new mail and one for replies and forwards.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Signature {
    /// 0 for one not saved yet.
    pub id: i64,
    pub account_id: i64,
    pub name: String,
    /// The plain text; `html` too when it has formatting.
    pub body: String,
    #[serde(default)]
    pub html: Option<String>,
    /// `html` is the person's own (pasted from another mail app, with pictures and layout the compose editor can't
    /// hold): it goes out as it is, beside the text rather than in it.
    #[serde(default)]
    pub custom: bool,
    #[serde(default)]
    pub for_new: bool,
    #[serde(default)]
    pub for_reply: bool,
}
