//! Mail as files (package 17 I): mbox in its mboxrd form, which every mail program reads. Each message starts with a
//! "From " line (the envelope sender and a date); a line inside a message that starts with "From ", after any number
//! of '>', gets one more '>' so it can't pass for the next message, and reading takes that '>' off again. Messages
//! are kept as bytes: headers that aren't UTF-8 and binary parts come back exactly as they went in.

use std::io::{self, BufRead, Write};

/// Writes one message: its "From " line, the message with quoted "From " lines, and the blank line that ends it.
/// `from` is the envelope sender (an address, else "MAILER-DAEMON"); `date` is Unix seconds.
pub fn write_message(out: &mut impl Write, raw: &[u8], from: &str, date: i64) -> io::Result<()> {
    let from = from.trim();
    let from = if from.is_empty() || from.contains(char::is_whitespace) { "MAILER-DAEMON" } else { from };
    writeln!(out, "From {from} {}", asctime(date))?;
    let mut lines = raw.split(|&b| b == b'\n').peekable();
    while let Some(line) = lines.next() {
        // The last piece after a final newline is empty: no line of its own.
        if lines.peek().is_none() && line.is_empty() {
            break;
        }
        let line = line.strip_suffix(b"\r").unwrap_or(line);
        let quoted = line.iter().position(|&b| b != b'>').is_some_and(|at| line[at..].starts_with(b"From "));
        if quoted {
            out.write_all(b">")?;
        }
        out.write_all(line)?;
        out.write_all(b"\n")?;
    }
    out.write_all(b"\n")
}

/// The messages in an mbox file, each as it was before `write_message` quoted it, with CRLF line ends (as mail is
/// sent and stored on servers). It reads one message at a time, so a file of many gigabytes needs no more memory
/// than its biggest message.
pub struct Reader<R> {
    input: R,
    line: Vec<u8>,
    current: Option<Vec<u8>>,
    blank_before: bool,
}

impl<R: BufRead> Reader<R> {
    pub fn new(input: R) -> Self {
        Reader { input, line: Vec::new(), current: None, blank_before: true }
    }
}

impl<R: BufRead> Iterator for Reader<R> {
    type Item = io::Result<Vec<u8>>;

    fn next(&mut self) -> Option<Self::Item> {
        loop {
            self.line.clear();
            match self.input.read_until(b'\n', &mut self.line) {
                Err(e) => return Some(Err(e)),
                // The end: the last message, if it holds anything.
                Ok(0) => match self.current.take().map(trimmed) {
                    Some(m) if !m.is_empty() => return Some(Ok(m)),
                    _ => return None,
                },
                Ok(_) => {}
            }
            let line = self.line.strip_suffix(b"\n").unwrap_or(&self.line);
            let line = line.strip_suffix(b"\r").unwrap_or(line);
            if self.blank_before && line.starts_with(b"From ") {
                self.blank_before = false;
                match self.current.replace(Vec::new()).map(trimmed) {
                    Some(m) if !m.is_empty() => return Some(Ok(m)),
                    _ => continue,
                }
            }
            self.blank_before = line.is_empty();
            let Some(m) = self.current.as_mut() else { continue };
            let unquoted = match line.iter().position(|&b| b != b'>') {
                Some(at) if at > 0 && line[at..].starts_with(b"From ") => &line[1..],
                _ => line,
            };
            m.extend_from_slice(unquoted);
            m.extend_from_slice(b"\r\n");
        }
    }
}

/// How many messages the mbox file at `path` holds, read one at a time.
pub fn count(path: &std::path::Path) -> io::Result<usize> {
    let mut n = 0;
    for message in Reader::new(io::BufReader::new(std::fs::File::open(path)?)) {
        message?;
        n += 1;
    }
    Ok(n)
}

/// Without the one blank line that separates it from the next message (`write_message` puts it after each); a
/// message's own blank lines stay.
fn trimmed(mut m: Vec<u8>) -> Vec<u8> {
    if m.ends_with(b"\r\n\r\n") {
        m.truncate(m.len() - 2);
    }
    if m == b"\r\n" {
        m.clear();
    }
    m
}

/// "Wed Nov  4 10:51:03 2026", the date an mbox "From " line carries, in UTC.
fn asctime(t: i64) -> String {
    const DAYS: [&str; 7] = ["Thu", "Fri", "Sat", "Sun", "Mon", "Tue", "Wed"];
    const MONTHS: [&str; 12] =
        ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    let (y, m, d) = crate::triage::civil(t);
    let secs = t.rem_euclid(86_400);
    let weekday = DAYS[t.div_euclid(86_400).rem_euclid(7) as usize];
    format!(
        "{weekday} {} {d:>2} {:02}:{:02}:{:02} {y}",
        MONTHS[(m as usize).saturating_sub(1).min(11)],
        secs / 3600,
        secs / 60 % 60,
        secs % 60
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mbox_of(messages: &[&[u8]]) -> Vec<u8> {
        let mut out = Vec::new();
        for (i, m) in messages.iter().enumerate() {
            write_message(&mut out, m, "ana@example.com", 1_793_789_463 + i as i64).unwrap();
        }
        out
    }

    #[test]
    fn writes_the_from_line_and_quotes_from_lines_inside() {
        let raw = b"Subject: hi\r\n\r\nFrom here on, it's fine.\r\n>From before.\r\n";
        let out = String::from_utf8(mbox_of(&[raw])).unwrap();
        let mut lines = out.lines();
        assert_eq!(lines.next(), Some("From ana@example.com Wed Nov  4 10:51:03 2026"));
        assert!(out.contains("\n>From here on, it's fine.\n"), "{out}");
        assert!(out.contains("\n>>From before.\n"), "{out}");
        assert!(out.ends_with("\n\n"));
    }

    #[test]
    fn a_round_trip_gives_back_every_message_byte_for_byte() {
        let plain: &[u8] = b"From: Ana <ana@example.com>\r\nSubject: Notes\r\n\r\nFrom the meeting:\r\n- one\r\n\r\n>From an old quote\r\n";
        // Latin-1 in a header, as old mail has, and a binary part.
        let mut latin: Vec<u8> =
            b"Subject: caf\xe9\r\nContent-Type: multipart/mixed; boundary=b\r\n\r\n--b\r\n".to_vec();
        latin.extend_from_slice(b"Content-Transfer-Encoding: base64\r\n\r\nAAECAwQ=\r\n--b--\r\n");
        let empty_body: &[u8] = b"Subject: just headers\r\n\r\n";
        let all = mbox_of(&[plain, &latin, empty_body]);
        let back = split(&all);
        assert_eq!(back.len(), 3);
        assert_eq!(back[0], plain);
        assert_eq!(back[1], latin);
        assert_eq!(back[2], empty_body);
    }

    #[test]
    fn reads_mbox_written_elsewhere_with_lf_line_ends() {
        let file = b"From someone Mon Jan  1 00:00:00 2024\nSubject: a\n\nbody a\n\nFrom other Mon Jan  1 00:00:01 2024\nSubject: b\n\nbody b\n";
        let back = split(file);
        assert_eq!(
            back,
            [b"Subject: a\r\n\r\nbody a\r\n".to_vec(), b"Subject: b\r\n\r\nbody b\r\n".to_vec()]
        );
        assert!(split(b"").is_empty());
        assert!(split(b"not an mbox at all\n").is_empty(), "text before any From line is no message");
        assert_eq!(
            split(b"From x\nSubject: c\n\nno newline at the end"),
            [b"Subject: c\r\n\r\nno newline at the end\r\n"]
        );
    }

    #[test]
    fn reads_from_a_file_a_little_at_a_time() {
        let all = mbox_of(&[b"Subject: one\r\n\r\nFrom me\r\n", b"Subject: two\r\n\r\nhi\r\n"]);
        let path = std::env::temp_dir().join(format!("tern-mbox-{}.mbox", std::process::id()));
        std::fs::write(&path, &all).unwrap();
        assert_eq!(count(&path).unwrap(), 2);
        std::fs::remove_file(&path).unwrap();
        let small = Reader::new(io::BufReader::with_capacity(3, &all[..])).collect::<io::Result<Vec<_>>>();
        assert_eq!(small.unwrap(), split(&all));
    }

    fn split(mbox: &[u8]) -> Vec<Vec<u8>> {
        Reader::new(mbox).collect::<io::Result<_>>().unwrap()
    }
}
