//! Sender logos, for people who turn them on (Settings → Reading). The icon a sender's own website declares,
//! fetched in the background and cached by the shell; never a third-party icon service, which would learn who
//! writes to whom. Off by default: a fetch tells that site someone read its mail.

use std::time::Duration;

use anyhow::Result;

/// Mail domains many people share: a logo there would be the provider's, not the sender's.
const SHARED: &[&str] = &[
    "gmail.com",
    "googlemail.com",
    "msn.com",
    "ymail.com",
    "icloud.com",
    "me.com",
    "mac.com",
    "aol.com",
    "proton.me",
    "protonmail.com",
    "pm.me",
    "web.de",
    "mail.ru",
    "fastmail.com",
    "fastmail.fm",
    "hey.com",
    "zoho.com",
    "tutanota.com",
    "tuta.io",
    "mail.com",
    "qq.com",
    "163.com",
    "126.com",
];
/// Providers with a domain per country (hotmail.co.uk, yahoo.de).
const SHARED_PREFIXES: &[&str] = &["hotmail.", "outlook.", "live.", "yahoo.", "gmx.", "yandex."];

/// Most read of a site's home page, looking for its icon links.
const PAGE_LIMIT: u64 = 512 * 1024;
/// Largest icon kept.
pub const ICON_LIMIT: u64 = 200 * 1024;

/// The site a sender writes from: the address's domain without mail subdomains ("news.example.com" →
/// "example.com", "shop.example.co.uk" → "example.co.uk"). None for shared mail providers and odd addresses.
pub fn site(addr: &str) -> Option<String> {
    let domain = addr.rsplit_once('@')?.1.trim().trim_end_matches('>').to_ascii_lowercase();
    if !domain.contains('.') || !domain.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-') {
        return None;
    }
    let labels: Vec<&str> = domain.split('.').filter(|l| !l.is_empty()).collect();
    if labels.len() < 2 {
        return None;
    }
    // Two labels, or three under a registry's second level (co.uk, com.au): a guess without the public suffix
    // list, right for the usual cases.
    let n = labels.len();
    let keep = if n >= 3 && labels[n - 1].len() == 2 && labels[n - 2].len() <= 3 { 3 } else { 2 };
    let site = labels[n - keep..].join(".");
    let shared = SHARED.contains(&site.as_str()) || SHARED_PREFIXES.iter().any(|p| site.starts_with(p));
    (!shared).then_some(site)
}

/// A picture, as fetched.
#[derive(Debug, PartialEq)]
pub struct Logo {
    pub mime: String,
    pub bytes: Vec<u8>,
}

/// The site's logo: an icon its home page declares (apple-touch-icon first, it is the large one), else the
/// usual places. HTTPS only. None when nothing that is a picture turns up.
pub fn fetch(site: &str) -> Result<Option<Logo>> {
    let agent = agent();
    let base = format!("https://{site}/");
    // A site that answered at all (even 404) has been asked; one that never answered is an error, so being
    // offline is not remembered as "no logo".
    let mut reached = false;
    let mut get = |url: &str, limit: u64| {
        let got = get(&agent, url, limit);
        reached |= matches!(got, Ok(_) | Err(ureq::Error::StatusCode(_)));
        got.ok()
    };
    let mut candidates = Vec::new();
    if let Some((mime, page)) = get(&base, PAGE_LIMIT) {
        if mime.contains("html") {
            candidates.extend(icon_links(&String::from_utf8_lossy(&page), &base));
        }
    }
    candidates.push(format!("{base}apple-touch-icon.png"));
    candidates.push(format!("{base}favicon.ico"));
    candidates.dedup();
    for url in candidates {
        if let Some((mime, bytes)) = get(&url, ICON_LIMIT) {
            if let Some(mime) = picture(&mime, &bytes) {
                return Ok(Some(Logo { mime: mime.to_string(), bytes }));
            }
        }
    }
    if !reached {
        anyhow::bail!("{site} did not answer");
    }
    Ok(None)
}

fn agent() -> ureq::Agent {
    let tls = ureq::tls::TlsConfig::builder().root_certs(ureq::tls::RootCerts::PlatformVerifier).build();
    ureq::Agent::config_builder()
        .tls_config(tls)
        .https_only(true)
        .max_redirects(4)
        .timeout_global(Some(Duration::from_secs(10)))
        .user_agent("Tern")
        .build()
        .into()
}

fn get(agent: &ureq::Agent, url: &str, limit: u64) -> Result<(String, Vec<u8>), ureq::Error> {
    let mut res = agent.get(url).call()?;
    let mime =
        res.headers().get("content-type").and_then(|v| v.to_str().ok()).unwrap_or("").to_ascii_lowercase();
    let bytes = res.body_mut().with_config().limit(limit).read_to_vec()?;
    Ok((mime, bytes))
}

/// The picture type of what came back, from its first bytes (servers often call an .ico text/plain), or None
/// when it is not a picture at all (an error page served with 200).
fn picture(mime: &str, bytes: &[u8]) -> Option<&'static str> {
    let head = &bytes[..bytes.len().min(256)];
    if head.starts_with(b"\x89PNG") {
        Some("image/png")
    } else if head.starts_with(&[0, 0, 1, 0]) {
        Some("image/x-icon")
    } else if head.starts_with(&[0xff, 0xd8, 0xff]) {
        Some("image/jpeg")
    } else if head.starts_with(b"GIF8") {
        Some("image/gif")
    } else if head.starts_with(b"RIFF") && head.get(8..12) == Some(b"WEBP") {
        Some("image/webp")
    } else if mime.starts_with("image/svg") || String::from_utf8_lossy(head).contains("<svg") {
        // Shown through <img>, where an SVG's scripts never run.
        Some("image/svg+xml")
    } else {
        None
    }
}

/// Icon links in a page, best first: apple-touch-icon, then icons by declared size. Only HTTPS, resolved
/// against `base` (`https://site/`).
fn icon_links(html: &str, base: &str) -> Vec<String> {
    let lower = html.to_ascii_lowercase();
    let mut found: Vec<(u32, String)> = Vec::new();
    let mut at = 0;
    while let Some(start) = lower[at..].find("<link") {
        let start = at + start;
        let end = lower[start..].find('>').map_or(lower.len(), |e| start + e);
        let tag = &html[start..end];
        let tag_lower = &lower[start..end];
        at = end;
        let rel = attr(tag_lower, "rel").unwrap_or_default();
        let rank = if rel.contains("apple-touch-icon") {
            1000
        } else if rel.split_whitespace().any(|r| r == "icon") {
            // "32x32" → 32; "any" (SVG) counts as large.
            match attr(tag_lower, "sizes").as_deref() {
                Some("any") => 500,
                Some(s) => s.split('x').next().and_then(|n| n.parse().ok()).unwrap_or(16),
                None => 16,
            }
        } else {
            continue;
        };
        let Some(href) = attr(tag, "href") else { continue };
        let href = href.replace("&amp;", "&");
        let url = if href.starts_with("https://") {
            href
        } else if let Some(rest) = href.strip_prefix("//") {
            format!("https://{rest}")
        } else if href.contains(':') {
            continue; // http:, data:, javascript: and the like
        } else {
            format!("{base}{}", href.trim_start_matches('/'))
        };
        found.push((rank, url));
    }
    found.sort_by_key(|(rank, _)| std::cmp::Reverse(*rank));
    found.into_iter().map(|(_, url)| url).collect()
}

/// An attribute's value in a tag, quoted or not.
fn attr(tag: &str, name: &str) -> Option<String> {
    let lower = tag.to_ascii_lowercase();
    let mut from = 0;
    while let Some(i) = lower[from..].find(name) {
        let i = from + i;
        from = i + name.len();
        // A whole attribute name: preceded by a space, followed by "=".
        if !lower[..i].ends_with(|c: char| c.is_ascii_whitespace()) {
            continue;
        }
        let rest = lower[from..].trim_start();
        let Some(rest) = rest.strip_prefix('=') else { continue };
        let offset = tag.len() - rest.len();
        let value = tag[offset..].trim_start();
        return Some(match value.chars().next() {
            Some(q @ ('"' | '\'')) => value[1..].split(q).next().unwrap_or("").to_string(),
            _ => value.split(|c: char| c.is_ascii_whitespace()).next().unwrap_or("").to_string(),
        });
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn site_drops_mail_subdomains_and_shared_providers() {
        assert_eq!(site("news@email.github.com").as_deref(), Some("github.com"));
        assert_eq!(site("Orders <orders@shop.example.co.uk>").as_deref(), Some("example.co.uk"));
        assert_eq!(site("a@example.io").as_deref(), Some("example.io"));
        assert_eq!(site("friend@gmail.com"), None);
        assert_eq!(site("friend@hotmail.co.uk"), None);
        assert_eq!(site("friend@yahoo.de"), None);
        assert_eq!(site("nobody"), None);
        assert_eq!(site("x@localhost"), None);
    }

    #[test]
    fn icon_links_rank_large_icons_first_and_keep_https() {
        let html = r#"<head>
            <link rel="icon" href="/favicon-16.png" sizes="16x16">
            <LINK REL="icon" sizes="192x192" href="/icons/big.png">
            <link rel=apple-touch-icon href=//cdn.example.com/touch.png>
            <link rel="stylesheet" href="/site.css">
            <link rel="icon" href="http://example.com/insecure.png" sizes="512x512">
        </head>"#;
        assert_eq!(
            icon_links(html, "https://example.com/"),
            vec![
                "https://cdn.example.com/touch.png".to_string(),
                "https://example.com/icons/big.png".to_string(),
                "https://example.com/favicon-16.png".to_string(),
            ]
        );
    }

    #[test]
    fn pictures_are_known_by_their_bytes() {
        assert_eq!(picture("text/plain", &[0, 0, 1, 0, 1]), Some("image/x-icon"));
        assert_eq!(picture("", b"\x89PNG\r\n"), Some("image/png"));
        assert_eq!(picture("image/svg+xml", b"<?xml version='1.0'?>"), Some("image/svg+xml"));
        assert_eq!(picture("text/html", b"<!doctype html><title>Not found</title>"), None);
    }

    /// Needs the network: `cargo test -p tern-core logo -- --ignored`.
    #[test]
    #[ignore]
    fn fetches_a_real_logo() {
        let logo = fetch("github.com").unwrap().expect("github.com has an icon");
        assert!(logo.mime.starts_with("image/") && !logo.bytes.is_empty());
    }
}
