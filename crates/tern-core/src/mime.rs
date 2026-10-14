use mail_parser::{HeaderValue, MessageParser, MimeHeaders, PartType};

use crate::models::{NewMessage, Part};

/// Parses one raw RFC 5322 message. None when it is not mail at all.
pub fn parse(uid: u32, raw: &[u8], seen: bool, flagged: bool) -> Option<NewMessage> {
    let msg = MessageParser::default().parse(raw)?;

    let (from_name, from_addr) = msg
        .from()
        .and_then(|a| a.first())
        .map(|a| (a.name().unwrap_or_default().to_string(), a.address().unwrap_or_default().to_string()))
        .unwrap_or_default();
    let addrs = |list: Option<&mail_parser::Address>| {
        list.map(|list| list.iter().filter_map(|a| a.address()).collect::<Vec<_>>().join(", "))
            .unwrap_or_default()
    };
    let to_addrs = addrs(msg.to());

    let body_text = msg.body_text(0).map(|t| t.into_owned());
    // mail-parser turns a text-only message into HTML; keep that as plain text so the reader can theme it.
    let body_html = match msg.html_part(0).map(|p| &p.body) {
        Some(PartType::Html(html)) => Some(sanitize_html(html)),
        _ => None,
    };

    Some(NewMessage {
        uid,
        message_id: msg.message_id().map(str::to_string),
        in_reply_to: ids(msg.in_reply_to()).into_iter().next(),
        references: ids(msg.references()),
        subject: msg.subject().unwrap_or_default().to_string(),
        from_name,
        from_addr,
        to_addrs,
        date: msg.date().map(|d| d.to_timestamp()).unwrap_or(0),
        snippet: body_text.as_deref().map(snippet).unwrap_or_default(),
        seen,
        flagged,
        has_attachments: msg.attachment_count() > 0,
        body_text,
        body_html,
        size: None,
        headers_only: false,
        list_id: raw_header(&msg, "List-Id"),
        list_unsubscribe: raw_header(&msg, "List-Unsubscribe"),
        cc_addrs: addrs(msg.cc()),
        reply_to: addrs(msg.reply_to()),
        followup_to: msg.header_raw("Mail-Followup-To").map(raw_addresses).unwrap_or_default(),
        parts: Some(attachments(&msg)),
    })
}

/// The attached files of a raw message: (name, type, contents). For forwarding them.
pub fn attachment_files(raw: &[u8]) -> Vec<(String, String, Vec<u8>)> {
    let Some(msg) = MessageParser::default().parse(raw) else { return Vec::new() };
    msg.attachments()
        .map(|a| {
            let mime = a
                .content_type()
                .map(|t| format!("{}/{}", t.ctype(), t.subtype().unwrap_or("octet-stream")).to_lowercase())
                .unwrap_or_else(|| "application/octet-stream".into());
            (a.attachment_name().unwrap_or("Untitled").to_string(), mime, a.contents().to_vec())
        })
        .collect()
}

/// The attachments of a parsed message, as parts. They have no IMAP section number (the body is already here).
fn attachments(msg: &mail_parser::Message) -> Vec<Part> {
    msg.attachments()
        .map(|a| {
            let mime = a
                .content_type()
                .map(|t| format!("{}/{}", t.ctype(), t.subtype().unwrap_or("octet-stream")).to_lowercase())
                .unwrap_or_else(|| "application/octet-stream".into());
            Part {
                section: String::new(),
                charset: None,
                encoding: String::new(),
                size: a.len() as u32,
                name: Some(a.attachment_name().unwrap_or("Untitled").to_string()),
                mime,
                attachment: true,
            }
        })
        .collect()
}

/// Mail HTML made safe to keep: no scripts, event handlers, forms, frames, objects or `javascript:` links, while
/// the layout survives (inline `style`, `<style>` blocks, tables and their old attributes, `class`). It still renders
/// only in a sandboxed frame without scripts and with a CSP that blocks remote loads; this is a second wall.
pub fn sanitize_html(html: &str) -> String {
    use std::sync::OnceLock;
    static CLEANER: OnceLock<ammonia::Builder<'static>> = OnceLock::new();
    CLEANER
        .get_or_init(|| {
            let mut b = ammonia::Builder::default();
            b.add_tags(["style", "font", "center", "body", "html", "head", "meta"])
                .rm_clean_content_tags(["style"])
                .add_generic_attributes([
                    "style",
                    "class",
                    "id",
                    "align",
                    "valign",
                    "bgcolor",
                    "background",
                    "width",
                    "height",
                    "border",
                    "cellpadding",
                    "cellspacing",
                    "color",
                    "face",
                    "size",
                    "dir",
                    "lang",
                ])
                .add_url_schemes(["cid", "data"])
                .link_rel(Some("noopener noreferrer"));
            b
        })
        .clean(html)
        .to_string()
}

/// The addresses in a raw address-list header ("A <a@x>, b@y"), comma-separated, without names. For headers
/// mail-parser does not parse as addresses (Mail-Followup-To).
fn raw_addresses(raw: &str) -> String {
    raw.split(',')
        .filter_map(|part| {
            let part = part.trim();
            let addr = match (part.rfind('<'), part.rfind('>')) {
                (Some(open), Some(close)) if open < close => &part[open + 1..close],
                _ => part,
            };
            addr.contains('@').then(|| addr.trim().to_string())
        })
        .collect::<Vec<_>>()
        .join(", ")
}

/// A header's raw value on one line, for the fields mail-parser does not model (List-*).
fn raw_header(msg: &mail_parser::Message, name: &str) -> Option<String> {
    let value = msg.header_raw(name)?;
    let one_line = value.split_whitespace().collect::<Vec<_>>().join(" ");
    (!one_line.is_empty()).then_some(one_line)
}

/// Parses just the header block of a message (from a HEADER.FIELDS fetch): enough for the list, no body yet.
pub fn parse_headers(
    uid: u32,
    header: &[u8],
    seen: bool,
    flagged: bool,
    size: Option<u32>,
    parts: Option<Vec<Part>>,
) -> Option<NewMessage> {
    let mut m = parse(uid, header, seen, flagged)?;
    m.snippet.clear();
    m.body_text = None;
    m.body_html = None;
    // BODYSTRUCTURE says whether there are attachments before the body comes.
    m.has_attachments = parts.as_ref().is_some_and(|p| p.iter().any(|p| p.attachment));
    m.parts = parts;
    m.size = size;
    m.headers_only = true;
    Some(m)
}

/// A snippet from the first bytes of a text part (fetched alone, so without its MIME headers): decoded per the
/// part's transfer encoding and charset, HTML turned into text. The cut may fall mid-character or mid-word; the
/// decoders tolerate it and the snippet is cut shorter anyway.
pub fn part_snippet(part: &Part, start: &[u8]) -> String {
    let charset = part.charset.as_deref().unwrap_or("us-ascii").replace('"', "");
    let mut raw = format!(
        "Content-Type: {}; charset=\"{charset}\"\r\nContent-Transfer-Encoding: {}\r\n\r\n",
        part.mime, part.encoding
    )
    .into_bytes();
    raw.extend_from_slice(start);
    MessageParser::default()
        .parse(&raw[..])
        .and_then(|m| m.body_text(0).map(|t| snippet(&t)))
        .unwrap_or_default()
}

fn ids(value: &HeaderValue) -> Vec<String> {
    match value {
        HeaderValue::Text(id) => vec![id.to_string()],
        HeaderValue::TextList(list) => list.iter().map(|id| id.to_string()).collect(),
        _ => Vec::new(),
    }
}

/// The first words of the body, without quoted replies, on one line.
pub fn snippet(text: &str) -> String {
    let mut out = String::new();
    for line in text.lines().filter(|l| !l.trim_start().starts_with('>')) {
        for word in line.split_whitespace() {
            if out.len() >= 160 {
                return out;
            }
            if !out.is_empty() {
                out.push(' ');
            }
            out.push_str(word);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_headers_and_body() {
        let raw = b"From: Ada <ada@example.com>\r\nTo: bob@example.com\r\nSubject: Hello\r\n\
Message-ID: <b@example.com>\r\nIn-Reply-To: <a@example.com>\r\nReferences: <a@example.com>\r\n\
Date: Mon, 12 Oct 2026 10:00:00 +0000\r\n\r\nHi Bob,\r\n> quoted\r\nsee you.\r\n";
        let m = parse(7, raw, true, false).unwrap();
        assert_eq!(m.subject, "Hello");
        assert_eq!(m.from_name, "Ada");
        assert_eq!(m.from_addr, "ada@example.com");
        assert_eq!(m.message_id.as_deref(), Some("b@example.com"));
        assert_eq!(m.in_reply_to.as_deref(), Some("a@example.com"));
        assert_eq!(m.references, vec!["a@example.com".to_string()]);
        assert_eq!(m.snippet, "Hi Bob, see you.");
        assert!(m.date > 0);
        assert!(m.body_html.is_none(), "plain text stays plain");
    }

    #[test]
    fn decodes_headers_and_finds_attachments() {
        let raw = b"From: =?UTF-8?Q?Ned=C5=BEad?= <n@example.ba>\r\nTo: a@example.com, B <b@example.com>\r\n\
Subject: =?UTF-8?B?xI1lxaFuamk=?=\r\nDate: Mon, 12 Oct 2026 10:00:00 +0200\r\nMIME-Version: 1.0\r\n\
Content-Type: multipart/mixed; boundary=\"b1\"\r\n\r\n\
--b1\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>Only <b>HTML</b> here</p>\r\n\
--b1\r\nContent-Type: application/pdf; name=\"r.pdf\"\r\nContent-Disposition: attachment; filename=\"r.pdf\"\r\n\
Content-Transfer-Encoding: base64\r\n\r\nJVBERi0xLjQK\r\n--b1--\r\n";
        let m = parse(1, raw, false, true).unwrap();
        assert_eq!(m.from_name, "Nedžad");
        assert_eq!(m.subject, "češnji");
        assert_eq!(m.to_addrs, "a@example.com, b@example.com");
        assert!(m.has_attachments);
        assert!(m.body_html.as_deref().unwrap().contains("<b>HTML</b>"));
        // mail-parser derives a text body from HTML-only mail, so the list still gets a snippet.
        assert_eq!(m.snippet, "Only HTML here");
        assert_eq!(m.date, 1_791_792_000);
    }

    #[test]
    fn parses_a_header_block_alone() {
        let header = b"From: Ada <ada@example.com>\r\nSubject: Hello\r\nMessage-ID: <b@example.com>\r\n\
Date: Mon, 12 Oct 2026 10:00:00 +0000\r\n\r\n";
        let m = parse_headers(9, header, false, true, Some(4321), None).unwrap();
        assert_eq!((m.uid, m.subject.as_str(), m.from_addr.as_str()), (9, "Hello", "ada@example.com"));
        assert_eq!((m.size, m.headers_only, m.flagged), (Some(4321), true, true));
        assert!(m.body_text.is_none() && m.snippet.is_empty());
        assert!(m.date > 0);
    }

    fn part(mime: &str, encoding: &str, charset: &str) -> Part {
        Part {
            section: "1".into(),
            mime: mime.into(),
            encoding: encoding.into(),
            charset: Some(charset.into()),
            size: 0,
            name: None,
            attachment: false,
        }
    }

    #[test]
    fn snippets_from_the_start_of_a_part() {
        let qp = part("text/plain", "quoted-printable", "utf-8");
        assert_eq!(
            part_snippet(&qp, b"Zdravo, =C4=8Dovje=C5=BEe!\r\n> old\r\nNovo."),
            "Zdravo, čovježe! Novo."
        );

        // Cut mid-line in base64, as a 2 KB partial fetch would.
        let b64 = part("text/plain", "base64", "utf-8");
        assert!(part_snippet(&b64, b"SGVsbG8gdGhlcmUsIGhvdyBhcmUgeW91IGRvaW5nIHRvZGF5Pw0K\r\nU2Vl")
            .starts_with("Hello there"));

        let html = part("text/html", "7bit", "us-ascii");
        assert_eq!(
            part_snippet(&html, b"<html><body><p>Meeting <b>moved</b> to 3pm</p><p>See"),
            "Meeting moved to 3pm See"
        );
    }

    #[test]
    fn reply_headers_are_kept() {
        let raw = b"From: Ada <ada@x.com>\r\nTo: me@example.com\r\nCc: Bob <bob@x.com>, carl@x.com\r\n\
Reply-To: list@x.com\r\nMail-Followup-To: Team <team@x.com>, dan@x.com\r\nSubject: s\r\n\r\nbody\r\n";
        let m = parse(1, raw, false, false).unwrap();
        assert_eq!(m.cc_addrs, "bob@x.com, carl@x.com");
        assert_eq!(m.reply_to, "list@x.com");
        assert_eq!(m.followup_to, "team@x.com, dan@x.com");
    }

    #[test]
    fn html_keeps_its_looks_and_loses_its_teeth() {
        let dirty = r##"<html><head><style>p > b { color: red }</style></head><body>
            <script>alert(1)</script><p style="color:blue" onclick="steal()">Hi <b>there</b></p>
            <a href="javascript:steal()">x</a><a href="https://example.com">y</a>
            <form action="https://evil.example"><input name="pw"></form><iframe src="https://evil.example"></iframe>
            <table width="600" bgcolor="#fff"><tr><td align="center">t</td></tr></table><img src="cid:logo"></body></html>"##;
        let clean = sanitize_html(dirty);
        for gone in ["<script", "alert(1)", "onclick", "javascript:", "<form", "<input", "<iframe"] {
            assert!(!clean.contains(gone), "{gone} should be gone: {clean}");
        }
        for kept in [
            "p > b { color: red }",
            r#"style="color:blue""#,
            r#"width="600""#,
            r#"align="center""#,
            "cid:logo",
        ] {
            assert!(clean.contains(kept), "{kept} should stay: {clean}");
        }
        assert!(clean.contains(r#"href="https://example.com""#));
    }
}
