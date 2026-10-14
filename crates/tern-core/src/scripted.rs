//! A scripted IMAP server for tests: the transport seam that lets sync and outbox code run against any
//! conversation, including ones a real server rarely has (renumbered folders, dropped connections).

use std::sync::{Arc, Mutex};

use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader, DuplexStream};

/// One expected client command (matched by prefix, tag stripped) and the server's reply. `{tag}` in the reply
/// becomes the tag of the most recent tagged command; an empty `expect` matches any line.
pub type Script = Vec<(&'static str, &'static str)>;

/// A scripted IMAP server. Returns the client end and every line the client sent, tags stripped.
pub fn server(greeting: &'static str, script: Script) -> (DuplexStream, Arc<Mutex<Vec<String>>>) {
    let (client, server) = tokio::io::duplex(1 << 16);
    let sent = Arc::new(Mutex::new(Vec::new()));
    let log = sent.clone();
    tokio::spawn(async move {
        let (r, mut w) = tokio::io::split(server);
        let mut r = BufReader::new(r);
        w.write_all(greeting.as_bytes()).await.unwrap();
        let mut tag = String::new();
        for (expect, reply) in script {
            let mut line = String::new();
            if r.read_line(&mut line).await.unwrap() == 0 {
                return;
            }
            let line = line.trim_end().to_string();
            let mut words = line.splitn(2, ' ');
            let (first, rest) = (words.next().unwrap_or(""), words.next());
            let command = match rest {
                Some(rest) if rest.starts_with(|c: char| c.is_ascii_alphabetic()) => {
                    tag = first.to_string();
                    rest.to_string()
                }
                _ => line.clone(),
            };
            assert!(command.starts_with(expect), "expected {expect:?}, client sent {command:?}");
            w.write_all(reply.replace("{tag}", &tag).as_bytes()).await.unwrap();
            // A literal ({N} at the end, answered with "+"): its N bytes follow raw, then the rest of the command's
            // line, which the next script entry answers (usually with an empty `expect`).
            let literal =
                command.strip_suffix('}').and_then(|c| c.rsplit_once('{')).and_then(|(_, n)| n.parse().ok());
            log.lock().unwrap().push(command);
            if let (Some(n), true) = (literal, reply.starts_with('+')) {
                let mut bytes = vec![0u8; n];
                r.read_exact(&mut bytes).await.unwrap();
            }
        }
    });
    (client, sent)
}

pub const GREETING: &str = "* OK [CAPABILITY IMAP4rev1 AUTH=PLAIN] ready\r\n";

pub fn signed_in(capabilities: &'static str, script: Script) -> (DuplexStream, Arc<Mutex<Vec<String>>>) {
    let mut all: Script = vec![("AUTHENTICATE PLAIN", "+ \r\n"), ("", capabilities)];
    all.extend(script);
    server(GREETING, all)
}
