//! Sends mail over SMTP.
//!
//! The conversation is run a step at a time rather than through lettre's transport, so a failure can be placed.
//! Up to and including DATA the server does not have the message, and trying again later is safe. Once the
//! message itself has been written, the server may have accepted it even if its answer never arrives; sending it
//! again could deliver it twice, so that case is reported as `MaybeSent` and the person decides.

use std::time::Duration;

use anyhow::{bail, Context, Result};
use lettre::address::Envelope;
use lettre::message::header::ContentType;
use lettre::message::{Attachment, Mailbox, MultiPart, SinglePart};
use lettre::transport::smtp::authentication::{Credentials, Mechanism, DEFAULT_MECHANISMS};

use crate::secrets::Credential;
use lettre::transport::smtp::client::{AsyncSmtpConnection, TlsParameters};
use lettre::transport::smtp::commands::{Data, Mail, Rcpt};
use lettre::transport::smtp::extension::{ClientId, Extension, MailBodyParameter, MailParameter};
use lettre::Message;

use crate::models::{AccountConfig, Draft, Security};

/// Longest wait for connecting, signing in, and each command before the message.
const COMMAND_TIMEOUT: Duration = Duration::from_secs(60);
/// The slowest upload still waited for while the message itself is written.
const MIN_BYTES_PER_SECOND: u64 = 50_000;

/// The connection broke off after the message was written and before the server said it took it. The message may
/// have gone out.
#[derive(Debug)]
pub struct MaybeSent(anyhow::Error);

impl std::fmt::Display for MaybeSent {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("The connection broke after the message was handed over, so it may have been sent")
    }
}

impl std::error::Error for MaybeSent {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(self.0.as_ref())
    }
}

/// A file to attach that is already in memory (a forwarded message's attachments): name, type, contents.
pub type FileBytes = (String, String, Vec<u8>);

/// Sends a plain-text message with the draft's attachments and `extra` ones. Returns it exactly as sent, for the
/// copy in Sent.
/// TODO: HTML (with the rich editor).
pub async fn send(
    config: &AccountConfig,
    credential: &Credential,
    draft: &Draft,
    extra: &[FileBytes],
) -> Result<Vec<u8>> {
    let message = build(config, draft, extra)?;
    let mut conn = tokio::time::timeout(COMMAND_TIMEOUT, connect(config))
        .await
        .with_context(|| format!("No answer from {}", config.smtp_host))??;
    let (secret, mechanisms) = match credential {
        Credential::Password(p) => (p, DEFAULT_MECHANISMS),
        Credential::Token(t) => (t, &[Mechanism::Xoauth2][..]),
    };
    let credentials = Credentials::new(config.username.clone(), secret.clone());
    within(conn.auth(mechanisms, &credentials)).await.context("The server refused the sign-in")?;
    let raw = message.formatted();
    let sent = transmit(&mut conn, message.envelope(), &raw).await;
    conn.abort().await;
    sent.map(|()| raw)
}

/// The message as it would be sent, for the server copy of a draft.
pub fn draft_bytes(config: &AccountConfig, draft: &Draft) -> Result<Vec<u8>> {
    Ok(build_as(config, draft, &[], true)?.formatted())
}

fn build(config: &AccountConfig, draft: &Draft, extra: &[FileBytes]) -> Result<Message> {
    build_as(config, draft, extra, false)
}

/// The addresses in `list`. A draft is unfinished: a recipient still being typed ("nedim") cannot be a header, so
/// its server copy leaves it out, and Tern's own copy keeps it. A send takes every one or fails.
fn mailboxes(list: &[String], draft: bool) -> Result<Vec<Mailbox>> {
    let mut out = Vec::new();
    for address in list {
        match address.parse::<Mailbox>() {
            Ok(mailbox) => out.push(mailbox),
            Err(_) if draft => {}
            Err(e) => return Err(e.into()),
        }
    }
    Ok(out)
}

fn build_as(config: &AccountConfig, draft: &Draft, extra: &[FileBytes], for_draft: bool) -> Result<Message> {
    let name = Some(config.display_name.clone()).filter(|n| !n.is_empty());
    let from: lettre::Address = config.email.parse()?;
    let mut builder = Message::builder()
        .message_id(Some(match &draft.message_id {
            Some(id) => id.clone(),
            None => new_message_id(from.domain())?,
        }))
        .from(Mailbox::new(name, from))
        .subject(draft.subject.clone());
    let to = mailboxes(&draft.to, for_draft)?;
    let cc = mailboxes(&draft.cc, for_draft)?;
    let bcc = mailboxes(&draft.bcc, for_draft)?;
    // A draft may have no recipients yet. lettre wants someone in the envelope to build a message at all; the
    // envelope is never used for a draft (it is only stored), and no header changes.
    if to.is_empty() && cc.is_empty() && bcc.is_empty() {
        let me: lettre::Address = config.email.parse()?;
        builder = builder.envelope(Envelope::new(Some(me.clone()), vec![me])?);
    }
    for mailbox in to {
        builder = builder.to(mailbox);
    }
    for mailbox in cc {
        builder = builder.cc(mailbox);
    }
    // lettre puts Bcc in the envelope and leaves it out of the formatted message.
    for mailbox in bcc {
        builder = builder.bcc(mailbox);
    }
    let bracket = |id: &str| format!("<{}>", id.trim_matches(|c| c == '<' || c == '>'));
    if let Some(parent) = &draft.in_reply_to {
        builder = builder.in_reply_to(bracket(parent));
        let mut chain: Vec<String> = draft.references.iter().map(|r| bracket(r)).collect();
        if !chain.contains(&bracket(parent)) {
            chain.push(bracket(parent));
        }
        builder = builder.references(chain.join(" "));
    }
    // Rich text goes as text/plain and text/html alternatives: every client reads one of them.
    let text = || match &draft.html {
        Some(html) => MultiPart::alternative_plain_html(draft.body.clone(), html.clone()),
        None => MultiPart::mixed().singlepart(SinglePart::plain(draft.body.clone())),
    };
    if draft.attachments.is_empty() && extra.is_empty() {
        return Ok(match &draft.html {
            Some(_) => builder.multipart(text())?,
            None => builder.header(ContentType::TEXT_PLAIN).body(draft.body.clone())?,
        });
    }
    let mut parts = match &draft.html {
        Some(_) => MultiPart::mixed().multipart(text()),
        None => MultiPart::mixed().singlepart(SinglePart::plain(draft.body.clone())),
    };
    for file in &draft.attachments {
        let bytes = std::fs::read(&file.path)
            .with_context(|| format!("Could not read the attachment {}", file.name))?;
        parts = parts.singlepart(Attachment::new(file.name.clone()).body(bytes, content_type(&file.mime)));
    }
    for (name, mime, bytes) in extra {
        parts = parts.singlepart(Attachment::new(name.clone()).body(bytes.clone(), content_type(mime)));
    }
    Ok(builder.multipart(parts)?)
}

fn content_type(mime: &str) -> ContentType {
    ContentType::parse(mime)
        .unwrap_or_else(|_| ContentType::parse("application/octet-stream").expect("valid"))
}

/// A new Message-ID at the sender's domain. lettre adds none on its own, and its default would carry this
/// computer's host name; without one, replies cannot thread and Tern cannot match the copy in Sent.
pub fn new_message_id(domain: &str) -> Result<String> {
    let mut random = [0u8; 16];
    rustls::crypto::ring::default_provider()
        .secure_random
        .fill(&mut random)
        .map_err(|_| anyhow::anyhow!("No randomness for a Message-ID"))?;
    let hex: String = random.iter().map(|b| format!("{b:02x}")).collect();
    Ok(format!("<{hex}@{domain}>"))
}

async fn connect(config: &AccountConfig) -> Result<AsyncSmtpConnection> {
    let hello = ClientId::default();
    let tls = TlsParameters::new(config.smtp_host.clone())?;
    let server = (config.smtp_host.as_str(), config.smtp_port);
    Ok(match config.smtp_security {
        Security::Tls => {
            AsyncSmtpConnection::connect_tokio1(server, Some(COMMAND_TIMEOUT), &hello, Some(tls), None)
                .await?
        }
        Security::Starttls => {
            let mut conn =
                AsyncSmtpConnection::connect_tokio1(server, Some(COMMAND_TIMEOUT), &hello, None, None)
                    .await?;
            // Fails when the server does not offer STARTTLS: never send the password in the clear.
            conn.starttls(tls, &hello).await?;
            conn
        }
    })
}

/// MAIL, RCPT and DATA, then the message. Everything up to DATA fails as an ordinary error; a failure after the
/// message was written without a reply from the server is `MaybeSent`.
async fn transmit(conn: &mut AsyncSmtpConnection, envelope: &Envelope, email: &[u8]) -> Result<()> {
    let info = conn.server_info();
    let mut options = Vec::new();
    let non_ascii =
        envelope.from().into_iter().chain(envelope.to()).any(|a| !AsRef::<str>::as_ref(a).is_ascii());
    if non_ascii {
        if !info.supports_feature(Extension::SmtpUtfEight) {
            bail!("The server cannot take addresses with non-ASCII letters (no SMTPUTF8)");
        }
        options.push(MailParameter::SmtpUtfEight);
    }
    if !email.is_ascii() {
        if !info.supports_feature(Extension::EightBitMime) {
            bail!("The server cannot take this message's characters (no 8BITMIME)");
        }
        options.push(MailParameter::Body(MailBodyParameter::EightBitMime));
    }
    within(conn.command(Mail::new(envelope.from().cloned(), options))).await?;
    for to in envelope.to() {
        within(conn.command(Rcpt::new(to.clone(), vec![]))).await?;
    }
    within(conn.command(Data)).await?;

    let limit = COMMAND_TIMEOUT + Duration::from_secs(email.len() as u64 / MIN_BYTES_PER_SECOND);
    match tokio::time::timeout(limit, conn.message(email)).await {
        Ok(Ok(_)) => Ok(()),
        // The server answered with a code: it said no, and it said so after reading the whole message.
        Ok(Err(e)) if e.status().is_some() => Err(e.into()),
        Ok(Err(e)) => Err(MaybeSent(e.into()).into()),
        Err(elapsed) => {
            Err(MaybeSent(anyhow::Error::new(elapsed).context("The server stopped answering")).into())
        }
    }
}

async fn within<T>(
    command: impl std::future::Future<Output = Result<T, lettre::transport::smtp::Error>>,
) -> Result<T> {
    Ok(tokio::time::timeout(COMMAND_TIMEOUT, command).await.context("The server stopped answering")??)
}

/// Whether a failed send was refused for good (an SMTP 5xx answer, such as an unknown recipient). Sending it again
/// cannot help; anything else might work on a later try.
pub fn is_permanent(e: &anyhow::Error) -> bool {
    e.chain().any(|c| c.downcast_ref::<lettre::transport::smtp::Error>().is_some_and(|e| e.is_permanent()))
}

/// Whether a failed send may have gone out anyway (see `MaybeSent`).
pub fn maybe_sent(e: &anyhow::Error) -> bool {
    e.chain().any(|c| c.is::<MaybeSent>())
}

#[cfg(test)]
mod tests {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    use tokio::net::TcpListener;

    use super::*;

    /// How the scripted server behaves once the client has sent the whole message.
    #[derive(Clone, Copy)]
    enum End {
        Accept,
        HangUp,
        Refuse,
    }

    /// A plain-text SMTP server on loopback that answers RCPT with `rcpt` and ends as `end` says. Returns the
    /// client connection, already past EHLO.
    async fn scripted(rcpt: &'static str, end: End) -> AsyncSmtpConnection {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            let (r, mut w) = socket.into_split();
            let mut r = BufReader::new(r);
            w.write_all(b"220 scripted ready\r\n").await.unwrap();
            let mut line = String::new();
            loop {
                line.clear();
                if r.read_line(&mut line).await.unwrap() == 0 {
                    return;
                }
                let verb = line.split_whitespace().next().unwrap_or("").to_ascii_uppercase();
                let reply: String = match verb.as_str() {
                    "EHLO" => "250-scripted\r\n250 8BITMIME\r\n".into(),
                    "MAIL" => "250 ok\r\n".into(),
                    "RCPT" => format!("{rcpt}\r\n"),
                    "DATA" => {
                        w.write_all(b"354 go ahead\r\n").await.unwrap();
                        while line != ".\r\n" {
                            line.clear();
                            if r.read_line(&mut line).await.unwrap() == 0 {
                                return;
                            }
                        }
                        match end {
                            End::Accept => "250 queued\r\n".into(),
                            End::Refuse => "554 rejected as spam\r\n".into(),
                            End::HangUp => return,
                        }
                    }
                    "QUIT" => "221 bye\r\n".into(),
                    _ => "500 what\r\n".into(),
                };
                w.write_all(reply.as_bytes()).await.unwrap();
            }
        });
        let hello = ClientId::Domain("tern.test".into());
        AsyncSmtpConnection::connect_tokio1(("127.0.0.1", port), None, &hello, None, None).await.unwrap()
    }

    fn message() -> Message {
        Message::builder()
            .from("a@example.com".parse().unwrap())
            .to("b@example.com".parse().unwrap())
            .subject("hi")
            .body("hello".to_string())
            .unwrap()
    }

    async fn run(rcpt: &'static str, end: End) -> Result<()> {
        let mut conn = scripted(rcpt, end).await;
        let m = message();
        transmit(&mut conn, m.envelope(), &m.formatted()).await
    }

    #[test]
    fn sent_mail_has_a_message_id_at_the_sender_domain() {
        let config = AccountConfig {
            email: "ada@example.com".into(),
            display_name: "Ada".into(),
            username: "ada".into(),
            imap_host: String::new(),
            imap_port: 993,
            imap_security: Security::Tls,
            smtp_host: String::new(),
            smtp_port: 465,
            smtp_security: Security::Tls,
            auth: Default::default(),
        };
        let draft = Draft {
            html: None,
            to: vec!["b@example.com".into()],
            cc: vec![],
            subject: "x".into(),
            body: "y".into(),
            bcc: vec![],
            in_reply_to: None,
            references: vec![],
            attachments: vec![],
            forward_of: None,
            message_id: None,
        };
        let raw = String::from_utf8(build(&config, &draft, &[]).unwrap().formatted()).unwrap();
        let line = raw.lines().find(|l| l.starts_with("Message-ID: <")).expect("a Message-ID");
        assert!(line.ends_with("@example.com>"), "{line}");
        let again = String::from_utf8(build(&config, &draft, &[]).unwrap().formatted()).unwrap();
        assert!(!again.contains(line), "each message gets its own");
        let fixed = Draft { message_id: Some("<kept@example.com>".into()), ..draft };
        let raw = String::from_utf8(build(&config, &fixed, &[]).unwrap().formatted()).unwrap();
        assert!(raw.contains("Message-ID: <kept@example.com>"), "a queued send keeps its id");
    }

    #[test]
    fn replies_carry_the_chain_and_bcc_stays_hidden() {
        let config = AccountConfig {
            email: "ada@example.com".into(),
            display_name: "Ada".into(),
            username: "ada".into(),
            imap_host: String::new(),
            imap_port: 993,
            imap_security: Security::Tls,
            smtp_host: String::new(),
            smtp_port: 465,
            smtp_security: Security::Tls,
            auth: Default::default(),
        };
        let draft = Draft {
            html: None,
            to: vec!["b@example.com".into()],
            cc: vec![],
            bcc: vec!["secret@example.com".into()],
            subject: "Re: x".into(),
            body: "y".into(),
            in_reply_to: Some("2@x.com".into()),
            references: vec!["1@x.com".into(), "2@x.com".into()],
            attachments: vec![],
            forward_of: None,
            message_id: None,
        };
        let message = build(&config, &draft, &[]).unwrap();
        let raw = String::from_utf8(message.formatted()).unwrap();
        assert!(raw.contains("In-Reply-To: <2@x.com>"), "{raw}");
        assert!(raw.contains("References: <1@x.com> <2@x.com>"), "{raw}");
        assert!(!raw.to_lowercase().contains("secret@"), "no Bcc in the message: {raw}");
        let envelope: Vec<String> = message.envelope().to().iter().map(|a| a.to_string()).collect();
        assert!(envelope.contains(&"secret@example.com".to_string()), "but it is delivered to");
    }

    #[test]
    fn a_draft_copy_leaves_out_a_recipient_still_being_typed() {
        let config = AccountConfig {
            email: "ada@example.com".into(),
            display_name: "Ada".into(),
            username: "ada".into(),
            imap_host: String::new(),
            imap_port: 993,
            imap_security: Security::Tls,
            smtp_host: String::new(),
            smtp_port: 465,
            smtp_security: Security::Tls,
            auth: Default::default(),
        };
        let draft = Draft {
            html: None,
            to: vec!["nedim".into()],
            cc: vec!["b@example.com".into()],
            bcc: vec![],
            subject: "Half done".into(),
            body: "y".into(),
            in_reply_to: None,
            references: vec![],
            attachments: vec![],
            forward_of: None,
            message_id: Some("<1@example.com>".into()),
        };
        let raw = String::from_utf8(draft_bytes(&config, &draft).unwrap()).unwrap();
        assert!(raw.contains("Cc: b@example.com"), "{raw}");
        assert!(!raw.contains("nedim"), "{raw}");
        let alone = Draft { cc: vec![], ..draft.clone() };
        assert!(draft_bytes(&config, &alone).is_ok(), "no usable recipient at all is fine for a draft");
        assert!(build(&config, &draft, &[]).is_err(), "a send still refuses it");
    }

    #[test]
    fn attachments_go_out_and_come_back_whole() {
        let dir = std::env::temp_dir().join(format!("tern-attach-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let pdf: Vec<u8> = (0..=255u8).cycle().take(5000).collect();
        std::fs::write(dir.join("q3.pdf"), &pdf).unwrap();
        let config = AccountConfig {
            email: "ada@example.com".into(),
            display_name: String::new(),
            username: "ada".into(),
            imap_host: String::new(),
            imap_port: 993,
            imap_security: Security::Tls,
            smtp_host: String::new(),
            smtp_port: 465,
            smtp_security: Security::Tls,
            auth: Default::default(),
        };
        let draft = Draft {
            html: None,
            to: vec!["b@example.com".into()],
            cc: vec![],
            bcc: vec![],
            subject: "files".into(),
            body: "Two files.".into(),
            in_reply_to: None,
            references: vec![],
            attachments: vec![crate::models::OutgoingAttachment {
                path: dir.join("q3.pdf").display().to_string(),
                name: "q3.pdf".into(),
                mime: "application/pdf".into(),
                size: pdf.len() as u64,
            }],
            forward_of: None,
            message_id: None,
        };
        let extra = vec![("notes.txt".to_string(), "text/plain".to_string(), b"forwarded along".to_vec())];
        let raw = build(&config, &draft, &extra).unwrap().formatted();
        let files = crate::mime::attachment_files(&raw);
        assert_eq!(files.len(), 2);
        assert_eq!((files[0].0.as_str(), files[0].1.as_str()), ("q3.pdf", "application/pdf"));
        assert_eq!(files[0].2, pdf, "bytes survive the trip");
        assert_eq!(files[1].2, b"forwarded along");
        let parsed = crate::mime::parse(1, &raw, false, false).unwrap();
        assert_eq!(parsed.body_text.as_deref().map(str::trim), Some("Two files."));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn rich_text_goes_as_plain_and_html() {
        let config = AccountConfig {
            email: "ada@example.com".into(),
            display_name: String::new(),
            username: "ada".into(),
            imap_host: String::new(),
            imap_port: 993,
            imap_security: Security::Tls,
            smtp_host: String::new(),
            smtp_port: 465,
            smtp_security: Security::Tls,
            auth: Default::default(),
        };
        let draft = Draft {
            html: Some("<p>Hello <strong>there</strong></p>".into()),
            to: vec!["b@example.com".into()],
            cc: vec![],
            bcc: vec![],
            subject: "rich".into(),
            body: "Hello there".into(),
            in_reply_to: None,
            references: vec![],
            attachments: vec![],
            forward_of: None,
            message_id: None,
        };
        let raw = build(&config, &draft, &[]).unwrap().formatted();
        let text = String::from_utf8_lossy(&raw);
        assert!(text.contains("multipart/alternative"), "{text}");
        let parsed = crate::mime::parse(1, &raw, false, false).unwrap();
        assert_eq!(parsed.body_text.as_deref().map(str::trim), Some("Hello there"));
        assert!(parsed.body_html.unwrap().contains("<strong>there</strong>"));
        // With a file: mixed, holding the alternative and the file.
        let extra = vec![("a.txt".to_string(), "text/plain".to_string(), b"x".to_vec())];
        let raw = build(&config, &draft, &extra).unwrap().formatted();
        assert_eq!(crate::mime::attachment_files(&raw).len(), 1);
        assert!(crate::mime::parse(1, &raw, false, false).unwrap().body_html.unwrap().contains("<strong>"));
    }

    #[tokio::test]
    async fn accepted() {
        run("250 ok", End::Accept).await.unwrap();
    }

    #[tokio::test]
    async fn hang_up_after_the_message_may_have_sent_it() {
        let e = run("250 ok", End::HangUp).await.unwrap_err();
        assert!(maybe_sent(&e), "{e:#}");
        assert!(!is_permanent(&e));
    }

    #[tokio::test]
    async fn refused_after_the_message_was_not_sent() {
        let e = run("250 ok", End::Refuse).await.unwrap_err();
        assert!(!maybe_sent(&e));
        assert!(is_permanent(&e), "{e:#}");
    }

    #[tokio::test]
    async fn refusals_before_data_are_definite() {
        let e = run("550 no such user", End::Accept).await.unwrap_err();
        assert!(is_permanent(&e) && !maybe_sent(&e), "{e:#}");
        let e = run("451 try later", End::Accept).await.unwrap_err();
        assert!(!is_permanent(&e) && !maybe_sent(&e), "{e:#}");
    }

    #[tokio::test]
    async fn no_server_is_safe_to_retry() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let config = AccountConfig {
            email: "a@example.com".into(),
            display_name: String::new(),
            username: "a@example.com".into(),
            imap_host: "127.0.0.1".into(),
            imap_port: 1,
            imap_security: Security::Tls,
            smtp_host: "127.0.0.1".into(),
            smtp_port: port,
            smtp_security: Security::Tls,
            auth: Default::default(),
        };
        let draft = Draft {
            html: None,
            to: vec!["b@example.com".into()],
            cc: vec![],
            subject: "x".into(),
            body: "y".into(),
            bcc: vec![],
            in_reply_to: None,
            references: vec![],
            attachments: vec![],
            forward_of: None,
            message_id: None,
        };
        let e = send(&config, &Credential::Password("pw".into()), &draft, &[]).await.unwrap_err();
        assert!(!is_permanent(&e) && !maybe_sent(&e), "{e:#}");
    }
}
