use mail_parser::{HeaderValue, MessageParser, PartType};

use crate::models::{NewMessage, Part};

/// Parses one raw RFC 5322 message. None when it is not mail at all.
pub fn parse(uid: u32, raw: &[u8], seen: bool, flagged: bool) -> Option<NewMessage> {
    let msg = MessageParser::default().parse(raw)?;

    let (from_name, from_addr) = msg
        .from()
        .and_then(|a| a.first())
        .map(|a| (a.name().unwrap_or_default().to_string(), a.address().unwrap_or_default().to_string()))
        .unwrap_or_default();
    let to_addrs = msg
        .to()
        .map(|list| list.iter().filter_map(|a| a.address()).collect::<Vec<_>>().join(", "))
        .unwrap_or_default();

    let body_text = msg.body_text(0).map(|t| t.into_owned());
    // mail-parser turns a text-only message into HTML; keep that as plain text so the reader can theme it.
    let body_html = match msg.html_part(0).map(|p| &p.body) {
        Some(PartType::Html(html)) => Some(html.clone().into_owned()),
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
        parts: None,
    })
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
}
