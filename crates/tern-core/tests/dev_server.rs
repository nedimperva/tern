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
