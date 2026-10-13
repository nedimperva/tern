use anyhow::Result;
use lettre::message::header::ContentType;
use lettre::message::Mailbox;
use lettre::transport::smtp::authentication::Credentials;
use lettre::{AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor};

use crate::models::{AccountConfig, Draft, Security};

/// Sends a plain-text message.
/// TODO: HTML and attachments; APPEND a copy to Sent on servers that do not keep one themselves.
pub async fn send(config: &AccountConfig, password: &str, draft: &Draft) -> Result<()> {
    let name = Some(config.display_name.clone()).filter(|n| !n.is_empty());
    let mut builder =
        Message::builder().from(Mailbox::new(name, config.email.parse()?)).subject(draft.subject.clone());
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
    let message = builder.header(ContentType::TEXT_PLAIN).body(draft.body.clone())?;

    let transport = match config.smtp_security {
        Security::Tls => AsyncSmtpTransport::<Tokio1Executor>::relay(&config.smtp_host)?,
        Security::Starttls => AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(&config.smtp_host)?,
    };
    transport
        .port(config.smtp_port)
        .credentials(Credentials::new(config.username.clone(), password.to_string()))
        .build()
        .send(message)
        .await?;
    Ok(())
}

/// Whether a failed send was refused for good (an SMTP 5xx answer, such as an unknown recipient). Sending it again
/// cannot help; anything else might work on a later try.
pub fn is_permanent(e: &anyhow::Error) -> bool {
    e.chain().any(|c| c.downcast_ref::<lettre::transport::smtp::Error>().is_some_and(|e| e.is_permanent()))
}
