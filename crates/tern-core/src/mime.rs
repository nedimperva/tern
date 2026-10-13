use mail_parser::{HeaderValue, MessageParser};

use crate::models::NewMessage;

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
    let body_html = msg.body_html(0).map(|t| t.into_owned());

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
    })
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
}
