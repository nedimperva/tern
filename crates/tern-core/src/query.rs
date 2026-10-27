//! The search box's language, turned into an FTS5 match and SQL conditions on `messages m`.
//!
//! Plain words match subject, sender and body as prefixes ("inv acme" finds "Invoice from ACME"); `"exact phrase"`
//! matches as written; `OR` between words takes either. Filters narrow by fields: `from:` `to:` `cc:` `subject:`
//! (`me` means the account's own address), `is:unread|read|starred|unstarred|marked`, `has:attachment`,
//! `in:inbox|archive|sent|drafts|trash|spam|<folder>` (`label:` is the same), `before:`/`after:` a date
//! (YYYY-MM-DD, UTC), `newer_than:`/`older_than:` 3d 2w 6m 1y, `larger:`/`smaller:` 500k 5m. A leading `-` excludes.
//! Anything that is not a known filter is searched as text, so a mistyped filter still finds something.

use rusqlite::types::Value;

/// A parsed query: the FTS5 expression for the words (empty if none) and SQL conditions with their parameters.
#[derive(Debug, Default, PartialEq)]
pub struct Query {
    /// For `messages_fts MATCH`; empty when the query has no words to look for.
    pub fts: String,
    /// Words to leave out, as one FTS5 expression for `m.id NOT IN (… MATCH ?)`; empty if none.
    pub fts_not: String,
    /// The words as typed (phrases whole), for looking in marks and notes too; empty when OR joins any.
    pub words: Vec<String>,
    /// Conditions ANDed together, each with `?` placeholders filled from `params` in order.
    pub conditions: Vec<String>,
    pub params: Vec<Value>,
}

impl Query {
    /// Whether anything at all narrows the search; an empty query finds nothing rather than everything.
    pub fn is_empty(&self) -> bool {
        self.fts.is_empty() && self.fts_not.is_empty() && self.conditions.is_empty()
    }
}

/// Splits on spaces, keeping `"quoted parts"` (also after `key:` or `-`) together. Quotes are kept in the token.
fn tokens(input: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut current = String::new();
    let mut quoted = false;
    for ch in input.chars() {
        match ch {
            '"' => {
                quoted = !quoted;
                current.push(ch);
            }
            c if c.is_whitespace() && !quoted => {
                if !current.is_empty() {
                    out.push(std::mem::take(&mut current));
                }
            }
            c => current.push(c),
        }
    }
    if !current.is_empty() {
        out.push(current);
    }
    out
}

/// A token's text without its quotes.
fn unquote(s: &str) -> String {
    s.replace('"', "")
}

/// One word or phrase for FTS5: a phrase is matched as written, a word as a prefix. None when nothing is left.
fn fts_term(token: &str) -> Option<String> {
    let phrase = token.starts_with('"');
    let text = unquote(token);
    let text = text.trim();
    if text.is_empty() {
        return None;
    }
    let escaped = text.replace('"', "\"\"");
    Some(if phrase { format!("\"{escaped}\"") } else { format!("\"{escaped}\"*") })
}

/// `7d`, `2w`, `6m`, `1y` in seconds.
fn duration(s: &str) -> Option<i64> {
    let (n, unit) = s.split_at(s.len().checked_sub(1)?);
    let n: i64 = n.parse().ok()?;
    let day = 86_400;
    Some(
        n * match unit.to_ascii_lowercase().as_str() {
            "d" => day,
            "w" => 7 * day,
            "m" => 30 * day,
            "y" => 365 * day,
            _ => return None,
        },
    )
}

/// `500k`, `5m`, `1g` or plain bytes.
fn bytes(s: &str) -> Option<i64> {
    let lower = s.to_ascii_lowercase();
    let (n, scale) = match lower.chars().last()? {
        'k' => (&lower[..lower.len() - 1], 1_000),
        'm' => (&lower[..lower.len() - 1], 1_000_000),
        'g' => (&lower[..lower.len() - 1], 1_000_000_000),
        _ => (lower.as_str(), 1),
    };
    let n: f64 = n.parse().ok()?;
    Some((n * scale as f64) as i64)
}

/// `YYYY-MM-DD` (or `YYYY/MM/DD`) as Unix seconds at midnight UTC.
fn date(s: &str) -> Option<i64> {
    let mut parts = s.split(['-', '/']).map(|p| p.parse::<i64>().ok());
    let (y, m, d) = (parts.next()??, parts.next()??, parts.next()??);
    if parts.next().is_some() || !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return None;
    }
    // Days from 1970-01-01 to the civil date (Howard Hinnant's algorithm).
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    Some((era * 146_097 + doe - 719_468) * 86_400)
}

/// The folder role a word in `in:` stands for, where it is one.
fn role(word: &str) -> Option<&'static str> {
    Some(match word {
        "inbox" => "inbox",
        "archive" | "archived" | "done" => "archive",
        "sent" => "sent",
        "drafts" | "draft" => "drafts",
        "trash" | "deleted" | "bin" => "trash",
        "spam" | "junk" => "junk",
        _ => return None,
    })
}

/// A condition on the address (or name) fields: `me` is the account's own address.
fn address(columns: &[&str], value: &str, q: &mut Vec<Value>) -> String {
    if value.eq_ignore_ascii_case("me") {
        let any: Vec<String> = columns
            .iter()
            .map(|c| {
                format!("instr(lower({c}), (SELECT lower(email) FROM accounts WHERE id = m.account_id)) > 0")
            })
            .collect();
        return format!("({})", any.join(" OR "));
    }
    let any: Vec<String> = columns
        .iter()
        .map(|c| {
            q.push(Value::Text(value.to_lowercase()));
            format!("instr(lower({c}), ?) > 0")
        })
        .collect();
    format!("({})", any.join(" OR "))
}

/// The SQL for one filter, or None when `key:value` is not a filter (then it is searched as text).
fn filter(key: &str, value: &str, now: i64, q: &mut Vec<Value>) -> Option<String> {
    let lower = value.to_lowercase();
    let mut push = |v: Value| q.push(v);
    Some(match key {
        "from" => address(&["m.from_addr", "m.from_name"], value, q),
        "to" => address(&["m.to_addrs"], value, q),
        "cc" => address(&["m.cc_addrs"], value, q),
        "subject" => {
            push(Value::Text(lower));
            "instr(lower(m.subject), ?) > 0".into()
        }
        "is" => match lower.as_str() {
            "unread" => "m.seen = 0".into(),
            "read" => "m.seen = 1".into(),
            "starred" | "flagged" => "m.flagged = 1".into(),
            "unstarred" => "m.flagged = 0".into(),
            // Marked in Tern (reading marks and notes), on this message or another copy of it.
            "marked" | "noted" => "EXISTS (SELECT 1 FROM marks k WHERE k.account_id = m.account_id
                                           AND k.message_key = COALESCE(m.message_id, '#' || m.id))"
                .into(),
            _ => return None,
        },
        "has" => match lower.as_str() {
            "attachment" | "attachments" | "file" | "files" => "m.has_attachments = 1".into(),
            _ => return None,
        },
        "in" | "label" => {
            if let Some(role) = role(&lower) {
                push(Value::Text(role.into()));
                "m.folder_id IN (SELECT id FROM folders WHERE role = ?)".into()
            } else {
                push(Value::Text(lower));
                "m.folder_id IN (SELECT id FROM folders WHERE lower(name) = ?)".into()
            }
        }
        "before" => {
            push(Value::Integer(date(value)?));
            "m.date < ?".into()
        }
        "after" => {
            push(Value::Integer(date(value)?));
            "m.date >= ?".into()
        }
        "newer_than" | "newer" => {
            push(Value::Integer(now - duration(value)?));
            "m.date >= ?".into()
        }
        "older_than" | "older" => {
            push(Value::Integer(now - duration(value)?));
            "m.date < ?".into()
        }
        "larger" => {
            push(Value::Integer(bytes(value)?));
            "m.size > ?".into()
        }
        "smaller" => {
            push(Value::Integer(bytes(value)?));
            "m.size < ?".into()
        }
        _ => return None,
    })
}

/// Parses what was typed in the search box. `now` is Unix seconds, for `newer_than:` and `older_than:`.
pub fn parse(input: &str, now: i64) -> Query {
    let mut query = Query::default();
    let mut words: Vec<String> = Vec::new();
    let mut not_words: Vec<String> = Vec::new();
    let mut or_next = false;
    let mut any_or = false;
    for token in tokens(input) {
        if token == "OR" {
            or_next = !words.is_empty();
            any_or |= or_next;
            continue;
        }
        let (negated, body) = match token.strip_prefix('-') {
            Some(rest) if !rest.is_empty() => (true, rest),
            _ => (false, token.as_str()),
        };
        if let Some((key, value)) = body.split_once(':') {
            let value = unquote(value);
            let mut params = Vec::new();
            if !value.is_empty() {
                if let Some(sql) = filter(&key.to_ascii_lowercase(), &value, now, &mut params) {
                    query.conditions.push(if negated { format!("NOT {sql}") } else { sql });
                    query.params.extend(params);
                    or_next = false;
                    continue;
                }
            }
        }
        let Some(term) = fts_term(body) else { continue };
        if negated {
            not_words.push(term);
            continue;
        }
        query.words.push(unquote(body).trim().to_string());
        if or_next {
            let last = words.pop().expect("OR follows a word");
            words.push(format!("({last} OR {term})"));
            or_next = false;
        } else {
            words.push(term);
        }
    }
    if any_or {
        query.words.clear();
    }
    query.fts = words.join(" AND ");
    query.fts_not = not_words.join(" OR ");
    query
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn words_are_prefixes_and_phrases_are_exact() {
        assert_eq!(parse("inv acme", 0).fts, "\"inv\"* AND \"acme\"*");
        assert_eq!(parse("\"quarterly report\" q3", 0).fts, "\"quarterly report\" AND \"q3\"*");
        assert_eq!(parse("lunch OR dinner friday", 0).fts, "(\"lunch\"* OR \"dinner\"*) AND \"friday\"*");
        assert!(parse("\"", 0).is_empty());
        assert!(parse("   ", 0).is_empty());
    }

    #[test]
    fn filters_become_conditions() {
        let q = parse("from:ada is:unread has:attachment in:sent", 0);
        assert!(q.fts.is_empty());
        assert_eq!(q.conditions.len(), 4);
        assert_eq!(
            q.params,
            [Value::Text("ada".into()), Value::Text("ada".into()), Value::Text("sent".into())]
        );
        let q = parse("subject:\"Weekly sync\" -is:read", 0);
        assert_eq!(q.params, [Value::Text("weekly sync".into())]);
        assert_eq!(q.conditions[1], "NOT m.seen = 1");
    }

    #[test]
    fn dates_sizes_and_ages() {
        assert_eq!(date("1970-01-02"), Some(86_400));
        assert_eq!(date("2026-10-15"), Some(1_792_022_400));
        assert_eq!(date("2026-13-01"), None);
        assert_eq!(bytes("5m"), Some(5_000_000));
        assert_eq!(bytes("1.5k"), Some(1_500));
        let q = parse("newer_than:7d", 1_000_000);
        assert_eq!(q.params, [Value::Integer(1_000_000 - 7 * 86_400)]);
    }

    #[test]
    fn what_is_not_a_filter_is_searched_as_text() {
        let q = parse("re:budget before:soon", 0);
        assert_eq!(q.fts, "\"re:budget\"* AND \"before:soon\"*");
        assert!(q.conditions.is_empty());
    }

    #[test]
    fn negated_words_are_left_out() {
        let q = parse("invoice -paid", 0);
        assert_eq!((q.fts.as_str(), q.fts_not.as_str()), ("\"invoice\"*", "\"paid\"*"));
    }
}
