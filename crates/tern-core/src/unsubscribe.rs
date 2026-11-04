//! One-click unsubscribe (RFC 8058): with `List-Unsubscribe-Post: List-Unsubscribe=One-Click` and an https link in
//! List-Unsubscribe, a POST of exactly `List-Unsubscribe=One-Click` to that link ends the subscription. It runs from
//! the outbox, after the undo window, like any other change; nothing is sent from the UI command itself.

use std::time::Duration;

use anyhow::{Context, Result};

/// The body RFC 8058 asks for, and the value its header must carry.
const ONE_CLICK: &str = "List-Unsubscribe=One-Click";

/// Whether a List-Unsubscribe-Post header offers one-click unsubscribe.
pub fn offers_one_click(post: &str) -> bool {
    post.split_whitespace().collect::<String>().eq_ignore_ascii_case(ONE_CLICK)
}

/// The https link to POST to, from a raw List-Unsubscribe header (`<mailto:…>, <https://…>`). Plain http is never
/// used: the request would go out in the clear.
pub fn one_click_url(list_unsubscribe: &str) -> Option<String> {
    list_unsubscribe
        .split('<')
        .filter_map(|part| part.split_once('>').map(|(link, _)| link.trim()))
        .find(|link| link.len() > 8 && link[..8].eq_ignore_ascii_case("https://"))
        .map(str::to_string)
}

/// The list's server said no (a 4xx): trying again cannot change it.
#[derive(Debug)]
pub struct Refused(pub u16);

impl std::fmt::Display for Refused {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "The list's server refused to unsubscribe (HTTP {})", self.0)
    }
}

impl std::error::Error for Refused {}

/// Sends the one-click POST. Blocking: call it from `spawn_blocking`.
pub fn post(url: &str) -> Result<()> {
    let tls = ureq::tls::TlsConfig::builder().root_certs(ureq::tls::RootCerts::PlatformVerifier).build();
    post_with(&agent().tls_config(tls).https_only(true).build().into(), url)
}

/// No cookies (the agent keeps none between requests), no Referer, and no redirects: a redirect would turn the POST
/// into a GET of some page, which is not what the list asked for.
fn agent() -> ureq::config::ConfigBuilder<ureq::typestate::AgentScope> {
    ureq::Agent::config_builder()
        .http_status_as_error(false)
        .max_redirects(0)
        .timeout_global(Some(Duration::from_secs(30)))
        .user_agent("Tern")
}

fn post_with(agent: &ureq::Agent, url: &str) -> Result<()> {
    let response = agent
        .post(url)
        .header("Content-Type", "application/x-www-form-urlencoded")
        .send(ONE_CLICK)
        .context("Could not reach the list's server")?;
    match response.status().as_u16() {
        // A redirect answers the POST too: the list took it and points at a page about it.
        200..=399 => Ok(()),
        code @ 400..=499 => Err(Refused(code).into()),
        code => anyhow::bail!("The list's server had a problem (HTTP {code})"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    #[test]
    fn reads_the_headers() {
        assert!(offers_one_click("List-Unsubscribe=One-Click"));
        assert!(offers_one_click(" list-unsubscribe = one-click "));
        assert!(!offers_one_click("List-Unsubscribe=Later"));
        let both = "<mailto:leave@list.example?subject=stop>, <https://list.example/u/123>";
        assert_eq!(one_click_url(both).as_deref(), Some("https://list.example/u/123"));
        assert_eq!(one_click_url("<mailto:leave@list.example>"), None, "mailto only");
        assert_eq!(one_click_url("<http://list.example/u>"), None, "never in the clear");
        assert_eq!(one_click_url("<HTTPS://List.example/u>").as_deref(), Some("HTTPS://List.example/u"));
        assert_eq!(one_click_url(""), None);
    }

    /// One request to a local server, which answers `status`; returns what it was sent.
    fn exchange(status: &str) -> (Result<()>, String) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/u/123", listener.local_addr().unwrap());
        let reply = format!("HTTP/1.1 {status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        let server = std::thread::spawn(move || {
            let (mut s, _) = listener.accept().unwrap();
            let mut got = Vec::new();
            let mut buf = [0; 4096];
            // Headers, then the body Content-Length says.
            loop {
                let n = s.read(&mut buf).unwrap();
                got.extend_from_slice(&buf[..n]);
                let text = String::from_utf8_lossy(&got);
                if let Some(end) = text.find("\r\n\r\n") {
                    let len = text
                        .lines()
                        .find_map(|l| {
                            l.to_ascii_lowercase()
                                .strip_prefix("content-length:")
                                .map(|v| v.trim().to_string())
                        })
                        .and_then(|v| v.parse::<usize>().ok())
                        .unwrap_or(0);
                    if got.len() >= end + 4 + len {
                        break;
                    }
                }
                if n == 0 {
                    break;
                }
            }
            s.write_all(reply.as_bytes()).unwrap();
            String::from_utf8(got).unwrap()
        });
        let result = post_with(&agent().build().into(), &url);
        (result, server.join().unwrap())
    }

    #[test]
    fn posts_exactly_the_one_click_body() {
        let (result, sent) = exchange("200 OK");
        result.unwrap();
        assert!(sent.starts_with("POST /u/123 HTTP/1.1\r\n"), "{sent}");
        assert!(sent.ends_with("\r\n\r\nList-Unsubscribe=One-Click"), "{sent}");
        let lower = sent.to_ascii_lowercase();
        assert!(lower.contains("content-type: application/x-www-form-urlencoded"));
        assert!(!lower.contains("cookie:") && !lower.contains("referer:"));
    }

    #[test]
    fn a_refusal_is_permanent_and_a_server_error_is_not() {
        let (result, _) = exchange("404 Not Found");
        assert!(result.unwrap_err().is::<Refused>());
        let (result, _) = exchange("503 Service Unavailable");
        assert!(!result.unwrap_err().is::<Refused>());
        exchange("302 Found").0.unwrap();
    }
}
