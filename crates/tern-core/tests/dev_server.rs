//! Checks against the local dev mail server (scripts/dev-mail-server.sh). Ignored by default because they need
//! the server running; `scripts/dev-mail-server.sh test` runs them with the test CA trusted.

use std::path::PathBuf;

use tern_core::imap::{self, TlsImap};

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
    imap::connect("localhost", 1993, "test@localhost", &password()).await.expect("is the dev server running?")
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
    s.select("INBOX").await.unwrap();
    assert_eq!(s.uids().await.unwrap().len(), before.len());
    s.logout().await.unwrap();
}

#[tokio::test]
#[ignore = "needs scripts/dev-mail-server.sh start"]
async fn sends_over_smtp_and_arrives() {
    let config = tern_core::models::AccountConfig {
        email: "test@localhost".into(),
        display_name: "Tern test".into(),
        username: "test@localhost".into(),
        imap_host: "localhost".into(),
        imap_port: 1993,
        smtp_host: "localhost".into(),
        // Tern picks implicit TLS only for port 465, so the dev server's 1465 would be spoken to with STARTTLS
        // and hang. 1587 is the dev server's STARTTLS submission port.
        smtp_port: 1587,
    };
    let subject = format!("smtp check {}", std::process::id());
    let draft = tern_core::models::Draft {
        to: vec!["test@localhost".into()],
        cc: vec![],
        subject: subject.clone(),
        body: "Sent by sends_over_smtp_and_arrives.".into(),
        in_reply_to: None,
    };
    tern_core::smtp::send(&config, &password(), &draft).await.unwrap();

    let mut s = sign_in().await;
    for _ in 0..20 {
        s.select("INBOX").await.unwrap();
        let newest = *s.uids().await.unwrap().iter().max().unwrap();
        let body = s.bodies(&newest.to_string()).await.unwrap().remove(0).body.unwrap();
        if String::from_utf8_lossy(&body).contains(&subject) {
            s.logout().await.unwrap();
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
    }
    panic!("the message did not arrive in 5 s");
}
