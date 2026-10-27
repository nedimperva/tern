use mail_parser::{HeaderValue, MessageParser, MimeHeaders, PartType};

use crate::models::{NewMessage, Part};
use crate::smtp::FileBytes;

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
        precedence_bulk: raw_header(&msg, "Precedence")
            .is_some_and(|p| ["bulk", "list", "junk"].contains(&p.to_ascii_lowercase().as_str())),
        cc_addrs: addrs(msg.cc()),
        reply_to: addrs(msg.reply_to()),
        followup_to: msg.header_raw("Mail-Followup-To").map(raw_addresses).unwrap_or_default(),
        parts: Some(attachments(&msg)),
    })
}

/// The attached files of a raw message: (name, type, contents). For forwarding and opening them.
pub fn attachment_files(raw: &[u8]) -> Vec<FileBytes> {
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

/// Images a message's HTML shows from its own parts (`<img src="cid:…">`), as (Content-ID without brackets, data:
/// URI). Only images, and none over `limit` bytes in all, so a message cannot fill the reader's memory.
pub fn inline_images(raw: &[u8], limit: usize) -> Vec<(String, String)> {
    let Some(msg) = MessageParser::default().parse(raw) else { return Vec::new() };
    let mut total = 0;
    let mut out = Vec::new();
    for part in &msg.parts {
        let Some(cid) = part.content_id() else { continue };
        let Some(kind) = part.content_type() else { continue };
        if !kind.ctype().eq_ignore_ascii_case("image") {
            continue;
        }
        let bytes = part.contents();
        total += bytes.len();
        if total > limit {
            break;
        }
        // The type is the sender's word; only plain image subtypes go into the URI.
        let subtype = kind.subtype().unwrap_or("png").to_ascii_lowercase();
        if !subtype.chars().all(|c| c.is_ascii_alphanumeric() || "+-.".contains(c)) {
            continue;
        }
        let cid = cid.trim().trim_start_matches('<').trim_end_matches('>').to_string();
        out.push((cid, format!("data:image/{subtype};base64,{}", base64(bytes))));
    }
    out
}

/// Standard base64 with padding.
pub fn base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = chunk.iter().enumerate().fold(0u32, |n, (i, b)| n | (*b as u32) << (16 - 8 * i));
        for i in 0..4 {
            out.push(if i <= chunk.len() {
                ALPHABET[(n >> (18 - 6 * i)) as usize & 63] as char
            } else {
                '='
            });
        }
    }
    out
}

/// Which of `files` (from `attachment_files`) is the `index`-th of the attachments a message's row lists. The list
/// can come from BODYSTRUCTURE, which may count parts a little differently from the parser, so files are matched by
/// name (the n-th file of that name for the n-th listed one) and by position only when no name matches.
pub fn pick_attachment(files: &[FileBytes], listed: &[String], index: usize) -> Option<usize> {
    let name = listed.get(index)?;
    let nth = listed[..index].iter().filter(|n| *n == name).count();
    let by_name = files.iter().enumerate().filter(|(_, f)| f.0 == *name).map(|(i, _)| i).nth(nth);
    by_name.or_else(|| (index < files.len() && !files.iter().any(|f| f.0 == *name)).then_some(index))
}

/// A name that is safe to create on any system Tern runs on: no folders, no characters Windows refuses, none of
/// its reserved device names, not hidden, not too long. Attachment names come from strangers.
pub fn safe_file_name(name: &str) -> String {
    let mut clean: String =
        name.chars().map(|c| if c.is_control() || r#"/\:*?"<>|"#.contains(c) { '_' } else { c }).collect();
    clean = clean.trim().trim_matches('.').trim().to_string();
    if clean.chars().count() > 150 {
        let (stem, ext) = match clean.rsplit_once('.') {
            Some((stem, ext)) if ext.len() <= 10 => (stem.to_string(), format!(".{ext}")),
            _ => (clean.clone(), String::new()),
        };
        clean = stem.chars().take(150 - ext.chars().count()).collect::<String>() + &ext;
    }
    let stem = clean.split('.').next().unwrap_or("").trim().to_ascii_uppercase();
    let reserved = ["CON", "PRN", "AUX", "NUL"].contains(&stem.as_str())
        || ((stem.starts_with("COM") || stem.starts_with("LPT"))
            && stem.len() == 4
            && stem.as_bytes()[3].is_ascii_digit());
    if clean.is_empty() {
        "attachment".into()
    } else if reserved {
        format!("_{clean}")
    } else {
        clean
    }
}

/// Files a double-click would run as a program, or mount as a drive, rather than show. Tern saves these but does
/// not open them: a mail attachment is the oldest way in.
pub fn runs_as_program(name: &str) -> bool {
    const RISKY: &[&str] = &[
        "exe",
        "msi",
        "msp",
        "msix",
        "appx",
        "appxbundle",
        "bat",
        "cmd",
        "com",
        "scr",
        "pif",
        "cpl",
        "msc",
        "vb",
        "vbs",
        "vbe",
        "js",
        "jse",
        "ws",
        "wsf",
        "wsh",
        "wsc",
        "ps1",
        "psm1",
        "lnk",
        "url",
        "scf",
        "hta",
        "jar",
        "reg",
        "inf",
        "dll",
        "sys",
        "application",
        "gadget",
        "settingcontent-ms",
        "library-ms",
        "iso",
        "img",
        "vhd",
        "vhdx",
        "appimage",
        "sh",
        "bash",
        "run",
        "bin",
        "desktop",
        "deb",
        "rpm",
        "py",
        "pyw",
        "pl",
        "rb",
        "command",
        "app",
        "pkg",
        "dmg",
        // Open in a browser from disk, where their scripts run and a fake sign-in page looks real.
        "html",
        "htm",
        "xhtml",
        "shtml",
        "mht",
        "mhtml",
        "svg",
        // Excel add-ins, compiled help and troubleshooting packs: each has carried malware by mail.
        "xll",
        "chm",
        "diagcab",
        "one",
    ];
    let lower = name.trim_end_matches(['.', ' ']).to_ascii_lowercase();
    lower.rsplit_once('.').is_some_and(|(_, ext)| RISKY.contains(&ext))
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

/// The date a message sorts by: its Date header, unless that is missing or more than a day after the server got
/// it (`received`, INTERNALDATE), which then stands in. A missing Date sank the message to the bottom of the
/// list; a date years ahead pinned it to the top. Without `received`, a date ahead of `now` is cut to `now`.
pub fn sort_date(header: i64, received: Option<i64>, now: i64) -> i64 {
    const DAY: i64 = 86_400;
    match received.filter(|r| *r > 0) {
        Some(r) if header <= 0 || header > r + DAY => r,
        Some(_) => header,
        None if header > now + DAY => now,
        None => header,
    }
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
    fn a_missing_or_future_date_gives_way_to_when_the_server_got_it() {
        let (got, now) = (1_000_000, 2_000_000);
        assert_eq!(sort_date(999_000, Some(got), now), 999_000);
        // Clocks drift: a few hours ahead of the server is still the sender's date.
        assert_eq!(sort_date(got + 3_600, Some(got), now), got + 3_600);
        assert_eq!(sort_date(0, Some(got), now), got);
        assert_eq!(sort_date(4_000_000_000, Some(got), now), got);
        assert_eq!(sort_date(4_000_000_000, None, now), now);
        assert_eq!(sort_date(0, None, now), 0);
    }

    #[test]
    fn inline_images_come_out_as_data_uris() {
        let raw = b"From: a@x\r\nSubject: s\r\nContent-Type: multipart/related; boundary=b\r\n\r\n\
--b\r\nContent-Type: text/html\r\n\r\n<img src=\"cid:logo@x\">\r\n\
--b\r\nContent-Type: image/png\r\nContent-ID: <logo@x>\r\nContent-Transfer-Encoding: base64\r\n\r\n\
TWFu\r\n--b\r\nContent-Type: application/pdf\r\nContent-ID: <doc@x>\r\n\r\nxyz\r\n--b--\r\n";
        assert_eq!(
            inline_images(raw, 1_000),
            [("logo@x".to_string(), "data:image/png;base64,TWFu".to_string())]
        );
        assert!(inline_images(raw, 2).is_empty(), "over the limit");
        assert_eq!(base64(b"Ma"), "TWE=");
        assert_eq!(base64(b"M"), "TQ==");
        assert_eq!(base64(b""), "");
    }

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

    #[test]
    fn listed_attachments_are_found_by_name_then_place() {
        let file = |n: &str| (n.to_string(), "application/pdf".to_string(), n.as_bytes().to_vec());
        let files = [file("a.pdf"), file("logo.png"), file("a.pdf")];
        let listed = |l: &[&str]| l.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        // BODYSTRUCTURE did not count the inline logo; the second "a.pdf" is still the second file of that name.
        assert_eq!(pick_attachment(&files, &listed(&["a.pdf", "a.pdf"]), 1), Some(2));
        assert_eq!(pick_attachment(&files, &listed(&["a.pdf", "logo.png"]), 1), Some(1));
        // A name the parser does not know: by position.
        assert_eq!(pick_attachment(&files, &listed(&["Untitled", "x", "y"]), 1), Some(1));
        assert_eq!(pick_attachment(&files, &listed(&["a.pdf"]), 3), None);
    }

    #[test]
    fn attachment_names_are_made_safe() {
        assert_eq!(safe_file_name("../../etc/passwd"), "_.._etc_passwd");
        assert_eq!(safe_file_name("C:\\Windows\\x.dll"), "C__Windows_x.dll");
        assert_eq!(safe_file_name("con.txt"), "_con.txt");
        assert_eq!(safe_file_name("COM1"), "_COM1");
        assert_eq!(safe_file_name("..."), "attachment");
        assert_eq!(safe_file_name("report.pdf"), "report.pdf");
        let long = format!("{}.pdf", "x".repeat(300));
        assert!(safe_file_name(&long).ends_with("x.pdf") && safe_file_name(&long).chars().count() == 150);
        assert!(
            runs_as_program("invoice.pdf.exe")
                && runs_as_program("Setup.MSI")
                && runs_as_program("x.lnk. ")
                && runs_as_program("Sign in.html")
                && runs_as_program("chart.svg")
                && runs_as_program("q.xll")
        );
        assert!(
            !runs_as_program("invoice.pdf") && !runs_as_program("route.gpx") && !runs_as_program("README")
        );
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
