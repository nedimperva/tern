//! `mailto:` links (RFC 6068), as a browser or another app hands them to Tern.

use serde::Serialize;

/// What a `mailto:` link fills in. Empty fields were not in the link.
#[derive(Debug, Default, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Mailto {
    pub to: Vec<String>,
    pub cc: Vec<String>,
    pub bcc: Vec<String>,
    pub subject: String,
    pub body: String,
}

/// `%xx` escapes as UTF-8. A stray `%` stays as it is; `+` is a plus here, not a space (RFC 6068 §5).
fn decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let hex = |b: u8| (b as char).to_digit(16);
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(h), Some(l)) = (hex(bytes[i + 1]), hex(bytes[i + 2])) {
                out.push((h * 16 + l) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Addresses separated by commas, each decoded and trimmed.
fn addresses(s: &str) -> Vec<String> {
    decode(s).split(',').map(str::trim).filter(|a| !a.is_empty()).map(String::from).collect()
}

/// Parses a `mailto:` link; None when it is not one.
pub fn parse(link: &str) -> Option<Mailto> {
    let rest = link.trim();
    let rest = rest.get(..7).filter(|p| p.eq_ignore_ascii_case("mailto:")).map(|_| &rest[7..])?;
    let (to, query) = rest.split_once('?').unwrap_or((rest, ""));
    let mut out = Mailto { to: addresses(to), ..Default::default() };
    for pair in query.split('&').filter(|p| !p.is_empty()) {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        match key.to_ascii_lowercase().as_str() {
            "to" => out.to.extend(addresses(value)),
            "cc" => out.cc.extend(addresses(value)),
            "bcc" => out.bcc.extend(addresses(value)),
            "subject" => out.subject = decode(value),
            // Line breaks arrive as %0D%0A; the editor wants plain newlines.
            "body" => out.body = decode(value).replace("\r\n", "\n"),
            _ => {}
        }
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fields_are_read_and_decoded() {
        let m = parse(
            "mailto:ada@example.com,bob@example.com?subject=Hi%20there&body=Line%201%0D%0ALine%202&cc=c@x.y",
        )
        .unwrap();
        assert_eq!(m.to, ["ada@example.com", "bob@example.com"]);
        assert_eq!(m.cc, ["c@x.y"]);
        assert_eq!(m.subject, "Hi there");
        assert_eq!(m.body, "Line 1\nLine 2");
    }

    #[test]
    fn odd_links_still_work() {
        assert_eq!(parse("MAILTO:a@b.c").unwrap().to, ["a@b.c"]);
        let m = parse("mailto:?to=a%40b.c&subject=%C3%A9t%C3%A9+50%").unwrap();
        assert_eq!((m.to[0].as_str(), m.subject.as_str()), ("a@b.c", "été+50%"));
        assert_eq!(parse("mailto:").unwrap(), Mailto::default());
        assert!(parse("https://example.com").is_none());
        assert!(parse("mail").is_none());
    }
}
