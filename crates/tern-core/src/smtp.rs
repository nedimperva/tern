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
use lettre::message::Mailbox;
use lettre::transport::smtp::authentication::{Credentials, DEFAULT_MECHANISMS};
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

/// Sends a plain-text message.
/// TODO: HTML and attachments; APPEND a copy to Sent on servers that do not keep one themselves.
pub async fn send(config: &AccountConfig, password: &str, draft: &Draft) -> Result<()> {
    let message = build(config, draft)?;
    let mut conn = tokio::time::timeout(COMMAND_TIMEOUT, connect(config))
        .await
        .with_context(|| format!("No answer from {}", config.smtp_host))??;
    let credentials = Credentials::new(config.username.clone(), password.to_string());
    within(conn.auth(DEFAULT_MECHANISMS, &credentials)).await.context("The server refused the sign-in")?;
    let sent = transmit(&mut conn, message.envelope(), &message.formatted()).await;
    conn.abort().await;
    sent
}

fn build(config: &AccountConfig, draft: &Draft) -> Result<Message> {
    let name = Some(config.display_name.clone()).filter(|n| !n.is_empty());
    let from: lettre::Address = config.email.parse()?;
    let mut builder = Message::builder()
        .message_id(Some(match &draft.message_id {
            Some(id) => id.clone(),
            None => new_message_id(from.domain())?,
        }))
        .from(Mailbox::new(name, from))
        .subject(draft.subject.clone());
    for to in &draft.to {
        builder = builder.to(to.parse()?);
    }
    for cc in &draft.cc {
        builder = builder.cc(cc.parse()?);
    }
    if let Some(parent) = &draft.in_reply_to {
        let id = format!("<{}>", parent.trim_matches(|c| c == '<' || c == '>'));
        builder = builder.in_reply_to(id.clone()).references(id);
    }
    Ok(builder.header(ContentType::TEXT_PLAIN).body(draft.body.clone())?)
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
        };
        let draft = Draft {
            to: vec!["b@example.com".into()],
            cc: vec![],
            subject: "x".into(),
            body: "y".into(),
            in_reply_to: None,
            message_id: None,
        };
        let raw = String::from_utf8(build(&config, &draft).unwrap().formatted()).unwrap();
        let line = raw.lines().find(|l| l.starts_with("Message-ID: <")).expect("a Message-ID");
        assert!(line.ends_with("@example.com>"), "{line}");
        let again = String::from_utf8(build(&config, &draft).unwrap().formatted()).unwrap();
        assert!(!again.contains(line), "each message gets its own");
        let fixed = Draft { message_id: Some("<kept@example.com>".into()), ..draft };
        let raw = String::from_utf8(build(&config, &fixed).unwrap().formatted()).unwrap();
        assert!(raw.contains("Message-ID: <kept@example.com>"), "a queued send keeps its id");
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
        };
        let draft = Draft {
            to: vec!["b@example.com".into()],
            cc: vec![],
            subject: "x".into(),
            body: "y".into(),
            in_reply_to: None,
            message_id: None,
        };
        let e = send(&config, "pw", &draft).await.unwrap_err();
        assert!(!is_permanent(&e) && !maybe_sent(&e), "{e:#}");
    }
}
