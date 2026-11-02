//! Checks against the local dev mail server (scripts/dev-mail-server.sh). Ignored by default because they need
//! the server running; `scripts/dev-mail-server.sh test` runs them with the test CA trusted.

use std::path::PathBuf;

use tern_core::imap::{self, TlsImap};
use tern_core::models::{AccountConfig, Draft, Security};

fn password() -> String {
    let dir = std::env::var_os("TERN_DEVMAIL").map(PathBuf::from).unwrap_or_else(|| {
        PathBuf::from(std::env::var_os("HOME").unwrap()).join(".local/share/tern-devmail")
    });
    std::fs::read_to_string(dir.join("test-password"))
        .expect("run scripts/dev-mail-server.sh setup")
        .trim()
        .into()
}

async fn sign_in() -> TlsImap {
    imap::connect("localhost", 1993, Security::Tls, "test@localhost", &password())
        .await
        .expect("is the dev server running?")
}

#[tokio::test]
#[ignore = "needs scripts/dev-mail-server.sh start"]
async fn flags_round_trip() {
    let mut s = sign_in().await;
    s.select("INBOX").await.unwrap();
    let uid = *s.uids().await.unwrap().iter().min().expect("seed the inbox first");
    let set = uid.to_string();

    s.store_flag(&set, "\\Flagged", true).await.unwrap();
    assert!(s.flags(&set).await.unwrap()[0].flagged);
    s.store_flag(&set, "\\Flagged", false).await.unwrap();
    assert!(!s.flags(&set).await.unwrap()[0].flagged);
    s.logout().await.unwrap();
}

#[tokio::test]
#[ignore = "needs scripts/dev-mail-server.sh start"]
async fn move_to_archive_and_back() {
    let mut s = sign_in().await;
    assert!(s.has("MOVE"), "Stalwart advertises MOVE");
    s.select("INBOX").await.unwrap();
    let before = s.uids().await.unwrap();
    let uid = *before.iter().max().expect("seed the inbox first");
    let body = s.bodies(&uid.to_string()).await.unwrap().remove(0).body.unwrap();

    s.move_to(&uid.to_string(), "Archive").await.unwrap();
    assert!(!s.uids().await.unwrap().contains(&uid));

    // Find it in Archive by content and put it back, so the test leaves the mailbox as it found it.
    s.select("Archive").await.unwrap();
    let archived = s.uids().await.unwrap();
    let mut back = None;
    for a in archived {
        if s.bodies(&a.to_string()).await.unwrap()[0].body.as_deref() == Some(&body[..]) {
            back = Some(a);
        }
    }
    let back = back.expect("the moved message is in Archive");
    s.move_to(&back.to_string(), "INBOX").await.unwrap();
    // Other checks deliver mail to the inbox at the same time, so look for this message rather than count.
    s.select("INBOX").await.unwrap();
    let mut found = false;
    for u in s.uids().await.unwrap().difference(&before) {
        found |= s.bodies(&u.to_string()).await.unwrap()[0].body.as_deref() == Some(&body[..]);
    }
    assert!(found, "the message is back in the inbox");
    s.logout().await.unwrap();
}

#[tokio::test]
#[ignore = "needs scripts/dev-mail-server.sh start"]
async fn imap_starttls() {
    let s =
        imap::connect("localhost", 1143, Security::Starttls, "test@localhost", &password()).await.unwrap();
    assert!(s.has("IMAP4REV1") || s.has("IMAP4REV2"));
    s.logout().await.unwrap();
}

fn account(smtp_port: u16, smtp_security: Security) -> AccountConfig {
    AccountConfig {
        email: "test@localhost".into(),
        display_name: "Tern test".into(),
        username: "test@localhost".into(),
        imap_host: "localhost".into(),
        imap_port: 1993,
        imap_security: Security::Tls,
        smtp_host: "localhost".into(),
        smtp_port,
        smtp_security,
        auth: Default::default(),
        aliases: Vec::new(),
    }
}

/// Sends through tern_core::smtp and waits for the message to show up in the inbox.
async fn send_and_find(config: &AccountConfig) {
    let subject = format!("smtp check {} {:?}", std::process::id(), config.smtp_security);
    let draft = Draft {
        from: None,
        html: None,
        to: vec!["test@localhost".into()],
        cc: vec![],
        subject: subject.clone(),
        body: "Sent by the dev-server checks.".into(),
        bcc: vec![],
        in_reply_to: None,
        references: vec![],
        attachments: vec![],
        forward_of: None,
        message_id: None,
        html_signature: None,
        out_body: None,
        out_html: None,
    };
    let mut s = sign_in().await;
    s.select("INBOX").await.unwrap();
    let before = s.uids().await.unwrap();
    tern_core::smtp::send(config, &tern_core::secrets::Credential::Password(password()), &draft, &[])
        .await
        .unwrap();

    // Other checks deliver mail at the same time: look at everything that arrived since, not just the newest.
    for _ in 0..20 {
        s.select("INBOX").await.unwrap();
        for uid in s.uids().await.unwrap().difference(&before) {
            let body = s.bodies(&uid.to_string()).await.unwrap().remove(0).body.unwrap();
            if String::from_utf8_lossy(&body).contains(&subject) {
                s.logout().await.unwrap();
                return;
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
    }
    panic!("the message did not arrive in 5 s");
}

#[tokio::test]
#[ignore = "needs scripts/dev-mail-server.sh start"]
async fn sends_over_smtp_tls() {
    // 1465 is implicit TLS on a non-standard port: the case port-guessing got wrong.
    send_and_find(&account(1465, Security::Tls)).await;
}

#[tokio::test]
#[ignore = "needs scripts/dev-mail-server.sh start"]
async fn sends_over_smtp_starttls() {
    send_and_find(&account(1587, Security::Starttls)).await;
}

#[tokio::test]
#[ignore = "needs scripts/dev-mail-server.sh start"]
async fn unknown_recipient_is_a_permanent_failure() {
    let draft = Draft {
        from: None,
        html: None,
        to: vec!["nobody-here@localhost".into()],
        cc: vec![],
        subject: "to nobody".into(),
        body: "This address does not exist on the dev server.".into(),
        bcc: vec![],
        in_reply_to: None,
        references: vec![],
        attachments: vec![],
        forward_of: None,
        message_id: None,
        html_signature: None,
        out_body: None,
        out_html: None,
    };
    let err = tern_core::smtp::send(
        &account(1465, Security::Tls),
        &tern_core::secrets::Credential::Password(password()),
        &draft,
        &[],
    )
    .await
    .err()
    .unwrap();
    assert!(tern_core::smtp::is_permanent(&err), "{err:#}");
}

#[tokio::test]
#[ignore = "needs scripts/dev-mail-server.sh start"]
async fn idle_wakes_on_new_mail() {
    let mut s = sign_in().await;
    assert!(s.has("IDLE"));
    s.select("INBOX").await.unwrap();
    let deliver = tokio::spawn(async {
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        let draft = Draft {
            from: None,
            html: None,
            to: vec!["test@localhost".into()],
            cc: vec![],
            subject: "idle check".into(),
            body: "Wakes IDLE.".into(),
            bcc: vec![],
            in_reply_to: None,
            references: vec![],
            attachments: vec![],
            forward_of: None,
            message_id: None,
            html_signature: None,
            out_body: None,
            out_html: None,
        };
        tern_core::smtp::send(
            &account(1465, Security::Tls),
            &tern_core::secrets::Credential::Password(password()),
            &draft,
            &[],
        )
        .await
        .unwrap();
    });
    let outcome = s.idle(std::time::Duration::from_secs(10)).await.unwrap();
    deliver.await.unwrap();
    assert_eq!(outcome, imap::Idled::Changed);
    s.logout().await.unwrap();
}
