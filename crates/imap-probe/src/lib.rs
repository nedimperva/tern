//! Shared harness for the package 01 IMAP library probe: server details, a neutral raw-IMAP connection for
//! setup and out-of-band changes, a scripted fake server for Gmail-only responses, and the report table.
//! Neither contender's code is used here, so setup cannot favour one of them.

use std::future::Future;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};
use rustls::pki_types::pem::PemObject;
use rustls::pki_types::{CertificateDer, ServerName};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader, DuplexStream};
use tokio::net::TcpStream;
use tokio_rustls::client::TlsStream;
use tokio_rustls::TlsConnector;

pub const HOST: &str = "localhost";
pub const IMAPS: u16 = 1993;
pub const IMAP_STARTTLS: u16 = 1143;
pub const USER: &str = "test@localhost";
/// Messages put into each probe folder; above async-imap's unsolicited channel capacity of 100.
pub const SMALL: u32 = 200;
/// Messages flagged out of band before the QRESYNC resync.
pub const FLAGGED: u32 = 150;
/// Messages expunged out of band before the QRESYNC resync.
pub const EXPUNGED: u32 = 3;
pub const BIG_BYTES: usize = 20_000_000;

pub fn devmail_dir() -> PathBuf {
    std::env::var_os("TERN_DEVMAIL")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(std::env::var_os("HOME").unwrap()).join(".local/share/tern-devmail"))
}

pub fn password() -> Result<String> {
    let path = devmail_dir().join("test-password");
    Ok(std::fs::read_to_string(&path).with_context(|| format!("{}", path.display()))?.trim().to_string())
}

/// rustls trusting only the dev server's test CA, for both contenders.
pub fn tls_connector() -> Result<TlsConnector> {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let mut roots = rustls::RootCertStore::empty();
    for cert in CertificateDer::pem_file_iter(devmail_dir().join("tls/ca.pem"))? {
        roots.add(cert?)?;
    }
    let config = rustls::ClientConfig::builder().with_root_certificates(roots).with_no_client_auth();
    Ok(TlsConnector::from(Arc::new(config)))
}

/// TCP with Nagle off, as Tern would use it: IMAP is many small request/response round trips.
pub async fn tcp_connect(port: u16) -> Result<TcpStream> {
    let tcp = TcpStream::connect((HOST, port)).await?;
    tcp.set_nodelay(true)?;
    Ok(tcp)
}

pub async fn tls_connect(port: u16) -> Result<TlsStream<TcpStream>> {
    let tcp = tcp_connect(port).await?;
    Ok(tls_connector()?.connect(ServerName::try_from(HOST)?.to_owned(), tcp).await?)
}

pub fn server_name() -> ServerName<'static> {
    ServerName::try_from(HOST).unwrap().to_owned()
}

/// A deliberately dumb IMAP connection: send a command, collect lines until its tagged reply.
pub struct Raw {
    stream: BufReader<TlsStream<TcpStream>>,
    tag: u32,
}

impl Raw {
    pub async fn login() -> Result<Self> {
        let mut raw = Self { stream: BufReader::new(tls_connect(IMAPS).await?), tag: 0 };
        let mut greeting = String::new();
        raw.stream.read_line(&mut greeting).await?;
        raw.cmd(&format!("LOGIN \"{USER}\" \"{}\"", password()?)).await?;
        Ok(raw)
    }

    pub async fn cmd(&mut self, command: &str) -> Result<Vec<String>> {
        self.tag += 1;
        let tag = format!("R{}", self.tag);
        self.stream.get_mut().write_all(format!("{tag} {command}\r\n").as_bytes()).await?;
        self.read_until(&tag).await
    }

    /// APPEND with a non-synchronising literal (LITERAL+), so the message goes in one write.
    pub async fn append(&mut self, mailbox: &str, message: &[u8]) -> Result<()> {
        self.tag += 1;
        let tag = format!("R{}", self.tag);
        let head = format!("{tag} APPEND \"{mailbox}\" {{{}+}}\r\n", message.len());
        let s = self.stream.get_mut();
        s.write_all(head.as_bytes()).await?;
        s.write_all(message).await?;
        s.write_all(b"\r\n").await?;
        self.read_until(&tag).await.map(|_| ())
    }

    async fn read_until(&mut self, tag: &str) -> Result<Vec<String>> {
        let mut lines = Vec::new();
        loop {
            let mut line = String::new();
            if self.stream.read_line(&mut line).await? == 0 {
                bail!("server closed the connection");
            }
            if let Some(rest) = line.strip_prefix(&format!("{tag} ")) {
                if !rest.starts_with("OK") {
                    bail!("{}", line.trim_end());
                }
                return Ok(lines);
            }
            lines.push(line);
        }
    }
}

pub fn small_message(i: u32) -> Vec<u8> {
    format!(
        "From: Probe {i} <probe{i}@localhost>\r\nTo: {USER}\r\nSubject: Probe message {i}\r\n\
         Message-ID: <probe-{i}@localhost>\r\nDate: Mon, 12 Oct 2026 10:00:00 +0000\r\n\r\nBody {i}.\r\n"
    )
    .into_bytes()
}

/// About BIG_BYTES of MIME: a short text part and a base64 attachment.
pub fn big_message() -> Vec<u8> {
    let mut m = format!(
        "From: Big <big@localhost>\r\nTo: {USER}\r\nSubject: Big attachment\r\nMessage-ID: <big@localhost>\r\n\
         Date: Mon, 12 Oct 2026 11:00:00 +0000\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=b\r\n\r\n\
         --b\r\nContent-Type: text/plain\r\n\r\nSee attachment.\r\n--b\r\nContent-Type: application/octet-stream\r\n\
         Content-Transfer-Encoding: base64\r\nContent-Disposition: attachment; filename=big.bin\r\n\r\n"
    )
    .into_bytes();
    let line = b"QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ejAxMjM0NTY3\r\n";
    while m.len() < BIG_BYTES {
        m.extend_from_slice(line);
    }
    m.extend_from_slice(b"--b--\r\n");
    m
}

/// A fresh folder with SMALL small messages (UIDs 1..=SMALL) and one big one (UID SMALL+1).
pub async fn prepare_folder(folder: &str) -> Result<()> {
    let mut raw = Raw::login().await?;
    let _ = raw.cmd(&format!("DELETE \"{folder}\"")).await;
    raw.cmd(&format!("CREATE \"{folder}\"")).await?;
    for i in 1..=SMALL {
        raw.append(folder, &small_message(i)).await?;
    }
    raw.append(folder, &big_message()).await?;
    raw.cmd("LOGOUT").await.ok();
    Ok(())
}

/// Out of band: flag UIDs 1..=FLAGGED, expunge the next EXPUNGED. Returns the expunged UIDs.
pub async fn change_out_of_band(folder: &str) -> Result<Vec<u32>> {
    let mut raw = Raw::login().await?;
    raw.cmd(&format!("SELECT \"{folder}\"")).await?;
    raw.cmd(&format!("UID STORE 1:{FLAGGED} +FLAGS.SILENT (\\Flagged)")).await?;
    let gone: Vec<u32> = (FLAGGED + 1..=FLAGGED + EXPUNGED).collect();
    let set = format!("{}:{}", gone[0], gone[gone.len() - 1]);
    raw.cmd(&format!("UID STORE {set} +FLAGS.SILENT (\\Deleted)")).await?;
    raw.cmd(&format!("UID EXPUNGE {set}")).await?;
    raw.cmd("LOGOUT").await.ok();
    Ok(gone)
}

/// Delivers one message to the inbox over SMTP submission, for IDLE.
pub async fn smtp_deliver(subject: &str) -> Result<()> {
    let dir = devmail_dir();
    let mut child = tokio::process::Command::new("curl")
        .env("SSL_CERT_FILE", dir.join("tls/trust-bundle.pem"))
        .args(["-sS", "--url", "smtps://localhost:1465", "--mail-from", USER, "--mail-rcpt", USER])
        .args(["--user", &format!("{USER}:{}", password()?), "--upload-file", "-"])
        .stdin(std::process::Stdio::piped())
        .spawn()?;
    let mut stdin = child.stdin.take().unwrap();
    stdin
        .write_all(
            format!("From: {USER}\r\nTo: {USER}\r\nSubject: {subject}\r\n\r\nIdle test.\r\n").as_bytes(),
        )
        .await?;
    drop(stdin);
    if !child.wait().await?.success() {
        bail!("curl could not deliver");
    }
    Ok(())
}

/// Resident memory of this process right now, in MB.
pub fn rss_mb() -> f64 {
    let status = std::fs::read_to_string("/proc/self/status").unwrap_or_default();
    status
        .lines()
        .find_map(|l| l.strip_prefix("VmRSS:"))
        .and_then(|v| v.trim().trim_end_matches(" kB").trim().parse::<f64>().ok())
        .map(|kb| kb / 1024.0)
        .unwrap_or(0.0)
}

/// What a fake server says. `{tag}` becomes the tag of the most recent tagged command.
pub enum Say {
    /// Sent on connect.
    Greeting(&'static str),
    /// Sent after the next line from the client.
    Reply(&'static str),
}

/// An in-memory IMAP server that follows a script, for responses the dev server cannot produce
/// (Gmail's X-GM-* items, Gmail's XOAUTH2 error challenge).
pub fn fake_server(script: Vec<Say>) -> DuplexStream {
    let (client, server) = tokio::io::duplex(64 * 1024);
    tokio::spawn(async move {
        let (r, mut w) = tokio::io::split(server);
        let mut r = BufReader::new(r);
        let mut tag = String::from("*");
        for say in script {
            match say {
                Say::Greeting(text) => {
                    let _ = w.write_all(text.as_bytes()).await;
                }
                Say::Reply(text) => {
                    let mut line = String::new();
                    if r.read_line(&mut line).await.unwrap_or(0) == 0 {
                        return;
                    }
                    let first = line.split_whitespace().next().unwrap_or("");
                    if line
                        .split_whitespace()
                        .nth(1)
                        .is_some_and(|w| w.chars().all(|c| c.is_ascii_alphabetic()))
                    {
                        tag = first.to_string();
                    }
                    let _ = w.write_all(text.replace("{tag}", &tag).as_bytes()).await;
                }
            }
        }
        // Keep the socket open so a client that waits forever shows up as a timeout, not EOF.
        let mut sink = Vec::new();
        let _ = r.read_to_end(&mut sink).await;
    });
    client
}

pub const GMAIL_FETCH: &str = "* 1 FETCH (X-GM-MSGID 1278455344230334865 X-GM-THRID 1278455344230334865 \
     X-GM-LABELS (\\Inbox \\Sent Important \"Muy Importante\") UID 4 FLAGS (\\Seen))\r\n{tag} OK Success\r\n";
/// Gmail's reply to a rejected XOAUTH2 token: a base64 JSON challenge the client must answer with an empty line.
pub const GMAIL_XOAUTH2_CHALLENGE: &str =
    "+ eyJzdGF0dXMiOiI0MDAiLCJzY2hlbWVzIjoiQmVhcmVyIiwic2NvcGUiOiJodHRwczovL21haWwuZ29vZ2xlLmNvbS8ifQ==\r\n";

pub struct Row {
    pub check: &'static str,
    pub ok: bool,
    pub ms: u128,
    pub note: String,
}

#[derive(Default)]
pub struct Report {
    pub rows: Vec<Row>,
}

impl Report {
    /// Runs one check with a 60 s limit; a hang is a failure, not a stuck probe.
    pub async fn check<F: Future<Output = Result<String>>>(&mut self, check: &'static str, f: F) {
        let start = Instant::now();
        let (ok, note) = match tokio::time::timeout(Duration::from_secs(60), f).await {
            Ok(Ok(note)) => (true, note),
            Ok(Err(e)) => (false, format!("{e:#}")),
            Err(_) => (false, "hung: no result within 60 s".into()),
        };
        let ms = start.elapsed().as_millis();
        println!("{} {check} ({ms} ms): {note}", if ok { "PASS" } else { "FAIL" });
        self.rows.push(Row { check, ok, ms, note });
    }

    pub fn print(&self, library: &str) {
        println!("\n| {library} | result | ms | notes |\n|---|---|---|---|");
        for r in &self.rows {
            println!("| {} | {} | {} | {} |", r.check, if r.ok { "pass" } else { "FAIL" }, r.ms, r.note);
        }
    }
}

/// Reads a whole stream, for fake-server checks.
pub async fn drain(mut s: impl tokio::io::AsyncRead + Unpin) -> Vec<u8> {
    let mut v = Vec::new();
    let _ = s.read_to_end(&mut v).await;
    v
}
