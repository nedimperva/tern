//! Signing in with OAuth, as a desktop app should (RFC 8252): the system browser, a one-time listener on
//! 127.0.0.1 for the redirect, and PKCE (RFC 7636) so a code caught on the way is no use to anyone else. Nothing
//! here is Gmail-specific; `Provider::google` has Google's endpoints. Tokens live in the keyring (`secrets`), never
//! in SQLite. See docs/research/gmail-oauth.md.

use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

/// Where to sign in, and as which app.
#[derive(Debug, Clone)]
pub struct Provider {
    pub auth_url: String,
    pub token_url: String,
    pub client_id: String,
    /// Google's desktop clients have one, which by Google's own account is not secret (an installed app can't keep
    /// one); PKCE is what protects the code.
    pub client_secret: Option<String>,
    pub scopes: Vec<String>,
}

impl Provider {
    pub fn google(client_id: &str, client_secret: Option<&str>, scopes: &[&str]) -> Self {
        Provider {
            auth_url: "https://accounts.google.com/o/oauth2/v2/auth".into(),
            token_url: "https://oauth2.googleapis.com/token".into(),
            client_id: client_id.into(),
            client_secret: client_secret.map(Into::into),
            scopes: scopes.iter().map(|s| s.to_string()).collect(),
        }
    }

    /// A Google desktop client from the JSON the Cloud console downloads (`{"installed": {...}}`).
    pub fn google_from_json(json: &str, scopes: &[&str]) -> Result<Self> {
        #[derive(Deserialize)]
        struct File {
            installed: Installed,
        }
        #[derive(Deserialize)]
        struct Installed {
            client_id: String,
            client_secret: Option<String>,
        }
        let file: File =
            serde_json::from_str(json).context("Not a Google desktop client file (no \"installed\")")?;
        Ok(Self::google(&file.installed.client_id, file.installed.client_secret.as_deref(), scopes))
    }
}

/// What Tern asks Google for: mail over IMAP and SMTP (the only scope XOAUTH2 accepts), and the address that
/// signed in.
pub const GOOGLE_MAIL_SCOPES: &[&str] = &["https://mail.google.com/", "openid", "email"];

/// What signing in gives: an access token for about an hour, and a refresh token for the next one.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Tokens {
    pub access_token: String,
    pub refresh_token: Option<String>,
    /// Unix seconds.
    pub expires_at: i64,
    /// The signed-in address, from the ID token, when the scopes asked for it.
    pub email: Option<String>,
}

impl Tokens {
    /// Still good for five minutes: refresh before a long request rather than halfway through it.
    pub fn fresh(&self, now: i64) -> bool {
        now + 300 < self.expires_at
    }
}

/// The provider no longer accepts the refresh token (revoked, expired, or the password changed): only signing in
/// again helps. Find it with `is_revoked`.
#[derive(Debug)]
pub struct Revoked(pub String);

impl std::fmt::Display for Revoked {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "The sign-in is no longer valid ({}); sign in again", self.0)
    }
}

impl std::error::Error for Revoked {}

pub fn is_revoked(e: &anyhow::Error) -> bool {
    e.downcast_ref::<Revoked>().is_some()
}

/// A PKCE pair: the verifier stays here, the challenge goes in the browser's URL.
pub struct Pkce {
    pub verifier: String,
    pub challenge: String,
}

/// 32 random bytes, URL-safe: a PKCE verifier (43 characters) or a `state`.
pub fn random_token() -> Result<String> {
    use ring::rand::SecureRandom;
    let mut bytes = [0u8; 32];
    ring::rand::SystemRandom::new()
        .fill(&mut bytes)
        .map_err(|_| anyhow!("No random numbers from the system"))?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

pub fn pkce() -> Result<Pkce> {
    let verifier = random_token()?;
    Ok(Pkce { challenge: challenge_for(&verifier), verifier })
}

/// S256: base64url(SHA-256(verifier)).
fn challenge_for(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(ring::digest::digest(&ring::digest::SHA256, verifier.as_bytes()))
}

/// The page the browser opens.
pub fn authorize_url(
    p: &Provider,
    redirect_uri: &str,
    state: &str,
    challenge: &str,
    login_hint: Option<&str>,
) -> String {
    let mut url = url::Url::parse(&p.auth_url).expect("provider URLs are valid");
    {
        let mut q = url.query_pairs_mut();
        q.append_pair("client_id", &p.client_id)
            .append_pair("redirect_uri", redirect_uri)
            .append_pair("response_type", "code")
            .append_pair("scope", &p.scopes.join(" "))
            .append_pair("code_challenge", challenge)
            .append_pair("code_challenge_method", "S256")
            .append_pair("state", state)
            // A refresh token, and asked for again on each consent so a second sign-in still gets one.
            .append_pair("access_type", "offline")
            .append_pair("prompt", "consent");
        if let Some(hint) = login_hint {
            q.append_pair("login_hint", hint);
        }
    }
    url.into()
}

/// The one-time listener the browser is sent back to.
pub struct Callback {
    listener: TcpListener,
    pub redirect_uri: String,
}

impl Callback {
    /// Google wants the IP literal, not `localhost`; the port is whatever is free.
    pub async fn bind() -> Result<Self> {
        let listener = TcpListener::bind("127.0.0.1:0").await.context("Could not listen for the sign-in")?;
        let port = listener.local_addr()?.port();
        Ok(Callback { listener, redirect_uri: format!("http://127.0.0.1:{port}") })
    }

    /// Waits for the redirect and returns its code. Other requests (a favicon) get a 404 and the wait goes on.
    pub async fn wait(self, state: &str, limit: Duration) -> Result<String> {
        tokio::time::timeout(limit, async {
            loop {
                let (mut socket, _) = self.listener.accept().await?;
                let mut buf = vec![0u8; 8192];
                let n = socket.read(&mut buf).await?;
                let request = String::from_utf8_lossy(&buf[..n]);
                let target = request.lines().next().and_then(|l| l.split(' ').nth(1)).unwrap_or("");
                let Ok(url) = url::Url::parse(&format!("http://127.0.0.1{target}")) else { continue };
                let get = |key: &str| url.query_pairs().find(|(k, _)| k == key).map(|(_, v)| v.into_owned());
                let (code, error) = (get("code"), get("error"));
                if url.path() != "/" || (code.is_none() && error.is_none()) {
                    let _ = socket.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n").await;
                    continue;
                }
                let outcome = match (code, error) {
                    _ if get("state").as_deref() != Some(state) => {
                        Err(anyhow!("The sign-in answer was not for this request"))
                    }
                    (_, Some(e)) if e == "access_denied" => {
                        Err(anyhow!("Sign-in was cancelled in the browser"))
                    }
                    (_, Some(e)) => Err(anyhow!("The provider refused the sign-in: {e}")),
                    (Some(code), None) => Ok(code),
                    (None, None) => unreachable!("checked above"),
                };
                let page = if outcome.is_ok() {
                    "Signed in. You can close this tab and go back to Tern."
                } else {
                    "Tern could not sign in. Close this tab and try again in Tern."
                };
                let body = format!(
                    "<!doctype html><meta charset=utf-8><title>Tern</title>\
                     <body style=\"font:16px system-ui;margin:3em\">{page}</body>"
                );
                let reply = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\n\
                     Connection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = socket.write_all(reply.as_bytes()).await;
                return outcome;
            }
        })
        .await
        .map_err(|_| anyhow!("The browser didn't come back within {} minutes", limit.as_secs() / 60))?
    }
}

/// The whole sign-in: listen, open the browser with `open`, wait up to `limit`, trade the code for tokens.
pub async fn sign_in(
    p: &Provider,
    login_hint: Option<&str>,
    open: impl FnOnce(&str) -> Result<()>,
    limit: Duration,
) -> Result<Tokens> {
    let callback = Callback::bind().await?;
    let redirect_uri = callback.redirect_uri.clone();
    let (pkce, state) = (pkce()?, random_token()?);
    open(&authorize_url(p, &redirect_uri, &state, &pkce.challenge, login_hint))?;
    let code = callback.wait(&state, limit).await?;
    let p = p.clone();
    tokio::task::spawn_blocking(move || exchange(&p, &code, &pkce.verifier, &redirect_uri)).await?
}

/// Trades the browser's code (and the PKCE verifier) for tokens. Blocking: one HTTPS request.
pub fn exchange(p: &Provider, code: &str, verifier: &str, redirect_uri: &str) -> Result<Tokens> {
    token_request(
        p,
        &[
            ("grant_type", "authorization_code"),
            ("code", code),
            ("code_verifier", verifier),
            ("redirect_uri", redirect_uri),
        ],
        None,
    )
}

/// A new access token. A provider may send a new refresh token too; if not, the old one stays. Blocking.
pub fn refresh(p: &Provider, refresh_token: &str) -> Result<Tokens> {
    token_request(
        p,
        &[("grant_type", "refresh_token"), ("refresh_token", refresh_token)],
        Some(refresh_token),
    )
}

fn token_request(p: &Provider, form: &[(&str, &str)], kept_refresh: Option<&str>) -> Result<Tokens> {
    #[derive(Deserialize)]
    struct Answer {
        access_token: Option<String>,
        expires_in: Option<i64>,
        refresh_token: Option<String>,
        id_token: Option<String>,
        error: Option<String>,
        error_description: Option<String>,
    }
    let mut fields: Vec<(&str, &str)> = vec![("client_id", &p.client_id)];
    if let Some(secret) = &p.client_secret {
        fields.push(("client_secret", secret));
    }
    fields.extend_from_slice(form);
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .http_status_as_error(false)
        .timeout_global(Some(Duration::from_secs(30)))
        .tls_config(
            ureq::tls::TlsConfig::builder().root_certs(ureq::tls::RootCerts::PlatformVerifier).build(),
        )
        .build()
        .into();
    let mut response = agent
        .post(&p.token_url)
        .send_form(fields)
        .with_context(|| format!("Could not reach {}", p.token_url))?;
    let status = response.status();
    let text = response.body_mut().read_to_string().context("The sign-in server's answer was cut off")?;
    let answer: Answer =
        serde_json::from_str(&text).context("The sign-in server's answer was not readable")?;
    if let Some(error) = answer.error {
        // invalid_grant: the refresh token (or code) is no good any more, which no retry fixes.
        if error == "invalid_grant" {
            return Err(Revoked(answer.error_description.unwrap_or(error)).into());
        }
        bail!("The sign-in server refused ({status}): {}", answer.error_description.unwrap_or(error));
    }
    let access_token = answer.access_token.context("The sign-in server sent no access token")?;
    Ok(Tokens {
        access_token,
        refresh_token: answer.refresh_token.or(kept_refresh.map(Into::into)),
        expires_at: crate::store::now() + answer.expires_in.unwrap_or(3600),
        email: answer.id_token.as_deref().and_then(id_token_email),
    })
}

/// The `email` claim of an ID token. Not verified: the token came straight from the provider over TLS, in answer
/// to this app's own request, which is what OpenID Connect allows for the code flow.
fn id_token_email(token: &str) -> Option<String> {
    let payload = URL_SAFE_NO_PAD.decode(token.split('.').nth(1)?.trim_end_matches('=')).ok()?;
    let claims: serde_json::Value = serde_json::from_slice(&payload).ok()?;
    claims.get("email")?.as_str().map(Into::into)
}

#[cfg(test)]
mod tests {
    use std::io::{BufRead, BufReader, Read, Write};
    use std::time::Duration;

    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    use super::*;

    #[test]
    fn pkce_matches_the_rfc_example() {
        // RFC 7636, appendix B.
        assert_eq!(
            challenge_for("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
        let p = pkce().unwrap();
        assert_eq!(p.verifier.len(), 43);
        assert!(p.verifier.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
        assert_ne!(pkce().unwrap().verifier, p.verifier);
    }

    #[test]
    fn the_browser_url_carries_the_request() {
        let p = Provider::google("id.apps.googleusercontent.com", Some("s"), &["openid", "email"]);
        let url =
            url::Url::parse(&authorize_url(&p, "http://127.0.0.1:5555", "st", "ch", Some("a@b.c"))).unwrap();
        let q: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
        assert_eq!(q["redirect_uri"], "http://127.0.0.1:5555");
        assert_eq!(q["scope"], "openid email");
        assert_eq!((q["code_challenge"].as_str(), q["code_challenge_method"].as_str()), ("ch", "S256"));
        assert_eq!((q["state"].as_str(), q["login_hint"].as_str()), ("st", "a@b.c"));
        assert!(!q.contains_key("client_secret"), "the secret never goes through the browser");
    }

    #[test]
    fn reads_a_google_client_file() {
        let json = r#"{"installed":{"client_id":"x.apps.googleusercontent.com","client_secret":"GOCSPX-y",
                       "auth_uri":"https://accounts.google.com/o/oauth2/auth"}}"#;
        let p = Provider::google_from_json(json, &["openid"]).unwrap();
        assert_eq!(
            (p.client_id.as_str(), p.client_secret.as_deref()),
            ("x.apps.googleusercontent.com", Some("GOCSPX-y"))
        );
        assert!(Provider::google_from_json(r#"{"web":{}}"#, &[]).is_err());
    }

    /// What a browser sends after consent, to the listener at `redirect`.
    async fn browse(redirect: &str, path: &str) -> String {
        let addr = redirect.trim_start_matches("http://");
        let mut s = tokio::net::TcpStream::connect(addr).await.unwrap();
        s.write_all(format!("GET {path} HTTP/1.1\r\nHost: {addr}\r\n\r\n").as_bytes()).await.unwrap();
        let mut page = String::new();
        let _ = s.read_to_string(&mut page).await;
        page
    }

    #[tokio::test]
    async fn the_listener_takes_the_code_for_its_own_state() {
        let cb = Callback::bind().await.unwrap();
        let redirect = cb.redirect_uri.clone();
        assert!(redirect.starts_with("http://127.0.0.1:"));
        let wait = tokio::spawn(async move { cb.wait("s1", Duration::from_secs(5)).await });
        assert!(browse(&redirect, "/favicon.ico").await.starts_with("HTTP/1.1 404"));
        let page = browse(&redirect, "/?code=abc&state=s1&scope=x").await;
        assert!(page.contains("Signed in"));
        assert_eq!(wait.await.unwrap().unwrap(), "abc");

        let cb = Callback::bind().await.unwrap();
        let redirect = cb.redirect_uri.clone();
        let wait = tokio::spawn(async move { cb.wait("mine", Duration::from_secs(5)).await });
        browse(&redirect, "/?code=abc&state=theirs").await;
        assert!(wait.await.unwrap().is_err(), "another request's answer is refused");

        let cb = Callback::bind().await.unwrap();
        let redirect = cb.redirect_uri.clone();
        let wait = tokio::spawn(async move { cb.wait("s", Duration::from_secs(5)).await });
        browse(&redirect, "/?error=access_denied&state=s").await;
        let e = wait.await.unwrap().unwrap_err();
        assert!(e.to_string().contains("cancelled"), "{e}");

        let cb = Callback::bind().await.unwrap();
        let e = cb.wait("s", Duration::from_millis(50)).await.unwrap_err();
        assert!(e.to_string().contains("didn't come back"), "{e}");
    }

    /// A token endpoint on 127.0.0.1 that answers one request with `status` and `body`; returns its URL and the
    /// form it was sent.
    fn token_server(status: u16, body: &'static str) -> (String, std::thread::JoinHandle<String>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/token", listener.local_addr().unwrap());
        let handle = std::thread::spawn(move || {
            let (mut s, _) = listener.accept().unwrap();
            let mut reader = BufReader::new(s.try_clone().unwrap());
            let mut length = 0;
            loop {
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                if let Some(n) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                    length = n.trim().parse().unwrap();
                }
                if line == "\r\n" {
                    break;
                }
            }
            let mut form = vec![0u8; length];
            reader.read_exact(&mut form).unwrap();
            write!(
                s,
                "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
                body.len()
            )
            .unwrap();
            String::from_utf8(form).unwrap()
        });
        (url, handle)
    }

    fn provider(token_url: String) -> Provider {
        Provider { token_url, ..Provider::google("cid", Some("csecret"), &["openid"]) }
    }

    #[test]
    fn a_code_becomes_tokens_with_the_email() {
        // {"email":"ada@gmail.com"} as an unsigned JWT payload.
        let id_token = "e30.eyJlbWFpbCI6ImFkYUBnbWFpbC5jb20ifQ.x";
        let body: &'static str = Box::leak(
            format!(
                r#"{{"access_token":"at","expires_in":3599,"refresh_token":"rt","id_token":"{id_token}"}}"#
            )
            .into_boxed_str(),
        );
        let (url, sent) = token_server(200, body);
        let t = exchange(&provider(url), "the-code", "the-verifier", "http://127.0.0.1:9").unwrap();
        assert_eq!((t.access_token.as_str(), t.refresh_token.as_deref()), ("at", Some("rt")));
        assert_eq!(t.email.as_deref(), Some("ada@gmail.com"));
        assert!(t.fresh(crate::store::now()) && !t.fresh(t.expires_at));
        let form = sent.join().unwrap();
        for part in [
            "grant_type=authorization_code",
            "code=the-code",
            "code_verifier=the-verifier",
            "client_secret=csecret",
        ] {
            assert!(form.contains(part), "{form}");
        }
    }

    #[test]
    fn a_refresh_keeps_the_refresh_token_and_a_revoked_one_says_so() {
        let (url, sent) = token_server(200, r#"{"access_token":"new","expires_in":3600}"#);
        let t = refresh(&provider(url), "rt").unwrap();
        assert_eq!((t.access_token.as_str(), t.refresh_token.as_deref()), ("new", Some("rt")));
        assert!(sent.join().unwrap().contains("grant_type=refresh_token"));

        let (url, _) = token_server(
            400,
            r#"{"error":"invalid_grant","error_description":"Token has been expired or revoked."}"#,
        );
        let e = refresh(&provider(url), "rt").unwrap_err();
        assert!(is_revoked(&e), "{e}");

        let (url, _) = token_server(400, r#"{"error":"invalid_client"}"#);
        let e = refresh(&provider(url), "rt").unwrap_err();
        assert!(!is_revoked(&e) && e.to_string().contains("invalid_client"), "{e}");
    }
}
