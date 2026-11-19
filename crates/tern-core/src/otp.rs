//! A sign-in code in new mail (idea 114), so a notification can offer to copy it. The same rules as
//! `oneTimeCode` in `src/facts.ts`, which puts a chip on the list row: a word that says what the code is and a
//! short number near it, never an order number or a price.

const KINDS: &[&str] = &[
    "verif",
    "security",
    "one-time",
    "one time",
    "onetime",
    "sign-in",
    "sign in",
    "signin",
    "log-in",
    "log in",
    "login",
    "confirm",
    "two-factor",
    "two factor",
    "2fa",
    "authenticat",
    "access code",
    "your code",
    "jednokrat",
    "verifikac",
    "sigurnosn",
    "prijav",
    "potvrd",
    "vaš kod",
    "tvoj kod",
];
const WORDS: &[&str] = &["code", "kod", "otp", "passcode", "pin"];
const STEMS: &[&str] = &["šifr", "lozink"];

/// The one-time code in a subject and opening, if there is one.
pub fn one_time_code(text: &str) -> Option<String> {
    let lower = text.to_lowercase();
    if !KINDS.iter().any(|k| lower.contains(k)) {
        return None;
    }
    let chars: Vec<char> = lower.chars().collect();
    let original: Vec<char> = text.chars().collect();
    // Lowercasing can change the length of a few letters; then the positions would not line up.
    if chars.len() != original.len() {
        return None;
    }
    let word = first_word(&chars)?;
    let mut best: Option<(String, usize)> = None;
    let mut i = 0;
    while i < chars.len() {
        if !chars[i].is_ascii_digit() || (i > 0 && chars[i - 1].is_ascii_digit()) {
            i += 1;
            continue;
        }
        let start = i;
        let mut end = run_end(&chars, i);
        let mut value: String = chars[start..end].iter().collect();
        // "123 456" is one code.
        if end - start == 3 && chars.get(end) == Some(&' ') && run_end(&chars, end + 1) == end + 4 {
            value.extend(&chars[end + 1..end + 4]);
            end += 4;
        }
        i = end;
        if !(4..=8).contains(&value.len())
            || (value.len() == 4 && (value.starts_with("19") || value.starts_with("20")))
        {
            continue;
        }
        if !alone_before(&original, start) || !alone_after(&chars, end) {
            continue;
        }
        let gap = start.abs_diff(word);
        if best.as_ref().is_none_or(|(_, g)| gap < *g) {
            best = Some((value, gap));
        }
    }
    best.filter(|(_, gap)| *gap <= 160).map(|(v, _)| v)
}

fn run_end(chars: &[char], mut i: usize) -> usize {
    while i < chars.len() && chars[i].is_ascii_digit() {
        i += 1;
    }
    i
}

/// Where the first word naming a code starts, as a char index.
fn first_word(chars: &[char]) -> Option<usize> {
    let mut i = 0;
    while i < chars.len() {
        if !chars[i].is_alphanumeric() {
            i += 1;
            continue;
        }
        let start = i;
        while i < chars.len() && chars[i].is_alphanumeric() {
            i += 1;
        }
        let w: String = chars[start..i].iter().collect();
        if WORDS.contains(&w.as_str()) || STEMS.iter().any(|s| w.starts_with(s)) {
            return Some(start);
        }
    }
    None
}

/// Nothing glued in front: a letter or digit, a time's or price's sign. "G-551204" keeps its letters off.
fn alone_before(chars: &[char], start: usize) -> bool {
    let Some(&c) = start.checked_sub(1).and_then(|i| chars.get(i)) else { return true };
    if c == '-' {
        let mut j = start - 1;
        let mut letters = 0;
        while j > 0 && chars[j - 1].is_ascii_uppercase() {
            j -= 1;
            letters += 1;
        }
        return (1..=3).contains(&letters) && (j == 0 || !chars[j - 1].is_alphanumeric());
    }
    if c.is_alphanumeric() || matches!(c, ':' | '.' | ',') {
        return false;
    }
    let prev = chars[..start].iter().rev().find(|c| !c.is_whitespace());
    !matches!(prev, Some('$' | '€' | '£'))
}

fn alone_after(chars: &[char], end: usize) -> bool {
    let next = chars.get(end).copied();
    if next.is_some_and(char::is_alphanumeric) {
        return false;
    }
    if matches!(next, Some(':' | '.' | ',' | '-')) && chars.get(end + 1).is_some_and(char::is_ascii_digit) {
        return false;
    }
    let rest: String = chars[end..chars.len().min(end + 5)].iter().collect();
    let rest = rest.trim_start();
    !["€", "eur", "usd", "km", "kn"].iter().any(|c| rest.starts_with(c))
}

#[cfg(test)]
mod tests {
    use super::one_time_code;

    #[test]
    fn finds_sign_in_codes_however_they_are_put() {
        for (text, code) in [
            ("Your verification code is 482913. It expires in 10 minutes.", "482913"),
            ("482913 is your Example login code", "482913"),
            ("G-551204 is your Google verification code.", "551204"),
            ("Use 123 456 to sign in. Your one-time code", "123456"),
            ("Vaš jednokratni kod je 7731.", "7731"),
            ("Kod za prijavu: 90412", "90412"),
        ] {
            assert_eq!(one_time_code(text).as_deref(), Some(code), "{text}");
        }
    }

    #[test]
    fn leaves_other_numbers_alone() {
        for text in [
            "Your order 123456 has shipped.",
            "Security code update for 2026: nothing to do.",
            "Meeting at 14:30 about the login code review",
            "Confirm your code: you owe $1200",
        ] {
            assert_eq!(one_time_code(text), None, "{text}");
        }
    }
}
