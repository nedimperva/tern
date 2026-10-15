//! Which inbox split a message lands in, and the snooze times people type.
//!
//! The inbox has two splits: **Important** (people writing to you) and **Other** (mail sent to many: newsletters,
//! notifications, receipts). A message is Other when its headers say it went to a list (`List-Id`,
//! `List-Unsubscribe`, `Precedence: bulk`) or it comes from an address nobody answers (noreply@…). Moving a
//! conversation to the other split remembers its sender (`sender_splits`), which wins over the headers.

use crate::models::NewMessage;

/// Local parts of addresses that send mail nobody is meant to answer.
const NO_REPLY: [&str; 9] = [
    "noreply",
    "no-reply",
    "no_reply",
    "donotreply",
    "do-not-reply",
    "notification",
    "newsletter",
    "mailer-daemon",
    "bounce",
];

/// Whether the address is one nobody answers, such as noreply@ or notifications@.
pub fn unanswered_sender(addr: &str) -> bool {
    let local = addr.split('@').next().unwrap_or("").to_ascii_lowercase();
    NO_REPLY.iter().any(|p| local.starts_with(p))
}

/// Whether a message goes to Other unless its sender was moved to Important.
pub fn is_bulk(m: &NewMessage) -> bool {
    m.precedence_bulk
        || m.list_id.is_some()
        || m.list_unsubscribe.is_some()
        || unanswered_sender(&m.from_addr)
}

/// Unix seconds for what was typed in the snooze box: "3h", "45m", "2d", "in 2 days", "tonight", "later",
/// "tomorrow", "tomorrow 9am", "mon", "next week", "weekend", "dec 3", "3 dec", "9pm", "17:30". A day without a
/// time means 8:00. `now` is Unix seconds, `offset` the local time's minutes east of UTC (Berlin in summer: 120).
/// None when it cannot be read or is not in the future.
pub fn when(text: &str, now: i64, offset: i64) -> Option<i64> {
    let text = text.trim().to_ascii_lowercase();
    let words: Vec<&str> =
        text.split_whitespace().filter(|w| *w != "in" && *w != "at" && *w != "on").collect();
    if words.is_empty() {
        return None;
    }
    let local = now + offset * 60;
    let today = local.div_euclid(86_400) * 86_400;
    let at = |day: i64, minutes: i64| day + minutes * 60 - offset * 60;

    // A span from now: "3h", "2 days", "45 min".
    if let Some(secs) = span(&words) {
        return Some(now + secs).filter(|t| *t > now);
    }
    let joined = words.join(" ");
    let fixed = match joined.as_str() {
        "later" | "later today" => return Some(now + 3 * 3600),
        "tonight" | "this evening" => Some(at(today, 19 * 60)),
        "next week" => Some(at(next_weekday(today, 0), 8 * 60)),
        "weekend" | "this weekend" => Some(at(next_weekday(today, 5), 8 * 60)),
        _ => None,
    };
    if let Some(t) = fixed {
        return Some(t).filter(|t| *t > now);
    }

    // A day, a time, or both.
    let mut day: Option<i64> = None;
    let mut minutes: Option<i64> = None;
    let mut i = 0;
    while i < words.len() {
        let w = words[i];
        if let Some(m) = time_of_day(w, words.get(i + 1).copied()) {
            minutes = Some(m.0);
            i += m.1;
            continue;
        }
        if w == "today" {
            day = Some(today);
        } else if w == "tomorrow" || w == "tmrw" || w == "tom" {
            day = Some(today + 86_400);
        } else if let Some(wd) = weekday(w) {
            day = Some(next_weekday(today, wd));
        } else if w == "next" {
            // "next mon": the same as "mon" (the coming one).
        } else {
            let (d, used) = date(&words[i..], today)?;
            day = Some(d);
            i += used;
            continue;
        }
        i += 1;
    }
    let t = match (day, minutes) {
        (Some(d), m) => at(d, m.unwrap_or(8 * 60)),
        // A time alone: today if it is still ahead, else tomorrow.
        (None, Some(m)) => {
            let t = at(today, m);
            if t > now {
                t
            } else {
                t + 86_400
            }
        }
        (None, None) => return None,
    };
    Some(t).filter(|t| *t > now)
}

/// "3h", "2 d", "45 minutes", "1 week" in seconds.
fn span(words: &[&str]) -> Option<i64> {
    let (n, unit) = match words {
        [one] => {
            let split = one.find(|c: char| !c.is_ascii_digit())?;
            (&one[..split], &one[split..])
        }
        [n, unit] => (*n, *unit),
        _ => return None,
    };
    let n: i64 = n.parse().ok()?;
    let unit = match unit {
        "m" | "min" | "mins" | "minute" | "minutes" => 60,
        "h" | "hr" | "hrs" | "hour" | "hours" => 3600,
        "d" | "day" | "days" => 86_400,
        "w" | "wk" | "week" | "weeks" => 7 * 86_400,
        _ => return None,
    };
    Some(n * unit)
}

/// "9am", "9 pm", "9:30", "17:00", "noon" as minutes after midnight, and how many words it took.
fn time_of_day(w: &str, next: Option<&str>) -> Option<(i64, usize)> {
    if w == "noon" || w == "midday" {
        return Some((12 * 60, 1));
    }
    let (clock, mut half, mut used) = match w.strip_suffix("am").or_else(|| w.strip_suffix("a")) {
        Some(c) if !c.is_empty() => (c, Some(false), 1),
        _ => match w.strip_suffix("pm").or_else(|| w.strip_suffix("p")) {
            Some(c) if !c.is_empty() => (c, Some(true), 1),
            _ => (w, None, 1),
        },
    };
    if half.is_none() {
        match next {
            Some("am") => (half, used) = (Some(false), 2),
            Some("pm") => (half, used) = (Some(true), 2),
            _ => {}
        }
    }
    let (h, m) = match clock.split_once(':') {
        Some((h, m)) => (h.parse::<i64>().ok()?, m.parse::<i64>().ok()?),
        // A bare number is a time only with am/pm ("3" alone could be a date).
        None if half.is_some() => (clock.parse::<i64>().ok()?, 0),
        None => return None,
    };
    if !(0..60).contains(&m) {
        return None;
    }
    let h = match half {
        Some(pm) if (1..=12).contains(&h) => h % 12 + if pm { 12 } else { 0 },
        Some(_) => return None,
        None if (0..24).contains(&h) => h,
        None => return None,
    };
    Some((h * 60 + m, used))
}

/// Monday = 0 … Sunday = 6.
fn weekday(w: &str) -> Option<i64> {
    const DAYS: [&str; 7] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
    if w.len() < 3 {
        return None;
    }
    DAYS.iter().position(|d| w.starts_with(d)).map(|i| i as i64)
}

/// The next day (local midnight) that falls on `wd`. Today itself is never the answer: on a Monday, "mon" is a week on.
fn next_weekday(today: i64, wd: i64) -> i64 {
    // 1970-01-01 was a Thursday (3).
    let current = (today.div_euclid(86_400) + 3).rem_euclid(7);
    let ahead = (wd - current).rem_euclid(7);
    today + if ahead == 0 { 7 } else { ahead } * 86_400
}

/// "dec 3", "3 dec", "december 3rd": the next such date (local midnight), and the words it took.
fn date(words: &[&str], today: i64) -> Option<(i64, usize)> {
    const MONTHS: [&str; 12] =
        ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
    let month = |w: &str| (w.len() >= 3).then(|| MONTHS.iter().position(|m| w.starts_with(m))).flatten();
    let number = |w: &str| w.trim_end_matches(|c: char| c.is_ascii_alphabetic()).parse::<i64>().ok();
    let (m, d) = match words {
        [a, b, ..] if month(a).is_some() && number(b).is_some() => (month(a)?, number(b)?),
        [a, b, ..] if number(a).is_some() && month(b).is_some() => (month(b)?, number(a)?),
        _ => return None,
    };
    if !(1..=31).contains(&d) {
        return None;
    }
    let (y, _, _) = civil(today);
    let mut t = days_from_civil(y, m as i64 + 1, d) * 86_400;
    if t <= today {
        t = days_from_civil(y + 1, m as i64 + 1, d) * 86_400;
    }
    Some((t, 2))
}

/// (year, month, day) of a day in seconds since the epoch.
fn civil(t: i64) -> (i64, i64, i64) {
    let z = t.div_euclid(86_400) + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (yoe + era * 400 + i64::from(m <= 2), m, d)
}

/// Days since the epoch of a civil date (Howard Hinnant's algorithm).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

#[cfg(test)]
mod tests {
    use super::*;

    // Thursday 2026-10-15, 14:30 in Berlin (UTC+2).
    const NOW: i64 = 1_792_022_400 + 12 * 3600 + 30 * 60;
    const BERLIN: i64 = 120;
    /// Local wall time on a day counted from 2026-10-15, as Unix seconds.
    fn local(days: i64, h: i64, m: i64) -> i64 {
        1_792_022_400 + days * 86_400 + (h * 60 + m) * 60 - BERLIN * 60
    }

    #[test]
    fn spans() {
        assert_eq!(when("3h", NOW, BERLIN), Some(NOW + 3 * 3600));
        assert_eq!(when("in 2 days", NOW, BERLIN), Some(NOW + 2 * 86_400));
        assert_eq!(when("45 min", NOW, BERLIN), Some(NOW + 45 * 60));
        assert_eq!(when("later", NOW, BERLIN), Some(NOW + 3 * 3600));
    }

    #[test]
    fn days_and_times() {
        assert_eq!(when("tomorrow", NOW, BERLIN), Some(local(1, 8, 0)));
        assert_eq!(when("tomorrow 9am", NOW, BERLIN), Some(local(1, 9, 0)));
        assert_eq!(when("Tomorrow at 5 pm", NOW, BERLIN), Some(local(1, 17, 0)));
        assert_eq!(when("tonight", NOW, BERLIN), Some(local(0, 19, 0)));
        assert_eq!(when("17:30", NOW, BERLIN), Some(local(0, 17, 30)));
        assert_eq!(when("9am", NOW, BERLIN), Some(local(1, 9, 0)), "past today, so tomorrow");
        assert_eq!(when("mon", NOW, BERLIN), Some(local(4, 8, 0)));
        assert_eq!(when("thursday", NOW, BERLIN), Some(local(7, 8, 0)), "today is Thursday: next week's");
        assert_eq!(when("next week", NOW, BERLIN), Some(local(4, 8, 0)));
        assert_eq!(when("this weekend", NOW, BERLIN), Some(local(2, 8, 0)));
        assert_eq!(when("dec 3", NOW, BERLIN), Some(local(49, 8, 0)));
        assert_eq!(when("3rd december 10:15", NOW, BERLIN), Some(local(49, 10, 15)));
        assert_eq!(when("oct 1", NOW, BERLIN), Some(local(351, 8, 0)), "already past: next year");
    }

    #[test]
    fn nonsense_and_the_past_are_refused() {
        assert_eq!(when("", NOW, BERLIN), None);
        assert_eq!(when("whenever", NOW, BERLIN), None);
        assert_eq!(when("today 9am", NOW, BERLIN), None);
        assert_eq!(when("25:00", NOW, BERLIN), None);
        assert_eq!(when("13pm", NOW, BERLIN), None);
    }

    #[test]
    fn bulk_mail() {
        assert!(unanswered_sender("no-reply@github.com"));
        assert!(unanswered_sender("Notifications@x.com"));
        assert!(!unanswered_sender("nora@example.com"));
        let person = NewMessage { from_addr: "ada@example.com".into(), ..Default::default() };
        assert!(!is_bulk(&person));
        assert!(is_bulk(&NewMessage { list_id: Some("<x.list>".into()), ..person.clone() }));
        assert!(is_bulk(&NewMessage { precedence_bulk: true, ..person }));
    }
}
