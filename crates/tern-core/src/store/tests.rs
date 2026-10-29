use super::schema::SCHEMA;
use super::*;

fn config() -> AccountConfig {
    AccountConfig {
        email: "me@example.com".into(),
        display_name: "Me".into(),
        username: "me@example.com".into(),
        imap_host: "imap.example.com".into(),
        imap_port: 993,
        imap_security: Security::Tls,
        smtp_host: "smtp.example.com".into(),
        smtp_port: 465,
        smtp_security: Security::Tls,
        auth: Default::default(),
    }
}

fn message(uid: u32, subject: &str, date: i64) -> NewMessage {
    NewMessage {
        uid,
        message_id: Some(format!("{uid}@example.com")),
        subject: subject.into(),
        from_name: "Ada".into(),
        from_addr: "ada@example.com".into(),
        date,
        body_text: Some(format!("body of {subject}")),
        ..Default::default()
    }
}

fn setup() -> (Store, i64, i64, i64) {
    let store = Store::open_in_memory().unwrap();
    let account = store.add_account(&config()).unwrap();
    let inbox = store.upsert_folder(account.id, "INBOX", "inbox").unwrap();
    let archive = store.upsert_folder(account.id, "Archive", "archive").unwrap();
    (store, account.id, inbox, archive)
}

#[test]
fn lists_pages_newest_first() {
    let (store, account, inbox, _) = setup();
    let batch: Vec<_> = (1..=5).map(|i| message(i, &format!("m{i}"), i as i64 * 100)).collect();
    store.insert_messages(account, inbox, &batch).unwrap();

    let page = store.list(&ListTarget::Folder(inbox), None, 2).unwrap();
    assert_eq!(page.iter().map(|r| r.subject.as_str()).collect::<Vec<_>>(), ["m5", "m4"]);
    let last = page.last().unwrap();
    let next =
        store.list(&ListTarget::Folder(inbox), Some(Cursor { date: last.date, id: last.id }), 2).unwrap();
    assert_eq!(next.iter().map(|r| r.subject.as_str()).collect::<Vec<_>>(), ["m3", "m2"]);
    assert_eq!(store.list(&ListTarget::Role("inbox".into()), None, 10).unwrap().len(), 5);
}

#[test]
fn searches_by_prefix() {
    let (store, account, inbox, _) = setup();
    store
        .insert_messages(account, inbox, &[message(1, "Invoice from ACME", 1), message(2, "Lunch", 2)])
        .unwrap();
    let hits = store.search("inv acme", 10).unwrap().rows;
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].subject, "Invoice from ACME");
    assert!(store.search("\"", 10).unwrap().rows.is_empty());
}

#[test]
fn search_filters_narrow_by_field_folder_and_state() {
    let (store, account, inbox, archive) = setup();
    let mut from_grace = message(1, "Budget", 100);
    from_grace.from_addr = "grace@navy.mil".into();
    from_grace.has_attachments = true;
    let mut to_me = message(2, "Budget follow-up", 200);
    to_me.to_addrs = "Me <ME@example.com>".into();
    to_me.seen = true;
    store.insert_messages(account, inbox, &[from_grace, to_me]).unwrap();
    store.insert_messages(account, archive, &[message(3, "Old budget", 50)]).unwrap();
    let subjects = |q: &str| -> Vec<String> {
        store.search(q, 10).unwrap().rows.into_iter().map(|r| r.subject).collect()
    };
    assert_eq!(subjects("budget"), ["Budget follow-up", "Budget", "Old budget"]);
    assert_eq!(subjects("budget from:grace"), ["Budget"]);
    assert_eq!(subjects("to:me"), ["Budget follow-up"]);
    assert_eq!(subjects("has:attachment"), ["Budget"]);
    assert_eq!(subjects("in:archive"), ["Old budget"]);
    assert_eq!(subjects("budget -in:archive is:unread"), ["Budget"]);
    assert_eq!(subjects("budget -follow"), ["Budget", "Old budget"]);
    assert_eq!(subjects("before:1970-01-01"), Vec::<String>::new());
    assert_eq!(subjects("after:1970-01-01 is:read"), ["Budget follow-up"]);
    assert!(!store.search("budget", 10).unwrap().partial, "every body is here");
}

#[test]
fn search_finds_the_newest_matches_whatever_order_mail_arrived_in() {
    let (store, account, inbox, archive) = setup();
    // Dates scrambled against arrival order, so ids say nothing about age.
    let mail: Vec<NewMessage> = (1..=1200u32)
        .map(|uid| {
            let mut words = vec!["every"];
            for (n, word) in [(2, "half"), (10, "tenth"), (400, "rare")] {
                if uid % n == 0 {
                    words.push(word);
                }
            }
            NewMessage { body_text: Some(words.join(" ")), ..message(uid, "s", (uid as i64 * 7919) % 1000) }
        })
        .collect();
    let (first, second) = mail.split_at(700);
    store.insert_messages(account, inbox, first).unwrap();
    store.insert_messages(account, archive, second).unwrap();
    for query in ["every", "half", "tenth", "rare", "ever", "half in:inbox", "every -half", "every is:unread"]
    {
        let q = crate::query::parse(query, now());
        let mut conditions = vec!["messages_fts MATCH ?".to_string()];
        let mut values = vec![Value::Text(q.fts.clone())];
        if !q.fts_not.is_empty() {
            conditions.push("m.id NOT IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?)".into());
            values.push(Value::Text(q.fts_not.clone()));
        }
        conditions.extend(q.conditions);
        values.extend(q.params);
        // Every match, sorted: what search used to do.
        let sql = format!(
            "SELECT m.id FROM messages m JOIN messages_fts ON messages_fts.rowid = m.id WHERE {}
             ORDER BY m.date DESC, m.id DESC LIMIT 50",
            conditions.join(" AND ")
        );
        let conn = store.conn();
        let want: Vec<i64> = conn
            .prepare(&sql)
            .unwrap()
            .query_map(rusqlite::params_from_iter(values), |r| r.get(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        drop(conn);
        let got: Vec<i64> = store.search(query, 50).unwrap().rows.iter().map(|r| r.id).collect();
        assert!(!want.is_empty(), "{query}");
        assert_eq!(got, want, "{query}");
    }
}

#[test]
fn snippets_keep_one_word_shortcuts_and_the_most_used_first() {
    let (store, ..) = setup();
    let thanks = Snippet {
        shortcut: ";thanks".into(),
        name: "Thanks".into(),
        body: "Thanks {first_name}!".into(),
        ..Default::default()
    };
    let id = store.save_snippet(&thanks).unwrap();
    let later = store.save_snippet(&Snippet { shortcut: "later".into(), ..Default::default() }).unwrap();
    assert_eq!(store.snippets().unwrap()[0].shortcut, "later", "unused, by shortcut");
    assert!(store.save_snippet(&Snippet { shortcut: "THANKS".into(), ..Default::default() }).is_err());
    assert!(store.save_snippet(&Snippet { shortcut: "two words".into(), ..Default::default() }).is_err());
    store.snippet_used(id).unwrap();
    let all = store.snippets().unwrap();
    assert!(all[0].last_used.is_some());
    assert_eq!(
        all[0],
        Snippet { id, shortcut: "thanks".into(), used: 1, last_used: all[0].last_used, ..thanks }
    );
    store.save_snippet(&Snippet { id: later, shortcut: "soon".into(), ..Default::default() }).unwrap();
    store.delete_snippet(id).unwrap();
    let left: Vec<String> = store.snippets().unwrap().into_iter().map(|s| s.shortcut).collect();
    assert_eq!(left, ["soon"]);
}

#[test]
fn a_snippet_can_belong_to_one_account_and_fill_in_subject_and_cc() {
    let (store, account, ..) = setup();
    let offer = Snippet {
        shortcut: "offer".into(),
        body: "Attached.".into(),
        account_id: Some(account),
        subject: Some("  ".into()),
        cc: vec!["sales@x.com".into(), " ".into()],
        ..Default::default()
    };
    let id = store.save_snippet(&offer).unwrap();
    let saved = &store.snippets().unwrap()[0];
    assert_eq!(
        (saved.account_id, saved.subject.as_deref()),
        (Some(account), None),
        "a blank subject is none"
    );
    assert_eq!(saved.cc, ["sales@x.com"]);
    store.snippet_used(id).unwrap();
    let resaved = Snippet { id, subject: Some("Offer".into()), ..offer };
    store.save_snippet(&resaved).unwrap();
    assert_eq!(store.snippets().unwrap()[0].used, 1, "saving keeps the count");
    store.conn().execute("DELETE FROM accounts", []).unwrap();
    assert!(store.snippets().unwrap().is_empty(), "goes with its account");
}

#[test]
fn an_account_can_be_renamed() {
    let (store, account, ..) = setup();
    store.set_display_name(account, "  Ada L.  ").unwrap();
    assert_eq!(store.account(account).unwrap().unwrap().config.display_name, "Ada L.");
    assert!(store.account(account + 1).unwrap().is_none());
}

#[test]
fn signatures_have_one_for_new_mail_and_one_for_replies() {
    let (store, account, ..) = setup();
    let sig = |name: &str| Signature {
        account_id: account,
        name: name.into(),
        body: name.into(),
        ..Default::default()
    };
    let full = store.save_signature(&sig("Full")).unwrap();
    let short = store.save_signature(&sig("Short")).unwrap();
    let flags =
        || store.signatures().unwrap().iter().map(|s| (s.id, s.for_new, s.for_reply)).collect::<Vec<_>>();
    assert_eq!(flags(), [(full, true, true), (short, false, false)], "the first one goes on both");

    store.set_signature_default(account, true, Some(short)).unwrap();
    assert_eq!(flags(), [(full, true, false), (short, false, true)]);
    store.set_signature_default(account, false, None).unwrap();
    assert_eq!(flags(), [(full, false, false), (short, false, true)]);

    let rich = Signature { id: short, html: Some("<p><b>Short</b></p>".into()), ..sig("Brief") };
    store.save_signature(&rich).unwrap();
    let saved = store.signatures().unwrap().pop().unwrap();
    assert_eq!((saved.name.as_str(), saved.for_reply), ("Brief", true), "saving keeps where it goes");
    assert_eq!(saved.html, rich.html);
    store.delete_signature(full).unwrap();
    assert_eq!(store.signatures().unwrap().len(), 1);
}

#[test]
fn a_pasted_html_signature_is_kept_with_its_layout_and_cleaned() {
    let (store, account, ..) = setup();
    let pasted = r#"<table style="color:#1a4d8f"><tr><td><img src="https://example.com/logo.png" width="80"></td>
        <td><b>Ada Lovelace</b><br>Engines Ltd</td></tr></table><script>alert(1)</script>"#;
    let id = store
        .save_signature(&Signature {
            account_id: account,
            name: "Work".into(),
            body: "Ada Lovelace
Engines Ltd"
                .into(),
            html: Some(pasted.into()),
            custom: true,
            ..Default::default()
        })
        .unwrap();
    let saved = store.signatures().unwrap().into_iter().find(|s| s.id == id).unwrap();
    let html = saved.html.unwrap();
    assert!(saved.custom);
    assert!(html.contains("<table") && html.contains("color:#1a4d8f"), "layout and colour stay: {html}");
    assert!(html.contains("https://example.com/logo.png"), "the logo stays: {html}");
    assert!(!html.contains("script"), "nothing that runs: {html}");
}

#[test]
fn migration_23_keeps_signatures_as_they_were() {
    let (store, account, ..) = setup();
    let sig =
        Signature { account_id: account, name: "Full".into(), body: "Ada".into(), ..Default::default() };
    let id = store.save_signature(&sig).unwrap();
    let conn = store.conn.into_inner().unwrap();
    wind_back(&conn, 22);
    let store = Store::init(conn).unwrap();
    let kept = store.signatures().unwrap().into_iter().find(|s| s.id == id).unwrap();
    assert_eq!((kept.body.as_str(), kept.custom), ("Ada", false));
}

#[test]
fn migration_25_starts_ai_empty_and_keeps_answers_per_model() {
    let (store, account, ..) = setup();
    let conn = store.conn.into_inner().unwrap();
    wind_back(&conn, 24);
    let store = Store::init(conn).unwrap();
    assert_eq!(store.ai_cached("summary", "h", "m").unwrap(), None);
    store.ai_keep("summary", "h", "m", Some(account), "Short.").unwrap();
    assert_eq!(store.ai_cached("summary", "h", "m").unwrap().as_deref(), Some("Short."));
    assert_eq!(store.ai_cached("summary", "h", "other").unwrap(), None, "another model answers again");
    store.ai_spend(7, 100).unwrap();
    store.ai_spend(7, 20).unwrap();
    assert_eq!((store.ai_tokens(7).unwrap(), store.ai_tokens(8).unwrap()), (120, 0));
    assert_eq!(store.ai_clear_cache().unwrap(), 1);
    assert_eq!(store.ai_cached("summary", "h", "m").unwrap(), None);
    store.ai_keep("summary", "h", "m", Some(account), "Short.").unwrap();
    store.remove_account(account).unwrap();
    assert_eq!(store.ai_cached("summary", "h", "m").unwrap(), None, "an account's answers go with it");
}

#[test]
fn the_day_starts_with_who_waits_on_you_longest() {
    let (store, account, inbox, _) = setup();
    let sent = store.upsert_folder(account, "Sent", "sent").unwrap();
    let mut from_ana = message(1, "Contract", 100);
    from_ana.from_addr = "ana@x.com".into();
    let mut from_tom = message(2, "Numbers", 300);
    from_tom.from_addr = "tom@x.com".into();
    let mut answered = message(3, "Dinner", 200);
    answered.from_addr = "lejla@x.com".into();
    let mut list = message(4, "Weekly news", 400);
    list.from_addr = "news@shop.example".into();
    list.list_id = Some("news.shop.example".into());
    store.insert_messages(account, inbox, &[from_ana, from_tom, answered, list]).unwrap();
    // The person answered Lejla: the last word is theirs, so it waits on nobody.
    let mut reply = message(5, "Re: Dinner", 250);
    reply.from_addr = "me@example.com".into();
    reply.in_reply_to = Some("3@example.com".into());
    reply.references = vec!["3@example.com".into()];
    store.insert_messages(account, sent, &[reply]).unwrap();

    let start = store.day_start(150).unwrap();
    let waiting: Vec<&str> = start.need_you.iter().map(|t| t.latest.subject.as_str()).collect();
    assert_eq!(waiting, ["Contract", "Numbers"], "longest waiting first, not the answered one, not lists");
    assert_eq!(start.new_since, 3, "conversations with mail after `since`");
    assert_eq!(start.rest, 1, "the list mail is in Other");
    let reading: Vec<(&str, Option<i64>)> =
        start.to_read.iter().map(|r| (r.thread.latest.subject.as_str(), r.minutes)).collect();
    assert_eq!(reading, [("Weekly news", Some(1))], "a list that wrote since, about a minute long");
    store.read_later(&[start.need_you[1].latest.id], true, 160).unwrap();
    let shelf: Vec<String> =
        store.day_start(150).unwrap().to_read.iter().map(|r| r.thread.latest.subject.clone()).collect();
    assert_eq!(shelf, ["Numbers", "Weekly news"], "the Read later shelf comes first");
    store.read_later(&[start.need_you[1].latest.id], false, 170).unwrap();

    let ids: Vec<i64> = start.need_you.iter().map(|t| t.latest.id).collect();
    store.snooze(&ids[..1], 10_000, 160).unwrap();
    assert_eq!(store.day_start(150).unwrap().need_you.len(), 1, "a snoozed one waits out of sight");
    store.wake_snoozed(20_000).unwrap();
    let later = store.day_start(15_000).unwrap();
    assert_eq!(later.back.len(), 1, "it came back since the person was last here");
    assert!(store.day_start(25_000).unwrap().back.is_empty(), "and not before");
}

#[test]
fn arrivals_count_the_weeks_mail_wherever_it_went() {
    let (store, account, inbox, archive) = setup();
    let sent = store.upsert_folder(account, "Sent", "sent").unwrap();
    store.insert_messages(account, inbox, &[message(1, "New", 500), message(2, "Old", 50)]).unwrap();
    store.insert_messages(account, archive, &[message(3, "Done", 300)]).unwrap();
    // The same message under a second label counts once.
    let mut again = message(4, "Done", 300);
    again.message_id = Some("3@example.com".into());
    store.insert_messages(account, inbox, &[again]).unwrap();
    let mut mine = message(5, "Mine", 400);
    mine.from_addr = "me@example.com".into();
    store.insert_messages(account, sent, &[mine]).unwrap();
    let mut dates = store.arrivals(100).unwrap();
    dates.sort();
    assert_eq!(dates, [300, 500]);
}

#[test]
fn senders_are_counted_by_volume() {
    let (store, account, inbox, _) = setup();
    let news: Vec<_> = (1..=3)
        .map(|i| {
            let mut m = message(i, "Issue", 100 + i as i64);
            m.from_addr = "News@shop.example".into();
            m.from_name = "Shop".into();
            m.list_unsubscribe = Some("<https://shop.example/u>".into());
            m
        })
        .collect();
    store.insert_messages(account, inbox, &news).unwrap();
    store.insert_messages(account, inbox, &[message(4, "Hi", 150), message(5, "Old", 10)]).unwrap();
    let senders = store.senders(50, 10).unwrap();
    let got: Vec<(&str, i64, bool)> =
        senders.iter().map(|s| (s.addr.as_str(), s.count, s.list_unsubscribe.is_some())).collect();
    assert_eq!(got, [("news@shop.example", 3, true), ("ada@example.com", 1, false)]);
    store.set_split(&[senders[1].newest], true).unwrap();
    assert!(store.senders(50, 10).unwrap()[1].other, "moved to Other");
}

#[test]
fn migration_26_keeps_a_style_note_per_account() {
    let (store, account, inbox, _) = setup();
    let conn = store.conn.into_inner().unwrap();
    wind_back(&conn, 25);
    let store = Store::init(conn).unwrap();
    assert_eq!(store.ai_style(account).unwrap(), None);
    store.set_ai_style(account, "- Short.", 12).unwrap();
    store.set_ai_style(account, "- Short and warm.", 12).unwrap();
    let style = store.ai_style(account).unwrap().unwrap();
    assert_eq!((style.note.as_str(), style.samples), ("- Short and warm.", 12));
    let mine = NewMessage { from_addr: "ME@example.com".into(), ..message(1, "sent", 10) };
    store.insert_messages(account, inbox, &[mine, message(2, "theirs", 20)]).unwrap();
    assert_eq!(store.own_texts(account, "me@example.com", 10).unwrap().len(), 1, "only what they wrote");
    store.delete_ai_style(account).unwrap();
    assert_eq!(store.ai_style(account).unwrap(), None);
}

#[test]
fn migration_27_keeps_marks_by_message_id() {
    let (store, account, inbox, _) = setup();
    let conn = store.conn.into_inner().unwrap();
    wind_back(&conn, 26);
    let store = Store::init(conn).unwrap();
    store.insert_messages(account, inbox, &[message(1, "Contract", 10), message(2, "Other", 20)]).unwrap();
    let ids: Vec<i64> = {
        let conn = store.conn();
        let mut stmt = conn.prepare("SELECT id FROM messages WHERE account_id = ?1 ORDER BY date").unwrap();
        stmt.query_map([account], |r| r.get(0)).unwrap().map(Result::unwrap).collect()
    };
    let mark = store.add_mark(ids[0], "two months", "").unwrap();
    store.add_mark(ids[1], "elsewhere", "").unwrap();
    store.set_mark_note(mark.id, "Check with legal").unwrap();
    let marks = store.marks(&ids[..1]).unwrap();
    assert_eq!(marks.len(), 1, "only the marks on the messages asked for");
    assert_eq!(
        (marks[0].text.as_str(), marks[0].note.as_str(), marks[0].message),
        ("two months", "Check with legal", ids[0])
    );
    store.delete_mark(mark.id).unwrap();
    assert!(store.marks(&ids[..1]).unwrap().is_empty());
    assert!(store.add_mark(-1, "gone", "").is_err());
}

#[test]
fn migration_28_shelves_conversations_until_taken_off_or_answered() {
    let (store, account, inbox, _) = setup();
    let conn = store.conn.into_inner().unwrap();
    wind_back(&conn, 27);
    let store = Store::init(conn).unwrap();
    store.insert_messages(account, inbox, &[message(1, "Issue 112", 100), message(2, "Lunch", 200)]).unwrap();
    let list = |role: &str| -> Vec<String> {
        let rows = store.list_threads(&ListTarget::Role(role.into()), None, 9).unwrap();
        rows.into_iter().map(|t| t.latest.subject).collect()
    };
    let issue = store.list_threads(&ListTarget::Role("inbox".into()), None, 9).unwrap()[1].latest.id;
    store.read_later(&[issue], true, 300).unwrap();
    assert_eq!(list("inbox"), ["Lunch"], "off the inbox's lists");
    assert_eq!(list(LATER), ["Issue 112"]);
    let (important, other) = store.split_unread().unwrap();
    assert_eq!(important + other, 1, "unread counts leave it out");
    store.read_later(&[issue], false, 400).unwrap();
    assert_eq!(list(LATER), Vec::<String>::new(), "taken off");
    assert_eq!(list("inbox").len(), 2);
    store.read_later(&[issue], true, 500).unwrap();
    let reply = NewMessage { in_reply_to: Some("1@example.com".into()), ..message(3, "Re: Issue 112", 600) };
    store.insert_messages(account, inbox, &[reply]).unwrap();
    assert_eq!(list(LATER), Vec::<String>::new(), "a reply from someone else brings it back");
}

#[test]
fn marks_list_and_search_find_marked_conversations() {
    let (store, account, inbox, _) = setup();
    store.insert_messages(account, inbox, &[message(1, "Issue 112", 100), message(2, "Lunch", 200)]).unwrap();
    let rows = store.list_threads(&ListTarget::Role("inbox".into()), None, 9).unwrap();
    let issue = rows.iter().find(|t| t.latest.subject == "Issue 112").unwrap().latest.id;
    assert!(store.list_threads(&ListTarget::Role(MARKED.into()), None, 9).unwrap().is_empty());
    let mark = store.add_mark(issue, "the deadline moved", "").unwrap();
    store.set_mark_note(mark.id, "Ask Ada about Friday").unwrap();
    let marked = store.list_threads(&ListTarget::Role(MARKED.into()), None, 9).unwrap();
    assert_eq!(marked.len(), 1);
    assert_eq!(marked[0].latest.subject, "Issue 112");
    assert_eq!(marked[0].latest.snippet, "\u{201c}the deadline moved\u{201d} Ask Ada about Friday");
    let subjects = |q: &str| -> Vec<String> {
        store.search(q, 10).unwrap().rows.into_iter().map(|r| r.subject).collect()
    };
    assert_eq!(subjects("is:marked"), ["Issue 112"]);
    assert_eq!(subjects("-is:marked"), ["Lunch"]);
    assert_eq!(subjects("has:note"), ["Issue 112"]);
    let lunch = rows.iter().find(|t| t.latest.subject == "Lunch").unwrap().latest.id;
    store.add_mark(lunch, "the usual place", "").unwrap();
    assert_eq!(subjects("has:mark").len(), 2);
    assert_eq!(subjects("has:note"), ["Issue 112"], "a mark without a note is not a note");
    assert_eq!(subjects("-has:note"), ["Lunch"]);
    assert_eq!(subjects("ada friday"), ["Issue 112"], "words in a note");
    assert_eq!(subjects("deadline is:unread"), ["Issue 112"], "words in a mark, with filters");
    assert!(subjects("deadline is:read").is_empty());
}

#[test]
fn mark_all_read_takes_every_unread_message_in_the_list_and_undoes() {
    let (store, account, inbox, archive) = setup();
    store.insert_messages(account, inbox, &[message(1, "One", 100), message(2, "Two", 200)]).unwrap();
    store.insert_messages(account, archive, &[message(3, "Elsewhere", 300)]).unwrap();
    let ids = store.unread_ids(&ListTarget::Role("inbox".into())).unwrap();
    assert_eq!(ids.len(), 2, "the inbox's, not the archive's");
    let applied = store.apply(&ids, Action::MarkRead, 5).unwrap();
    assert!(store.unread_ids(&ListTarget::Role("inbox".into())).unwrap().is_empty());
    assert_eq!(store.unread_ids(&ListTarget::Folder(archive)).unwrap().len(), 1);
    assert!(store.undo(&applied.token).unwrap());
    assert_eq!(store.unread_ids(&ListTarget::Role("inbox".into())).unwrap().len(), 2);
}

#[test]
fn search_finds_snoozed_conversations() {
    let (store, account, inbox, _) = setup();
    store.insert_messages(account, inbox, &[message(1, "Tickets", 100), message(2, "Lunch", 200)]).unwrap();
    let subjects = |q: &str| -> Vec<String> {
        store.search(q, 10).unwrap().rows.into_iter().map(|r| r.subject).collect()
    };
    assert!(subjects("is:snoozed").is_empty());
    let rows = store.list_threads(&ListTarget::Role("inbox".into()), None, 9).unwrap();
    let tickets = rows.iter().find(|t| t.latest.subject == "Tickets").unwrap().latest.id;
    store.snooze(&[tickets], 10_000, 300).unwrap();
    assert_eq!(subjects("is:snoozed"), ["Tickets"]);
    assert_eq!(subjects("-is:snoozed"), ["Lunch"]);
    store.unsnooze(&[tickets]).unwrap();
    assert!(subjects("is:snoozed").is_empty());
}

#[test]
fn search_says_when_bodies_were_not_all_searched() {
    let (store, account, inbox, _) = setup();
    let headers = NewMessage { headers_only: true, body_text: None, ..message(1, "Plans", 1) };
    store.insert_messages(account, inbox, &[headers]).unwrap();
    assert!(store.search("plans", 10).unwrap().partial);
    assert!(!store.search("is:unread", 10).unwrap().partial, "no words, nothing missed");
}

#[test]
fn threads_replies_that_arrive_first() {
    let (store, account, inbox, _) = setup();
    let mut reply = message(2, "Re: plan", 200);
    reply.in_reply_to = Some("1@example.com".into());
    reply.references = vec!["1@example.com".into()];
    store.insert_messages(account, inbox, &[reply]).unwrap();
    store.insert_messages(account, inbox, &[message(1, "plan", 100)]).unwrap();

    let rows = store.list(&ListTarget::Folder(inbox), None, 10).unwrap();
    assert_eq!(rows[0].thread_id, rows[1].thread_id);
    assert_eq!(store.thread(rows[0].id).unwrap().len(), 2);
}

#[test]
fn archive_shows_at_once_and_undoes() {
    let (store, account, inbox, archive) = setup();
    store.insert_messages(account, inbox, &[message(1, "a", 1), message(2, "b", 2)]).unwrap();
    let id = store.list(&ListTarget::Folder(inbox), None, 10).unwrap()[0].id;

    let applied = store.apply(&[id], Action::Archive, 5).unwrap();
    assert_eq!(store.list(&ListTarget::Folder(inbox), None, 10).unwrap().len(), 1);
    assert_eq!(store.list(&ListTarget::Folder(archive), None, 10).unwrap().len(), 1);
    // Sync must not bring it back to the inbox while the move is queued.
    assert!(store.pending_uids(account, "INBOX").unwrap().contains(&2));

    assert!(store.undo(&applied.token).unwrap());
    assert_eq!(store.list(&ListTarget::Folder(inbox), None, 10).unwrap().len(), 2);
    assert!(store.pending_uids(account, "INBOX").unwrap().is_empty());
}

#[test]
fn moved_message_gets_its_new_uid_from_sync() {
    let (store, account, inbox, archive) = setup();
    store.insert_messages(account, inbox, &[message(1, "a", 1)]).unwrap();
    let id = store.list(&ListTarget::Folder(inbox), None, 10).unwrap()[0].id;
    store.apply(&[id], Action::Archive, 0).unwrap();
    for (op_id, _) in store.claim_due(account).unwrap() {
        store.outbox_done(op_id).unwrap();
    }
    // The archive's sync sees the message under the uid the server gave it there.
    store
        .insert_messages(
            account,
            archive,
            &[message(40, "a", 1)].map(|mut m| {
                m.message_id = Some("1@example.com".into());
                m
            }),
        )
        .unwrap();
    let rows = store.list(&ListTarget::Folder(archive), None, 10).unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].id, id);
    assert!(store.local_uids(archive).unwrap().contains(&40));
}

#[test]
fn flags_apply_and_failed_work_waits() {
    let (store, account, inbox, _) = setup();
    store.insert_messages(account, inbox, &[message(1, "a", 1)]).unwrap();
    let id = store.list(&ListTarget::Folder(inbox), None, 10).unwrap()[0].id;
    store.apply(&[id], Action::MarkRead, 0).unwrap();
    assert!(store.list(&ListTarget::Folder(inbox), None, 10).unwrap()[0].seen);

    let due = store.claim_due(account).unwrap();
    assert_eq!(due.len(), 1);
    assert!(store.claim_due(account).unwrap().is_empty(), "claimed work is not handed out twice");
    store.outbox_failed(due[0].0, "offline", Failure::Retry).unwrap();
    assert!(store.next_due(account).unwrap().unwrap() > now());
}

/// Marks the inbox's one message read and returns the queued work's id.
fn queued_mark_read(store: &Store, account: i64, inbox: i64) -> i64 {
    store.insert_messages(account, inbox, &[message(1, "a", 1)]).unwrap();
    let id = store.list(&ListTarget::Folder(inbox), None, 10).unwrap()[0].id;
    store.apply(&[id], Action::MarkRead, 0).unwrap();
    store.claim_due(account).unwrap()[0].0
}

#[test]
fn a_permanent_refusal_stops_retrying_at_once() {
    let (store, account, inbox, _) = setup();
    let work = queued_mark_read(&store, account, inbox);
    store.outbox_failed(work, "550 no such mailbox", Failure::Permanent).unwrap();
    assert_eq!(store.next_due(account).unwrap(), None, "given-up work is not scheduled");
    let problems = store.outbox_problems().unwrap();
    assert_eq!(
        (problems[0].id, problems[0].what.as_str(), problems[0].attempts),
        (work, "Mark read 1 message", 1)
    );
    assert!(problems[0].last_error.contains("550"));
}

#[test]
fn transient_failures_give_up_after_max_attempts() {
    let (store, account, inbox, _) = setup();
    let work = queued_mark_read(&store, account, inbox);
    for _ in 1..MAX_ATTEMPTS {
        store.outbox_failed(work, "timed out", Failure::Retry).unwrap();
        assert!(store.outbox_problems().unwrap().is_empty());
    }
    store.outbox_failed(work, "timed out", Failure::Retry).unwrap();
    assert_eq!(store.outbox_problems().unwrap().len(), 1);
    // Never dropped: the row is still there, just no longer tried.
    let rows: i64 = store.conn().query_row("SELECT COUNT(*) FROM outbox", [], |r| r.get(0)).unwrap();
    assert_eq!(rows, 1);
}

#[test]
fn retry_puts_given_up_work_back_in_the_queue() {
    let (store, account, inbox, _) = setup();
    let work = queued_mark_read(&store, account, inbox);
    store.outbox_failed(work, "550", Failure::Permanent).unwrap();
    store.retry_outbox(work).unwrap();
    assert!(store.outbox_problems().unwrap().is_empty());
    assert_eq!(store.claim_due(account).unwrap()[0].0, work);
}

#[test]
fn discard_drops_given_up_work_and_reverts_the_local_change() {
    let (store, account, inbox, _) = setup();
    let work = queued_mark_read(&store, account, inbox);
    store.outbox_failed(work, "550", Failure::Permanent).unwrap();
    store.discard_outbox(work).unwrap();
    assert!(store.outbox_problems().unwrap().is_empty());
    assert!(!store.list(&ListTarget::Folder(inbox), None, 10).unwrap()[0].seen, "back to unread");
    assert!(store.pending_uids(account, "INBOX").unwrap().is_empty(), "sync may update it again");
}

#[test]
fn waiting_work_is_listed_until_it_goes_or_is_given_up() {
    let (store, account, inbox, _) = setup();
    let work = queued_mark_read(&store, account, inbox);
    let waiting = store.outbox_waiting().unwrap();
    assert_eq!((waiting[0].id, waiting[0].what.as_str()), (work, "Mark read 1 message"));
    assert!(waiting[0].sending && !waiting[0].can_discard, "claimed: in hand, so not discardable");
    store.outbox_failed(work, "timed out", Failure::Retry).unwrap();
    let waiting = store.outbox_waiting().unwrap();
    assert_eq!((waiting[0].attempts, waiting[0].last_error.as_str()), (1, "timed out"));
    assert!(!waiting[0].sending && waiting[0].can_discard);
    assert!(waiting[0].not_before > now(), "waits before the next try");
    store.outbox_failed(work, "550", Failure::Permanent).unwrap();
    assert!(store.outbox_waiting().unwrap().is_empty(), "a problem now, not waiting");
}

#[test]
fn discarding_waiting_work_reverts_it_even_after_a_failed_try() {
    let (store, account, inbox, _) = setup();
    let work = queued_mark_read(&store, account, inbox);
    assert!(!store.discard_waiting(work).unwrap(), "not while it is being sent");
    store.outbox_failed(work, "timed out", Failure::Retry).unwrap();
    assert!(!store.undo(&[work]).unwrap(), "undo is for the undo window only");
    assert!(store.discard_waiting(work).unwrap());
    assert!(store.outbox_waiting().unwrap().is_empty());
    assert!(!store.list(&ListTarget::Folder(inbox), None, 10).unwrap()[0].seen, "back to unread");
}

#[test]
fn waiting_work_that_later_work_depends_on_cannot_be_discarded() {
    let (store, account, inbox, _) = setup();
    store.insert_messages(account, inbox, &[message(1, "a", 1)]).unwrap();
    let id = store.list(&ListTarget::Folder(inbox), None, 1).unwrap()[0].id;
    let archived = store.apply(&[id], Action::Archive, 5).unwrap().token;
    store.apply(&[id], Action::Star, 5).unwrap();
    let waiting = store.outbox_waiting().unwrap();
    assert_eq!(waiting.len(), 2);
    assert!(!waiting[0].can_discard && waiting[1].can_discard, "the star waits for the move");
    assert!(!store.discard_waiting(archived[0]).unwrap());
    assert_eq!(store.outbox_waiting().unwrap().len(), 2);
}

#[test]
fn released_claims_are_handed_out_again() {
    let (store, account, inbox, _) = setup();
    let work = queued_mark_read(&store, account, inbox);
    store.release_claims(account).unwrap();
    assert_eq!(store.claim_due(account).unwrap()[0].0, work);
}

#[test]
fn subjects_compare_without_prefixes_and_tags() {
    assert_eq!(subject_norm("Re: RE: Fwd: Lunch?").as_deref(), Some("lunch?"));
    assert_eq!(subject_norm("AW: [team] Re[2]:  Budget   2027").as_deref(), Some("budget 2027"));
    assert_eq!(subject_norm("Rebooking"), Some("rebooking".into()), "a word, not a prefix");
    assert_eq!(subject_norm("Re: "), None);
    assert_eq!(subject_norm(""), None);
}

fn mail(uid: u32, subject: &str, date: i64, from: &str, to: &str) -> NewMessage {
    NewMessage {
        uid,
        message_id: Some(format!("{uid}@example.com")),
        subject: subject.into(),
        from_name: from.split('@').next().unwrap().into(),
        from_addr: from.into(),
        to_addrs: to.into(),
        date,
        ..Default::default()
    }
}

#[test]
fn mail_without_references_joins_by_subject_and_people() {
    let (store, account, inbox, _) = setup();
    let day = 86_400;
    store
        .insert_messages(
            account,
            inbox,
            &[
                mail(1, "Lunch?", day, "ada@x.com", "me@example.com"),
                // A reply from a client that sends no References, two days later.
                mail(2, "Re: Lunch?", 3 * day, "me@example.com", "ada@x.com"),
                // Same subject, someone else entirely: its own conversation.
                mail(3, "Lunch?", 3 * day, "bob@y.com", "me@example.com"),
                // Same people, but weeks later: its own conversation.
                mail(4, "Re: Lunch?", 30 * day, "ada@x.com", "me@example.com"),
            ],
        )
        .unwrap();
    let rows = store.list(&ListTarget::Folder(inbox), None, 10).unwrap();
    let thread = |uid: u32| rows.iter().find(|r| r.subject.contains("Lunch") && r.id == uid as i64).unwrap();
    let t: Vec<&str> = (1..=4).map(|u| thread(u).thread_id.as_str()).collect();
    assert_eq!(t[0], t[1]);
    assert_ne!(t[0], t[2]);
    assert_ne!(t[0], t[3]);
}

#[test]
fn a_store_on_disk_reads_what_it_wrote_on_its_second_connection() {
    let dir = std::env::temp_dir().join(format!("tern-reader-{}-{}", std::process::id(), now()));
    std::fs::create_dir_all(&dir).unwrap();
    let store = Store::open(&dir.join("mail.db")).unwrap();
    assert!(store.reader.is_some());
    let account = store.add_account(&config()).unwrap().id;
    let inbox = store.upsert_folder(account, "INBOX", "inbox").unwrap();
    store.insert_messages(account, inbox, &[message(1, "zeppelin", 100)]).unwrap();
    assert_eq!(store.folders().unwrap().len(), 1);
    assert_eq!(store.list_threads(&ListTarget::Folder(inbox), None, 10).unwrap().len(), 1);
    assert_eq!(store.search("zeppelin", 10).unwrap().rows.len(), 1);
    store.tidy_on_exit().unwrap();
    drop(store);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn removing_an_account_takes_its_mail_and_search_with_it() {
    let (store, account, inbox, _) = setup();
    store.insert_messages(account, inbox, &[message(1, "zeppelin", 100)]).unwrap();
    assert_eq!(store.search("zeppelin", 10).unwrap().rows.len(), 1);
    store.remove_account(account).unwrap();
    assert!(store.accounts().unwrap().is_empty());
    assert!(store.folders().unwrap().is_empty());
    assert!(store.search("zeppelin", 10).unwrap().rows.is_empty());
    let left: i64 = store.conn().query_row("SELECT count(*) FROM messages", [], |r| r.get(0)).unwrap();
    assert_eq!(left, 0);
}

#[test]
fn list_mail_with_one_subject_stays_apart() {
    let (store, account, inbox, _) = setup();
    let day = 86_400;
    let weekly = |uid: u32, date: i64| NewMessage {
        list_id: Some("<report.example.com>".into()),
        ..mail(uid, "Weekly report", date, "reports@example.com", "me@example.com")
    };
    let alert = |uid: u32, date: i64| NewMessage {
        precedence_bulk: true,
        ..mail(uid, "Disk almost full", date, "alerts@example.com", "me@example.com")
    };
    store
        .insert_messages(
            account,
            inbox,
            &[weekly(1, day), weekly(2, 7 * day), alert(3, day), alert(4, 2 * day)],
        )
        .unwrap();
    let rows = store.list(&ListTarget::Folder(inbox), None, 10).unwrap();
    let thread = |uid: i64| rows.iter().find(|r| r.id == uid).unwrap().thread_id.clone();
    assert_ne!(thread(1), thread(2));
    assert_ne!(thread(3), thread(4));
}

#[test]
fn thread_list_pages_by_conversation() {
    let (store, account, inbox, archive) = setup();
    let reply = |uid: u32, parent: u32, date: i64, seen: bool| NewMessage {
        in_reply_to: Some(format!("{parent}@example.com")),
        seen,
        ..message(uid, &format!("re {parent}"), date)
    };
    let batch = vec![
        message(1, "a", 10),
        message(2, "b", 20),
        message(3, "c", 30),
        reply(4, 1, 40, false), // a's conversation becomes the newest
        reply(5, 2, 25, true),
    ];
    store.insert_messages(account, inbox, &batch).unwrap();
    // The archived copy of a still counts once in its conversation, as another message would.
    store.insert_messages(account, archive, &[reply(6, 1, 15, true)]).unwrap();

    let page = store.list_threads(&ListTarget::Folder(inbox), None, 2).unwrap();
    let firsts: Vec<_> = page.iter().map(|t| (t.latest.date, t.count)).collect();
    assert_eq!(firsts, [(40, 3), (30, 1)]);
    assert_eq!(page[0].unread, 2, "the first message and the new reply");
    let cursor = Cursor { date: page[1].latest.date, id: page[1].latest.id };
    let next = store.list_threads(&ListTarget::Folder(inbox), Some(cursor), 2).unwrap();
    let dates: Vec<_> = next.iter().map(|t| (t.latest.date, t.count)).collect();
    assert_eq!(dates, [(25, 2)], "b's conversation, once, by its newest message; a is not repeated");
    assert!(store
        .list_threads(&ListTarget::Folder(inbox), Some(Cursor { date: 25, id: next[0].latest.id }), 2)
        .unwrap()
        .is_empty());
}

#[test]
fn actions_on_a_conversation_reach_the_right_messages() {
    let (store, account, inbox, archive) = setup();
    let reply = |uid: u32, date: i64, flagged: bool| NewMessage {
        in_reply_to: Some("1@example.com".into()),
        flagged,
        ..message(uid, "re a", date)
    };
    store
        .insert_messages(account, inbox, &[message(1, "a", 10), reply(2, 20, true), message(3, "b", 5)])
        .unwrap();
    store.insert_messages(account, archive, &[reply(4, 15, true)]).unwrap();
    let rows = store.list_threads(&ListTarget::Folder(inbox), None, 10).unwrap();
    let newest = rows[0].latest.id;
    let ids = |action| {
        let mut ids = store.conversation_ids(&[newest], action, &ListTarget::Folder(inbox)).unwrap();
        ids.sort();
        ids
    };
    assert_eq!(ids(Action::Archive), [1, 2], "only what is in the inbox");
    assert_eq!(ids(Action::MarkRead), [1, 2, 4], "the whole conversation");
    assert_eq!(ids(Action::Unstar), [2, 4], "every star in it");
    assert_eq!(ids(Action::Star), [newest]);
    assert_eq!(rows[0].participants, ["Ada"]);
}

#[test]
fn migration_10_cleans_stored_html() {
    let store = Store::open_in_memory().unwrap();
    let account = store.add_account(&config()).unwrap().id;
    let inbox = store.upsert_folder(account, "INBOX", "inbox").unwrap();
    store.insert_messages(account, inbox, &[message(1, "a", 1)]).unwrap();
    let conn = store.conn.into_inner().unwrap();
    conn.execute("UPDATE bodies SET html = '<p onclick=\"x()\">hi</p><script>bad()</script>'", []).unwrap();
    wind_back(&conn, 9);
    let store = Store::init(conn).unwrap();
    let html: String = store.conn().query_row("SELECT html FROM bodies", [], |r| r.get(0)).unwrap();
    assert_eq!(html, "<p>hi</p>");
}

#[test]
fn a_conversation_lists_its_attachments() {
    let (store, account, inbox, _) = setup();
    let raw = b"From: a@x.com\r\nSubject: report\r\nMessage-ID: <r@x.com>\r\nMIME-Version: 1.0\r\n\
Content-Type: multipart/mixed; boundary=\"b\"\r\n\r\n--b\r\nContent-Type: text/plain\r\n\r\nSee attached.\r\n\
--b\r\nContent-Type: application/pdf; name=\"q3.pdf\"\r\nContent-Disposition: attachment; filename=\"q3.pdf\"\r\n\
Content-Transfer-Encoding: base64\r\n\r\nJVBERi0xLjQK\r\n--b--\r\n";
    let m = crate::mime::parse(1, raw, false, false).unwrap();
    store.insert_messages(account, inbox, &[m]).unwrap();
    let id = store.list(&ListTarget::Folder(inbox), None, 1).unwrap()[0].id;
    let files = &store.thread(id).unwrap()[0].attachments;
    assert_eq!(files.len(), 1);
    assert_eq!((files[0].name.as_str(), files[0].mime.as_str()), ("q3.pdf", "application/pdf"));
}

#[test]
fn moves_to_any_folder_junk_and_back_to_the_inbox() {
    let (store, account, inbox, archive) = setup();
    let junk = store.upsert_folder(account, "Junk", "junk").unwrap();
    store.insert_messages(account, inbox, &[message(1, "a", 1)]).unwrap();
    let id = store.list(&ListTarget::Folder(inbox), None, 1).unwrap()[0].id;
    store.apply(&[id], Action::Junk, 5).unwrap();
    assert_eq!(store.list(&ListTarget::Folder(junk), None, 5).unwrap().len(), 1);
    store.apply(&[id], Action::MoveTo(archive), 5).unwrap();
    assert_eq!(store.list(&ListTarget::Folder(archive), None, 5).unwrap().len(), 1);
    store.apply(&[id], Action::Inbox, 5).unwrap();
    assert_eq!(store.list(&ListTarget::Folder(inbox), None, 5).unwrap().len(), 1);
    let other = store.add_account(&AccountConfig { email: "b@x".into(), ..config() }).unwrap().id;
    let theirs = store.upsert_folder(other, "Archive", "archive").unwrap();
    let applied = store.apply(&[id], Action::MoveTo(theirs), 5).unwrap();
    assert!(applied.token.is_empty(), "no move across accounts");
}

#[test]
fn muted_conversations_skip_the_inbox() {
    let (store, account, inbox, archive) = setup();
    store.insert_messages(account, inbox, &[message(1, "a", 1)]).unwrap();
    let id = store.list(&ListTarget::Folder(inbox), None, 1).unwrap()[0].id;
    store.mute(&[id], true).unwrap();
    assert!(store.muted(id).unwrap());
    let reply = NewMessage { in_reply_to: Some("1@example.com".into()), ..message(2, "re a", 2) };
    store.insert_messages(account, inbox, &[reply, message(3, "other", 3)]).unwrap();
    assert!(store.archive_muted(inbox).unwrap());
    let left: Vec<String> =
        store.list(&ListTarget::Folder(inbox), None, 9).unwrap().into_iter().map(|r| r.subject).collect();
    assert_eq!(left, ["other"]);
    assert_eq!(store.list(&ListTarget::Folder(archive), None, 9).unwrap().len(), 2);
    store.mute(&[id], false).unwrap();
    assert!(!store.muted(id).unwrap());
}

#[test]
fn new_mail_is_unread_recent_inbox_mail_from_others() {
    let (store, account, inbox, archive) = setup();
    store.insert_messages(account, inbox, &[message(1, "old", 100)]).unwrap();
    let (mark, none) = store.new_mail(0, 1_000, false).unwrap();
    assert!(none.is_empty(), "too old to be news");
    let mine = NewMessage { from_addr: "Me@Example.com".into(), ..message(2, "mine", 2_000) };
    let read = NewMessage { seen: true, ..message(3, "read", 2_000) };
    store.insert_messages(account, inbox, &[message(4, "news", 2_000), mine, read]).unwrap();
    store.insert_messages(account, archive, &[message(5, "elsewhere", 2_000)]).unwrap();
    let (next, mail) = store.new_mail(mark, 1_000, false).unwrap();
    assert_eq!(mail.iter().map(|m| m.subject.as_str()).collect::<Vec<_>>(), ["news"]);
    assert!(store.new_mail(next, 1_000, false).unwrap().1.is_empty(), "each message is news once");
    assert_eq!(store.inbox_unread().unwrap(), 3);
    assert_eq!(store.accounts_with_mail().unwrap(), [account]);
    store.mute(&[mail[0].id], true).unwrap();
    assert!(store.new_mail(mark, 1_000, false).unwrap().1.is_empty(), "muted");
}

fn mail_to_me(uid: u32, from: &str, to: &str, cc: &str) -> NewMessage {
    NewMessage {
        uid,
        message_id: Some(format!("{uid}@example.com")),
        references: vec!["0@example.com".into()],
        subject: "Plan".into(),
        from_name: "Ada".into(),
        from_addr: from.into(),
        to_addrs: to.into(),
        cc_addrs: cc.into(),
        date: 100,
        body_text: Some("See you.".into()),
        ..Default::default()
    }
}

#[test]
fn replies_go_to_the_right_people() {
    let (store, account, inbox, _) = setup();
    let me = "me@example.com";
    let mut with_reply_to = mail_to_me(2, "ada@x.com", me, "");
    with_reply_to.reply_to = "list@x.com".into();
    let mut followup = mail_to_me(3, "ada@x.com", &format!("{me}, bob@x.com"), "");
    followup.followup_to = "team@x.com".into();
    store
        .insert_messages(
            account,
            inbox,
            &[
                mail_to_me(1, "ada@x.com", &format!("{me}, bob@x.com"), "carl@x.com, ME@example.com"),
                with_reply_to,
                followup,
                mail_to_me(4, me, "ada@x.com, bob@x.com", "carl@x.com"),
            ],
        )
        .unwrap();
    let id = |uid: u32| {
        store
            .list(&ListTarget::Folder(inbox), None, 9)
            .unwrap()
            .into_iter()
            .find(|r| r.id == uid as i64)
            .unwrap()
            .id
    };
    let r = |uid, kind| store.reply_init(id(uid), kind).unwrap();

    let reply = r(1, ReplyKind::Reply);
    assert_eq!((reply.to.clone(), reply.cc.clone()), (vec!["ada@x.com".to_string()], vec![]));
    assert_eq!(reply.subject, "Re: Plan");
    assert_eq!(reply.in_reply_to.as_deref(), Some("1@example.com"));
    assert_eq!(reply.references, ["0@example.com", "1@example.com"]);
    assert_eq!(reply.quote_text, "See you.");

    let all = r(1, ReplyKind::ReplyAll);
    assert_eq!(all.to, ["ada@x.com"]);
    assert_eq!(all.cc, ["bob@x.com", "carl@x.com"], "everyone else, never me (any case)");

    assert_eq!(r(2, ReplyKind::Reply).to, ["list@x.com"], "Reply-To wins");
    let f = r(3, ReplyKind::ReplyAll);
    assert_eq!((f.to, f.cc), (vec!["team@x.com".to_string()], vec![]), "Mail-Followup-To wins for reply-all");

    let mine = r(4, ReplyKind::ReplyAll);
    assert_eq!(
        (mine.to, mine.cc),
        (vec!["ada@x.com".into(), "bob@x.com".into()], vec!["carl@x.com".to_string()])
    );
    assert_eq!(
        r(4, ReplyKind::Reply).to,
        ["ada@x.com", "bob@x.com"],
        "replying to my own mail goes on to them"
    );

    let fwd = r(1, ReplyKind::Forward);
    assert!(fwd.to.is_empty() && fwd.in_reply_to.is_none() && fwd.references.is_empty());
    assert_eq!(fwd.subject, "Fwd: Plan");
}

fn draft_to(subject: &str) -> Draft {
    Draft {
        html: None,
        to: vec!["b@x".into()],
        cc: vec![],
        bcc: vec![],
        subject: subject.into(),
        body: "first words".into(),
        in_reply_to: None,
        references: vec![],
        attachments: vec![],
        forward_of: None,
        message_id: None,
        html_signature: None,
        out_body: None,
        out_html: None,
    }
}

#[test]
fn a_draft_shows_in_drafts_and_in_its_conversation() {
    let (store, account, inbox, _) = setup();
    let drafts = store.upsert_folder(account, "Drafts", "drafts").unwrap();
    store.insert_messages(account, inbox, &[message(1, "plan", 10)]).unwrap();
    let original = store.list(&ListTarget::Folder(inbox), None, 1).unwrap()[0].id;

    let reply = Draft { in_reply_to: Some("1@example.com".into()), ..draft_to("Re: plan") };
    let id = store.save_draft(None, account, reply.clone(), false).unwrap();
    let again =
        store.save_draft(Some(id), account, Draft { body: "more words".into(), ..reply }, false).unwrap();
    assert_eq!(id, again);
    let rows = store.list(&ListTarget::Folder(drafts), None, 9).unwrap();
    assert_eq!(rows.len(), 1, "one row however often it is saved");
    assert_eq!(rows[0].snippet, "more words");
    let conversation = store.thread(original).unwrap();
    assert_eq!(conversation.len(), 2, "the draft sits in the conversation it answers");
    assert_eq!(conversation[1].draft_id, Some(id));
    assert_eq!(store.draft_for_message(rows[0].id).unwrap().unwrap().id, id);

    store.discard_draft(id).unwrap();
    assert!(store.list(&ListTarget::Folder(drafts), None, 9).unwrap().is_empty());
    assert!(store.undo_discard(id).unwrap());
    assert_eq!(store.list(&ListTarget::Folder(drafts), None, 9).unwrap().len(), 1);
    store.draft_sent(id).unwrap();
    assert!(store.list(&ListTarget::Folder(drafts), None, 9).unwrap().is_empty());
}

#[test]
fn drafts_go_to_the_server_when_they_rest_and_leave_when_sent() {
    let (store, account, _, _) = setup();
    store.upsert_folder(account, "Drafts", "drafts").unwrap();
    let id = store.save_draft(None, account, draft_to("hi"), false).unwrap();
    assert!(store.drafts_due(account).unwrap().is_empty(), "still being typed");
    store.save_draft(Some(id), account, draft_to("hi"), true).unwrap();
    let due = store.drafts_due(account).unwrap();
    let DraftSync::Upload { version, previous, .. } = &due[0] else { panic!("{due:?}") };
    assert!(previous.is_none());
    store.draft_uploaded(id, "Drafts", *version, Some((7, 41))).unwrap();
    assert!(store.drafts_due(account).unwrap().is_empty(), "this version is up");

    let draft = store.draft(id).unwrap().unwrap().draft;
    store.queue_send(account, draft, 5).unwrap();
    store.draft_sent(id).unwrap();
    assert!(store.drafts_due(account).unwrap().is_empty(), "its copy stays while the send waits");
    let work = store.claim_due(account).unwrap();
    assert!(work.is_empty(), "still in the undo window");
    store.conn().execute("DELETE FROM outbox", []).unwrap();
    let due = store.drafts_due(account).unwrap();
    assert!(matches!(&due[0], DraftSync::Remove { copy: Some((7, 41)), .. }), "{due:?}");
}

#[test]
fn deleting_a_draft_from_drafts_discards_it_instead_of_queueing_server_work() {
    let (store, account, _, _) = setup();
    let drafts = store.upsert_folder(account, "Drafts", "drafts").unwrap();
    let id = store.save_draft(None, account, draft_to("hi"), false).unwrap();
    let row = store.list(&ListTarget::Folder(drafts), None, 9).unwrap()[0].id;

    let starred = store.apply(&[row], Action::Star, 5).unwrap();
    let archived = store.apply(&[row], Action::Archive, 5).unwrap();
    assert!(starred.token.is_empty() && archived.token.is_empty(), "the server has no copy to act on");
    assert_eq!(store.list(&ListTarget::Folder(drafts), None, 9).unwrap().len(), 1, "left where it is");

    let trashed = store.apply(&[row], Action::Trash, 5).unwrap();
    assert!(trashed.token.is_empty());
    assert_eq!(trashed.drafts, [id]);
    assert!(store.list(&ListTarget::Folder(drafts), None, 9).unwrap().is_empty());
    assert!(store.outbox_waiting().unwrap().is_empty());
    assert!(store.undo_discard(id).unwrap());
    assert_eq!(store.list(&ListTarget::Folder(drafts), None, 9).unwrap().len(), 1, "undo brings it back");
}

#[test]
fn sync_leaves_alone_the_copy_of_a_draft_that_is_leaving() {
    let (store, account, _, _) = setup();
    store.upsert_folder(account, "Drafts", "drafts").unwrap();
    let id = store.save_draft(None, account, draft_to("hi"), true).unwrap();
    store.draft_uploaded(id, "Drafts", 1, Some((7, 41))).unwrap();
    assert!(store.pending_uids(account, "Drafts").unwrap().is_empty(), "a draft being written is synced");
    // Discarded, its row is gone here while the copy waits on the server: fetched again, it would come
    // back as mail.
    store.discard_draft(id).unwrap();
    assert!(store.pending_uids(account, "Drafts").unwrap().contains(&41));
    store.draft_removed(id).unwrap();
    assert!(store.pending_uids(account, "Drafts").unwrap().is_empty());
}

#[test]
fn a_draft_from_another_app_opens_as_a_draft() {
    let (store, account, _, _) = setup();
    let drafts = store.upsert_folder(account, "Drafts", "drafts").unwrap();
    let state = crate::models::FolderState { uid_validity: Some(7), uid_next: Some(9), highest_modseq: None };
    store.set_folder_state(drafts, &state).unwrap();
    let theirs = NewMessage {
        uid: 8,
        message_id: Some("phone@x".into()),
        subject: "Notes".into(),
        to_addrs: "b@x, c@x".into(),
        references: vec!["first@x".into(), "answered@x".into()],
        date: 5,
        headers_only: true,
        ..Default::default()
    };
    store.insert_messages(account, drafts, &[theirs]).unwrap();
    let row = store.list(&ListTarget::Folder(drafts), None, 1).unwrap()[0].id;
    assert!(store.draft_for_message(row).unwrap().is_none());
    assert!(store.adopt_draft(row).unwrap().is_none(), "not before its text is here");

    store
        .conn()
        .execute("INSERT INTO bodies (message_id, text) VALUES (?1, 'from the phone')", [row])
        .unwrap();
    store.conn().execute("UPDATE messages SET body_state = 'full' WHERE id = ?1", [row]).unwrap();
    let adopted = store.adopt_draft(row).unwrap().unwrap();
    assert_eq!(adopted.draft.to, ["b@x", "c@x"]);
    assert_eq!(adopted.draft.body, "from the phone");
    assert_eq!(adopted.draft.in_reply_to.as_deref(), Some("answered@x"));
    assert_eq!(store.draft_for_message(row).unwrap().unwrap().id, adopted.id, "opens as this draft now");
    assert!(store.adopt_draft(row).unwrap().is_none(), "never twice");
    assert!(store.drafts_due(account).unwrap().is_empty(), "the copy there is this version");

    // The next save replaces the copy that came from the other app.
    store
        .save_draft(Some(adopted.id), account, Draft { body: "more".into(), ..adopted.draft }, true)
        .unwrap();
    let due = store.drafts_due(account).unwrap();
    assert!(matches!(&due[0], DraftSync::Upload { previous: Some((7, 8)), .. }), "{due:?}");
    assert_eq!(store.list(&ListTarget::Folder(drafts), None, 9).unwrap().len(), 1, "still one row");
}

#[test]
fn undoing_a_send_makes_it_a_draft_again() {
    let (store, account, _, _) = setup();
    let drafts = store.upsert_folder(account, "Drafts", "drafts").unwrap();
    let id = store.save_draft(None, account, draft_to("hi"), false).unwrap();
    let draft = store.draft(id).unwrap().unwrap().draft;
    let token = store.queue_send(account, draft, 5).unwrap();
    store.draft_sent(id).unwrap();
    assert!(store.list(&ListTarget::Folder(drafts), None, 9).unwrap().is_empty());
    assert!(store.undo(&[token]).unwrap());
    assert_eq!(store.list(&ListTarget::Folder(drafts), None, 9).unwrap().len(), 1, "back in Drafts");
    assert!(store.drafts_due(account).unwrap().iter().all(|d| !matches!(d, DraftSync::Remove { .. })));
}

#[test]
fn a_refused_send_comes_back_as_a_draft() {
    let (store, account, _, _) = setup();
    let work = store.queue_send(account, draft_to("oops"), 0).unwrap();
    store.claim_due(account).unwrap();
    store.outbox_failed(work, "550 no such user", Failure::Permanent).unwrap();
    let record = store.problem_to_draft(work).unwrap();
    assert_eq!(record.draft.subject, "oops");
    assert!(store.outbox_problems().unwrap().is_empty());
    assert!(record.draft.message_id.is_some(), "keeps its Message-ID");
}

#[test]
fn autocomplete_ranks_people_written_to_first() {
    let (store, account, inbox, _) = setup();
    let me = "me@example.com";
    let mut batch = vec![
        mail_to_me(1, "anna@x.com", me, ""),
        mail_to_me(2, "anna@x.com", me, ""),
        mail_to_me(3, "noreply@anything.com", me, ""),
    ];
    batch[0].from_name = "Anna Bell".into();
    batch[1].from_name = "Anna Bell".into();
    store.insert_messages(account, inbox, &batch).unwrap();
    store.queue_send(account, Draft { to: vec!["andy@y.com".into()], ..draft_to("hi") }, 5).unwrap();
    let names = |q: &str| store.contacts(q, 5).unwrap().into_iter().map(|c| c.email).collect::<Vec<_>>();
    assert_eq!(names("an"), ["andy@y.com", "anna@x.com"], "one send beats two received");
    assert_eq!(names("bell"), ["anna@x.com"], "a word of the name");
    assert_eq!(store.contacts("anna", 5).unwrap()[0].name, "Anna Bell");
    assert!(names("noreply").is_empty(), "automated senders are left out");
    assert!(names("").is_empty());
}

#[test]
fn a_contact_card_holds_their_latest_conversations_once_each() {
    let (store, account, inbox, archive) = setup();
    let me = "me@example.com";
    store
        .insert_messages(
            account,
            inbox,
            &[
                mail(1, "Budget", 100, "anna@x.com", me),
                mail(2, "Re: Budget", 200, "anna@x.com", me),
                mail(3, "Lunch", 300, "bob@x.com", &format!("{me}, Anna@x.com")),
                mail(4, "Other", 400, "carl@x.com", me),
            ],
        )
        .unwrap();
    store.insert_messages(account, archive, &[mail(5, "Trip", 50, me, "anna@x.com")]).unwrap();
    let card = store.contact_card("ANNA@x.com", 5).unwrap();
    let subjects: Vec<_> = card.recent.iter().map(|m| m.subject.as_str()).collect();
    assert_eq!(subjects, ["Lunch", "Re: Budget", "Trip"], "newest first, one row a conversation, either way");
    assert_eq!(card.received, 2);
    assert_eq!(store.contact_card("anna@x.com", 1).unwrap().recent.len(), 1);
    assert!(store.contact_card("nobody@x.com", 5).unwrap().recent.is_empty());
}

#[test]
fn settings_keep_their_json() {
    let store = Store::open_in_memory().unwrap();
    store.set_setting("theme", &serde_json::json!("dark")).unwrap();
    store.set_setting("theme", &serde_json::json!("light")).unwrap();
    store.set_setting("readAfterMs", &serde_json::json!(1000)).unwrap();
    let all = store.settings().unwrap();
    assert_eq!(all["theme"], "light");
    assert_eq!(all["readAfterMs"], 1000);
}

#[test]
fn the_starred_split_is_starred_inbox_mail() {
    let (store, account, inbox, archive) = setup();
    let starred = |uid, date| NewMessage { flagged: true, ..message(uid, "s", date) };
    store.insert_messages(account, inbox, &[starred(1, 10), message(2, "plain", 20)]).unwrap();
    store.insert_messages(account, archive, &[starred(3, 30)]).unwrap();
    let split = ListTarget::Role(STARRED.into());
    let rows = store.list_threads(&split, None, 10).unwrap();
    assert_eq!(rows.iter().map(|r| r.latest.id).collect::<Vec<_>>(), [1], "inbox only, starred only");
    assert_eq!(store.conversation_ids(&[1], Action::Archive, &split).unwrap(), [1]);
}

#[test]
fn migration_8_fills_in_normalised_subjects() {
    let store = Store::open_in_memory().unwrap();
    let account = store.add_account(&config()).unwrap().id;
    let inbox = store.upsert_folder(account, "INBOX", "inbox").unwrap();
    store.insert_messages(account, inbox, &[message(1, "Re: Budget", 1)]).unwrap();
    let conn = store.conn.into_inner().unwrap();
    wind_back(&conn, 7);
    let store = Store::init(conn).unwrap();
    let norm: String = store.conn().query_row("SELECT subject_norm FROM messages", [], |r| r.get(0)).unwrap();
    assert_eq!(norm, "budget");
}

#[test]
fn snippets_fill_in_before_bodies() {
    let (store, account, inbox, _) = setup();
    let text = Part {
        section: "1.1".into(),
        mime: "text/plain".into(),
        encoding: "7bit".into(),
        charset: None,
        size: 10,
        name: None,
        attachment: false,
    };
    let image = Part { section: "1".into(), mime: "image/png".into(), ..text.clone() };
    let mut with_text = message(1, "a", 2);
    let mut no_text = message(2, "b", 1);
    for (m, parts) in [(&mut with_text, vec![text.clone()]), (&mut no_text, vec![image])] {
        m.headers_only = true;
        m.parts = Some(parts);
    }
    store.insert_messages(account, inbox, &[with_text, no_text]).unwrap();
    assert_eq!(store.snippets_needed(inbox, 10).unwrap(), [(1, text)], "a part without text is not fetched");
    store.set_snippets(inbox, &[(1, "Hi there".into())]).unwrap();
    assert!(store.snippets_needed(inbox, 10).unwrap().is_empty());
    let row = store.list(&ListTarget::Folder(inbox), None, 10).unwrap().remove(0);
    assert_eq!(row.snippet, "Hi there");
    assert_eq!(store.bodies_needed(inbox, 0, 10).unwrap().len(), 2, "both still want their bodies");
}

fn draft() -> Draft {
    Draft {
        html: None,
        to: vec!["b@x".into()],
        cc: vec![],
        subject: "Lunch?".into(),
        body: "".into(),
        bcc: vec![],
        in_reply_to: None,
        references: vec![],
        attachments: vec![],
        forward_of: None,
        message_id: None,
        html_signature: None,
        out_body: None,
        out_html: None,
    }
}

#[test]
fn a_send_that_may_have_gone_out_waits_for_the_person() {
    let (store, account, _, _) = setup();
    let work = store.queue_send(account, draft(), 0).unwrap();
    store.claim_due(account).unwrap();
    store.outbox_failed(work, "connection reset", Failure::MaybeSent).unwrap();
    assert_eq!(store.next_due(account).unwrap(), None, "not sent again on its own");
    let problems = store.outbox_problems().unwrap();
    assert!(problems[0].maybe_sent);
    let id_before = match store.outbox_op(work).unwrap() {
        Some(OutboxOp::Send(d)) => d.message_id.expect("queued sends get a Message-ID"),
        other => panic!("{other:?}"),
    };
    assert!(id_before.ends_with("@example.com>"), "{id_before}");
    store.retry_outbox(work).unwrap();
    let again = store.claim_due(account).unwrap().remove(0);
    assert_eq!(again.0, work, "the person can send it again");
    assert!(matches!(again.1, OutboxOp::Send(d) if d.message_id == Some(id_before)), "as the same message");
}

/// Tern stopped (closed, crashed, power cut) in the middle of a pass, then starts again on the same file.
#[test]
fn restart_recovers_interrupted_work() {
    let path = std::env::temp_dir().join(format!("tern-restart-{}.db", std::process::id()));
    let _ = std::fs::remove_file(&path);
    let (sending, waiting, marking) = {
        let store = Store::open(&path).unwrap();
        let account = store.add_account(&config()).unwrap().id;
        let inbox = store.upsert_folder(account, "INBOX", "inbox").unwrap();
        let marking = queued_mark_read(&store, account, inbox);
        let sending = store.queue_send(account, draft(), 0).unwrap();
        let waiting = store.queue_send(account, draft(), 0).unwrap();
        store.claim_due(account).unwrap();
        store.outbox_sending(sending).unwrap();
        (sending, waiting, marking)
    };
    let store = Store::open(&path).unwrap();
    let problems = store.outbox_problems().unwrap();
    assert_eq!(problems.iter().map(|p| (p.id, p.maybe_sent)).collect::<Vec<_>>(), [(sending, true)]);
    let mut due: Vec<i64> = store.claim_due(1).unwrap().into_iter().map(|(id, _)| id).collect();
    due.sort();
    assert_eq!(due, [marking, waiting], "work that had not started goes again");
    drop(store);
    for suffix in ["", "-wal", "-shm"] {
        let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
    }
}

#[test]
fn renumbering_keeps_messages_queued_work_is_about_to_change() {
    let (store, account, inbox, _) = setup();
    store.insert_messages(account, inbox, &[message(1, "a", 1), message(2, "b", 2)]).unwrap();
    let rows = store.list(&ListTarget::Folder(inbox), None, 10).unwrap();
    let (b, a) = (rows[0].id, rows[1].id);
    store.apply(&[a], Action::Star, 5).unwrap();
    store.reset_folder(inbox).unwrap();
    assert!(store.local_uids(inbox).unwrap().is_empty(), "no uid of the old numbering survives");
    let left: Vec<i64> =
        store.list(&ListTarget::Folder(inbox), None, 10).unwrap().iter().map(|r| r.id).collect();
    assert_eq!(left, [a], "the starred one stays, still starred, until the server has the star");
    assert!(store.list(&ListTarget::Folder(inbox), None, 10).unwrap()[0].flagged);
    assert!(!left.contains(&b));
    // The next sync claims it back by Message-ID under the new numbering.
    let mut again = message(1, "a", 1);
    again.uid = 41;
    store.insert_messages(account, inbox, &[again]).unwrap();
    assert_eq!(store.local_uids(inbox).unwrap(), [41].into());
}

/// Undoes the schema steps after `version` on a current database, so a migration test can start from a real
/// database at that version. Each new migration adds its undo here.
fn wind_back(conn: &Connection, version: i64) {
    for from in (version..SCHEMA_VERSION).rev() {
        let undo = match from {
            27 => "DROP TABLE read_later;",
            26 => "DROP TABLE marks;",
            25 => "DROP TABLE ai_styles;",
            24 => "DROP TABLE ai_cache; DROP TABLE ai_usage;",
            23 => "",
            22 => "ALTER TABLE signatures DROP COLUMN custom;",
            21 => "DROP TABLE message_labels;",
            20 => "ALTER TABLE accounts DROP COLUMN auth;",
            // A column with a REFERENCES clause can't be dropped: the table goes back to its step-16 shape.
            19 => {
                "DROP TABLE signatures; DROP TABLE snippets;
                 CREATE TABLE snippets (id INTEGER PRIMARY KEY, shortcut TEXT NOT NULL UNIQUE COLLATE NOCASE,
                                        name TEXT NOT NULL DEFAULT '', body TEXT NOT NULL DEFAULT '',
                                        used INTEGER NOT NULL DEFAULT 0);"
            }
            18 => {
                "ALTER TABLE outbox DROP COLUMN scheduled; ALTER TABLE outbox DROP COLUMN held;
                 ALTER TABLE reminders DROP COLUMN message_id; ALTER TABLE reminders DROP COLUMN fired;"
            }
            17 => "ALTER TABLE folders DROP COLUMN server_count;",
            16 => "DROP INDEX messages_date; DROP TABLE snippets;",
            15 => "ALTER TABLE messages DROP COLUMN bulk; DROP TABLE sender_splits; DROP TABLE reminders;",
            // Step 14 only changed data.
            14 => "",
            13 => "DROP TABLE contacts;",
            12 => "DROP TABLE drafts;",
            11 => {
                "ALTER TABLE messages DROP COLUMN cc_addrs; ALTER TABLE messages DROP COLUMN reply_to;
                 ALTER TABLE messages DROP COLUMN followup_to; ALTER TABLE messages DROP COLUMN refs;"
            }
            10 => "DROP TABLE muted;",
            // Step 9 only changed data.
            9 => "",
            8 => "DROP TABLE settings;",
            7 => "DROP INDEX messages_subject; ALTER TABLE messages DROP COLUMN subject_norm;",
            6 => {
                "ALTER TABLE messages DROP COLUMN list_id; ALTER TABLE messages DROP COLUMN list_unsubscribe;
                 ALTER TABLE messages DROP COLUMN parts;"
            }
            5 => "ALTER TABLE outbox DROP COLUMN maybe_sent;",
            4 => "",
            _ => panic!("no undo for schema step {from}"),
        };
        conn.execute_batch(undo).unwrap();
    }
    conn.execute_batch(&format!("PRAGMA user_version = {version};")).unwrap();
}

/// A database as Tern wrote it before connection security was stored (schema 1).
fn schema_1_with_accounts() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(SCHEMA).unwrap();
    conn.execute_batch(
        "PRAGMA user_version = 1;
         INSERT INTO accounts (email, username, imap_host, imap_port, smtp_host, smtp_port)
         VALUES ('a@x', 'a@x', 'imap.x', 993, 'smtp.x', 465), ('b@x', 'b@x', 'imap.x', 993, 'smtp.x', 587);",
    )
    .unwrap();
    conn
}

#[test]
fn migration_15_fetches_again_mail_whose_files_were_never_listed() {
    let (store, account, inbox, _) = setup();
    let mut with_file = message(1, "a", 1);
    with_file.has_attachments = true;
    store.insert_messages(account, inbox, &[with_file, message(2, "b", 2)]).unwrap();
    let conn = store.conn.into_inner().unwrap();
    // As stored before step 6: the flag from the parsed body, no parts.
    conn.execute_batch("UPDATE messages SET parts = NULL, body_state = 'full';").unwrap();
    wind_back(&conn, 14);
    let store = Store::init(conn).unwrap();
    let states: Vec<(u32, String)> = store
        .conn()
        .prepare("SELECT uid, body_state FROM messages ORDER BY uid")
        .unwrap()
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    assert_eq!(states, [(1, "wanted".to_string()), (2, "full".to_string())]);
    assert_eq!(store.bodies_needed(inbox, i64::MAX, 10).unwrap(), [(1, None)]);
}

#[test]
fn migration_16_sorts_mail_already_here_into_splits() {
    let (store, account, inbox, _) = setup();
    let news = NewMessage { list_id: Some("<news.example.com>".into()), ..message(2, "news", 2) };
    let robot = NewMessage { from_addr: "noreply@example.com".into(), ..message(3, "robot", 3) };
    store.insert_messages(account, inbox, &[message(1, "person", 1), news, robot]).unwrap();
    let conn = store.conn.into_inner().unwrap();
    wind_back(&conn, 15);
    let store = Store::init(conn).unwrap();
    assert_eq!(subjects(&store, IMPORTANT), ["person"]);
    assert_eq!(subjects(&store, OTHER), ["robot", "news"]);
}

#[test]
fn download_progress_counts_against_the_server() {
    let (store, account, inbox, archive) = setup();
    let headers_only = NewMessage { headers_only: true, ..message(2, "b", 2) };
    store.insert_messages(account, inbox, &[message(1, "a", 1), headers_only]).unwrap();
    let p = &store.sync_progress().unwrap()[0];
    assert_eq!((p.have, p.total, p.unchecked), (0, 0, 2), "no folder checked yet");
    assert_eq!((p.with_text, p.messages), (1, 2));

    store.set_server_count(inbox, 10).unwrap();
    store.set_server_count(archive, 0).unwrap();
    let p = &store.sync_progress().unwrap()[0];
    assert_eq!((p.account_id, p.have, p.total, p.unchecked), (account, 2, 10, 0));
    // More here than the server counted (a move not seen there yet) never reads as more than done.
    store.set_server_count(inbox, 1).unwrap();
    assert_eq!(store.sync_progress().unwrap()[0].have, 1);
}

#[test]
fn a_send_later_waits_for_its_time_and_is_held_if_it_passed_while_closed() {
    let (store, account, _, _) = setup();
    let at = now() + 3_600;
    let id = store.queue_send_at(account, draft_to("later"), 5, Some(at), None).unwrap();
    assert!(store.claim_due(account).unwrap().is_empty(), "not before its time");
    let w = &store.outbox_waiting().unwrap()[0];
    assert!(w.scheduled && !w.held && w.not_before == at);
    assert_eq!(store.hold_overdue(at + 30).unwrap(), 0, "a minute's grace");
    assert_eq!(store.hold_overdue(at + 3_600).unwrap(), 1);
    assert!(store.outbox_waiting().unwrap()[0].held);
    assert_eq!(store.next_due(account).unwrap(), None, "held work doesn't wake the worker");
    assert_eq!(store.send_now(id).unwrap(), Some(account));
    assert_eq!(store.claim_due(account).unwrap().len(), 1, "goes once asked");

    // Edit turns a scheduled send back into a draft.
    let other = store.queue_send_at(account, draft_to("edit me"), 5, Some(at), None).unwrap();
    let record = store.problem_to_draft(other).unwrap();
    assert_eq!(record.draft.subject, "edit me");
    let left: Vec<i64> = store.outbox_waiting().unwrap().iter().map(|w| w.id).collect();
    assert_eq!(left, [id], "only the first, now going out, is left");
}

#[test]
fn a_follow_up_comes_due_without_a_reply_and_is_pinned_until_done() {
    let (store, account, inbox, _) = setup();
    let sent = store.upsert_folder(account, "Sent", "sent").unwrap();
    let due = now() + 100;
    let id = store.queue_send_at(account, draft_to("any news?"), 0, None, Some(due)).unwrap();
    let message_id = match &store.claim_due(account).unwrap()[0].1 {
        OutboxOp::Send(d) => d.message_id.clone().unwrap(),
        _ => unreachable!(),
    };
    store.outbox_sent(id, None).unwrap();
    assert!(store.check_follow_ups(due).unwrap().is_empty(), "waits for the copy in Sent");
    let copy = NewMessage {
        message_id: Some(bare_id(&message_id)),
        from_addr: "me@example.com".into(),
        date: now(),
        ..message(1, "any news?", now())
    };
    store.insert_messages(account, sent, &[copy]).unwrap();
    assert!(store.check_follow_ups(due - 1).unwrap().is_empty(), "not yet due");
    let fired = store.check_follow_ups(due).unwrap();
    assert_eq!(fired.iter().map(|m| m.subject.as_str()).collect::<Vec<_>>(), ["any news?"]);
    assert!(store.check_follow_ups(due + 10).unwrap().is_empty(), "announced once");

    let top = &store.list_threads(&ListTarget::Role(IMPORTANT.into()), None, 10).unwrap()[0];
    assert!(top.follow_up && top.latest.subject == "any news?");
    assert!(
        store.list_threads(&ListTarget::Folder(inbox), None, 10).unwrap().is_empty(),
        "only the inbox views"
    );
    assert_eq!(store.dismiss_follow_ups(&[top.latest.id]).unwrap(), 1);
    assert!(store.list_threads(&ListTarget::Role("inbox".into()), None, 10).unwrap().is_empty());
}

#[test]
fn a_reply_from_someone_else_cancels_a_follow_up_and_undo_drops_it() {
    let (store, account, inbox, _) = setup();
    let sent = store.upsert_folder(account, "Sent", "sent").unwrap();
    let id = store.queue_send_at(account, draft_to("question"), 0, None, Some(now() + 100)).unwrap();
    let message_id = match &store.claim_due(account).unwrap()[0].1 {
        OutboxOp::Send(d) => bare_id(d.message_id.as_deref().unwrap()),
        _ => unreachable!(),
    };
    store.outbox_sent(id, None).unwrap();
    let copy = NewMessage {
        message_id: Some(message_id.clone()),
        from_addr: "me@example.com".into(),
        ..message(1, "question", now())
    };
    store.insert_messages(account, sent, &[copy]).unwrap();
    let answer = NewMessage {
        message_id: Some("answer@x".into()),
        in_reply_to: Some(message_id),
        date: now() + 10,
        ..message(2, "Re: question", now() + 10)
    };
    store.insert_messages(account, inbox, &[answer]).unwrap();
    assert!(store.check_follow_ups(now() + 1_000).unwrap().is_empty(), "answered");

    let token = store.queue_send_at(account, draft_to("undo me"), 5, None, Some(now() + 100)).unwrap();
    assert!(store.undo(&[token]).unwrap());
    let left: i64 = store
        .conn()
        .query_row("SELECT count(*) FROM reminders WHERE kind = 'followup'", [], |r| r.get(0))
        .unwrap();
    assert_eq!(left, 0, "an unsent message has nothing to wait for");
}

#[test]
fn migration_21_keeps_existing_accounts_on_passwords() {
    let (store, account, ..) = setup();
    let conn = store.conn.into_inner().unwrap();
    wind_back(&conn, 20);
    let store = Store::init(conn).unwrap();
    assert_eq!(store.account(account).unwrap().unwrap().config.auth, Auth::Password);
    store.set_auth(account, Auth::Google).unwrap();
    assert_eq!(store.account(account).unwrap().unwrap().config.auth, Auth::Google);
}

#[test]
fn migration_20_moves_signatures_out_of_settings() {
    let (store, account, ..) = setup();
    let thanks = Snippet { shortcut: "thanks".into(), body: "Thanks!".into(), ..Default::default() };
    store.save_snippet(&thanks).unwrap();
    let conn = store.conn.into_inner().unwrap();
    wind_back(&conn, 19);
    conn.execute("INSERT INTO snippets (shortcut, body) VALUES ('thanks', 'Thanks!')", []).unwrap();
    let old = serde_json::json!({ account.to_string(): "Ada\nEngines", "999": "gone", "2": "  " });
    conn.execute("INSERT INTO settings (key, value) VALUES ('signatures', ?1)", [old.to_string()]).unwrap();
    let store = Store::init(conn).unwrap();

    let all = store.signatures().unwrap();
    assert_eq!(all.len(), 1, "only accounts that exist, with a signature");
    assert_eq!((all[0].account_id, all[0].body.as_str()), (account, "Ada\nEngines"));
    assert!(all[0].for_new && all[0].for_reply);
    assert!(!store.settings().unwrap().contains_key("signatures"));
    let kept = &store.snippets().unwrap()[0];
    assert_eq!((kept.account_id, kept.cc.len(), kept.last_used), (None, 0, None), "snippets keep working");
}

#[test]
fn an_archived_gmail_message_leaves_no_copy_behind_in_all_mail() {
    // Gmail has no Archive folder: archiving moves to All Mail.
    let store = Store::open_in_memory().unwrap();
    let account = store.add_account(&config()).unwrap().id;
    let inbox = store.upsert_folder(account, "INBOX", "inbox").unwrap();
    let all = store.upsert_folder(account, "[Gmail]/All Mail", "all").unwrap();
    let same = |uid| NewMessage { message_id: Some("hi@x".into()), ..message(uid, "hi", 1) };
    store.insert_messages(account, inbox, &[same(1)]).unwrap();
    store.insert_messages(account, all, &[same(7)]).unwrap();
    let id = store.list(&ListTarget::Folder(inbox), None, 1).unwrap()[0].id;
    store.apply(&[id], Action::Archive, 0).unwrap();
    assert_eq!(store.list(&ListTarget::Folder(all), None, 9).unwrap().len(), 2, "moved, not yet sent");
    assert_eq!(store.drop_moved_duplicates(all).unwrap(), 0, "kept while the move is queued");
    let (op, _) = store.claim_due(account).unwrap().remove(0);
    store.outbox_done(op).unwrap();
    assert_eq!(store.drop_moved_duplicates(all).unwrap(), 1);
    assert_eq!(store.list(&ListTarget::Folder(all), None, 9).unwrap().len(), 1);
    assert_eq!(store.drop_moved_duplicates(inbox).unwrap(), 0, "only All Mail");
}

#[test]
fn search_shows_a_message_kept_in_two_folders_once() {
    let (store, account, inbox, archive) = setup();
    let same = |uid| NewMessage { message_id: Some("q@x".into()), ..message(uid, "quarterly", 1) };
    store.insert_messages(account, inbox, &[same(1)]).unwrap();
    store.insert_messages(account, archive, &[same(2)]).unwrap();
    assert_eq!(store.search("quarterly", 10).unwrap().rows.len(), 1);
}

#[test]
fn an_upgrade_keeps_a_copy_of_the_database_as_it_was() {
    let dir = std::env::temp_dir().join(format!("tern-backup-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("mail.db");
    let store = Store::open(&path).unwrap();
    let account = store.add_account(&config()).unwrap().id;
    let inbox = store.upsert_folder(account, "INBOX", "inbox").unwrap();
    store.insert_messages(account, inbox, &[message(1, "kept", 1)]).unwrap();
    let conn = store.conn.into_inner().unwrap();
    wind_back(&conn, SCHEMA_VERSION - 1);
    drop(conn);
    Store::open(&path).unwrap();
    let copy = dir.join(format!("mail.db.before-v{}", SCHEMA_VERSION - 1));
    let old = Connection::open(&copy).unwrap();
    let version: i64 = old.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
    assert_eq!(version, SCHEMA_VERSION - 1, "the copy is the database as it was");
    let kept: i64 = old.query_row("SELECT count(*) FROM messages", [], |r| r.get(0)).unwrap();
    assert_eq!(kept, 1);
    // Closed, or Windows cannot replace it below.
    drop(old);
    // Opening an up-to-date database copies nothing; only the two newest copies stay.
    for v in [3, 4, 5] {
        std::fs::write(dir.join(format!("mail.db.before-v{v}")), b"").unwrap();
    }
    let conn = Store::open(&path).unwrap().conn.into_inner().unwrap();
    wind_back(&conn, SCHEMA_VERSION - 1);
    drop(conn);
    Store::open(&path).unwrap();
    let mut left: Vec<String> = std::fs::read_dir(&dir)
        .unwrap()
        .filter_map(|e| e.unwrap().file_name().into_string().ok())
        .filter(|n| n.contains("before-v"))
        .collect();
    left.sort();
    assert_eq!(left.len(), 2, "{left:?}");
    assert!(left.contains(&format!("mail.db.before-v{}", SCHEMA_VERSION - 1)));
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn migration_24_fetches_empty_bodies_again() {
    let (store, account, inbox, _) = setup();
    store
        .insert_messages(account, inbox, &[message(1, "kept", now()), message(2, "emptied", now())])
        .unwrap();
    let emptied = store
        .list(&ListTarget::Folder(inbox), None, 10)
        .unwrap()
        .into_iter()
        .find(|r| r.subject == "emptied")
        .unwrap();
    store
        .conn()
        .execute("UPDATE bodies SET text = NULL, html = NULL WHERE message_id = ?1", [emptied.id])
        .unwrap();
    let conn = store.conn.into_inner().unwrap();
    wind_back(&conn, 23);
    let store = Store::init(conn).unwrap();
    assert_eq!(store.body_state_of(inbox, 1).as_deref(), Some("full"));
    assert_eq!(store.body_state_of(inbox, 2).as_deref(), Some("none"));
    assert!(!store.thread(emptied.id).unwrap()[0].body_loaded, "opening it asks for the body");
    assert_eq!(store.bodies_needed(inbox, 0, 10).unwrap().len(), 1);
}

#[test]
fn migration_22_adds_label_membership() {
    let (store, account, _, _) = setup();
    let label = store.upsert_folder(account, "Work", "label").unwrap();
    let conn = store.conn.into_inner().unwrap();
    wind_back(&conn, 21);
    let store = Store::init(conn).unwrap();
    store.set_label_members(label, &["a@x".into()]).unwrap();
    assert!(store.list_threads(&ListTarget::Label(label), None, 5).unwrap().is_empty());
}

#[test]
fn migration_19_adds_send_later_and_follow_ups() {
    let (store, account, _, _) = setup();
    store.queue_send(account, draft_to("queued before"), 5).unwrap();
    let conn = store.conn.into_inner().unwrap();
    wind_back(&conn, 18);
    let store = Store::init(conn).unwrap();
    let w = &store.outbox_waiting().unwrap()[0];
    assert!(!w.scheduled && !w.held, "existing work is neither");
}

#[test]
fn migration_18_adds_server_counts() {
    let (store, _, inbox, _) = setup();
    let conn = store.conn.into_inner().unwrap();
    wind_back(&conn, 17);
    let store = Store::init(conn).unwrap();
    store.set_server_count(inbox, 3).unwrap();
    assert_eq!(store.sync_progress().unwrap()[0].total, 3);
}

#[test]
fn migration_17_adds_the_date_index_and_snippets() {
    let (store, account, inbox, _) = setup();
    store.insert_messages(account, inbox, &[message(1, "kept", 1)]).unwrap();
    let conn = store.conn.into_inner().unwrap();
    wind_back(&conn, 16);
    let store = Store::init(conn).unwrap();
    assert_eq!(store.search("kept", 10).unwrap().rows.len(), 1);
    assert!(store.snippets().unwrap().is_empty());
}

fn subjects(store: &Store, role: &str) -> Vec<String> {
    let rows = store.list_threads(&ListTarget::Role(role.into()), None, 20).unwrap();
    rows.into_iter().map(|r| r.latest.subject).collect()
}

#[test]
fn moving_a_sender_changes_its_split() {
    let (store, account, inbox, archive) = setup();
    let news = NewMessage {
        message_id: Some("n@x".into()),
        precedence_bulk: true,
        from_addr: "News@Shop.example".into(),
        ..message(1, "sale", 1)
    };
    store.insert_messages(account, inbox, &[news, message(2, "hello", 2)]).unwrap();
    assert_eq!(subjects(&store, OTHER), ["sale"]);
    assert_eq!(store.split_unread().unwrap(), (1, 1));
    let sale = store.list_threads(&ListTarget::Role(OTHER.into()), None, 1).unwrap()[0].latest.id;
    store.set_split(&[sale], false).unwrap();
    assert_eq!(subjects(&store, IMPORTANT), ["hello", "sale"]);
    let later = NewMessage {
        from_addr: "news@shop.example".into(),
        precedence_bulk: true,
        ..message(3, "sale 2", 3)
    };
    store.insert_messages(account, inbox, &[later]).unwrap();
    assert!(subjects(&store, OTHER).is_empty(), "the sender's later mail follows");
    store.set_split(&[sale], true).unwrap();
    assert_eq!(subjects(&store, IMPORTANT), ["hello"]);
    let news = |other| -> Vec<String> {
        store.new_mail(0, 0, other).unwrap().1.into_iter().map(|m| m.subject).collect()
    };
    assert_eq!(news(false), ["hello"], "Other stays quiet unless asked");
    assert_eq!(news(true).len(), 3);
    let marked: Vec<(String, bool)> =
        store.new_mail(0, 0, true).unwrap().1.into_iter().map(|m| (m.subject, m.other)).collect();
    assert!(
        marked.iter().all(|(s, other)| *other == (s != "hello")),
        "each says whether it is in Other: {marked:?}"
    );
    // Archiving from Other takes the conversation out of the inbox.
    store
        .apply(
            &store.conversation_ids(&[sale], Action::Archive, &ListTarget::Role(OTHER.into())).unwrap(),
            Action::Archive,
            0,
        )
        .unwrap();
    assert_eq!(subjects(&store, OTHER), ["sale 2"]);
    assert_eq!(store.list(&ListTarget::Folder(archive), None, 9).unwrap().len(), 1);
}

#[test]
fn snoozed_conversations_leave_the_inbox_until_due_or_answered() {
    let (store, account, inbox, _) = setup();
    store.insert_messages(account, inbox, &[message(1, "later", 100), message(2, "now", 200)]).unwrap();
    let later = store.list_threads(&ListTarget::Role("inbox".into()), None, 9).unwrap()[1].latest.id;
    store.snooze(&[later], 5_000, 1_000).unwrap();
    assert_eq!(subjects(&store, "inbox"), ["now"]);
    assert_eq!(subjects(&store, IMPORTANT), ["now"]);
    let snoozed = store.list_threads(&ListTarget::Role(SNOOZED.into()), None, 9).unwrap();
    assert_eq!((snoozed[0].latest.subject.as_str(), snoozed[0].snoozed_until), ("later", Some(5_000)));
    assert!(store.wake_snoozed(4_999).unwrap().is_empty());
    assert!(
        store.new_mail(0, 0, false).unwrap().1.iter().all(|m| m.subject == "now"),
        "no notice while snoozed"
    );
    let woke = store.wake_snoozed(5_000).unwrap();
    assert_eq!(woke.iter().map(|m| m.id).collect::<Vec<_>>(), [later]);
    assert_eq!(subjects(&store, "inbox"), ["now", "later"]);

    // A reply brings it back early.
    store.snooze(&[later], 9_000, 1_000).unwrap();
    let reply = NewMessage { in_reply_to: Some("1@example.com".into()), ..message(3, "Re: later", 2_000) };
    store.insert_messages(account, inbox, &[reply]).unwrap();
    assert_eq!(store.wake_snoozed(1_500).unwrap().len(), 1);
    store.snooze(&[later], 9_000, 3_000).unwrap();
    store.unsnooze(&[later]).unwrap();
    assert!(subjects(&store, SNOOZED).is_empty());
}

#[test]
fn migration_3_leaves_existing_work_queued() {
    let conn = schema_1_with_accounts();
    conn.execute(
        "INSERT INTO outbox (account_id, payload, not_before) VALUES (1, '{\"kind\":\"send\",\"to\":[],\"subject\":\"s\",\"body\":\"\"}', 0)",
        [],
    )
    .unwrap();
    let store = Store::init(conn).unwrap();
    assert_eq!(store.claim_due(1).unwrap().len(), 1);
    assert!(store.outbox_problems().unwrap().is_empty());
}

#[test]
fn migration_2_keeps_what_existing_accounts_did() {
    let store = Store::init(schema_1_with_accounts()).unwrap();
    let accounts = store.accounts().unwrap();
    let modes: Vec<_> = accounts
        .iter()
        .map(|a| (a.config.smtp_port, a.config.imap_security, a.config.smtp_security))
        .collect();
    assert_eq!(modes, [(465, Security::Tls, Security::Tls), (587, Security::Tls, Security::Starttls)]);
    let version: i64 = store.conn().query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
    assert_eq!(version, SCHEMA_VERSION);
}

#[test]
fn new_and_migrated_databases_have_the_same_accounts_table() {
    let columns = |store: &Store| -> Vec<String> {
        let conn = store.conn();
        let mut stmt = conn.prepare("SELECT name FROM pragma_table_info('accounts') ORDER BY cid").unwrap();
        stmt.query_map([], |r| r.get(0)).unwrap().collect::<rusqlite::Result<_>>().unwrap()
    };
    let fresh = Store::open_in_memory().unwrap();
    let migrated = Store::init(schema_1_with_accounts()).unwrap();
    assert_eq!(columns(&fresh), columns(&migrated));
}

#[test]
fn migration_5_drops_only_generated_html() {
    // A current database with two bodies in it, wound back to schema 4.
    let store = Store::open_in_memory().unwrap();
    let account = store.add_account(&config()).unwrap().id;
    let folder = store.upsert_folder(account, "INBOX", "inbox").unwrap();
    store.insert_messages(account, folder, &[message(1, "a", 1), message(2, "b", 2)]).unwrap();
    let conn = store.conn.into_inner().unwrap();
    conn.execute_batch("DELETE FROM bodies;").unwrap();
    wind_back(&conn, 4);
    let generated = mail_parser::MessageParser::default()
        .parse(b"Subject: x\r\n\r\na < b\r\nline two\r\n".as_slice())
        .unwrap()
        .body_html(0)
        .unwrap()
        .into_owned();
    conn.execute(
        "INSERT INTO bodies (message_id, text, html) VALUES (1, ?1, ?2), (2, 'hi', '<p>hi</p>')",
        params!["a < b\r\nline two\r\n", generated],
    )
    .unwrap();
    let store = Store::init(conn).unwrap();
    let html: Vec<Option<String>> = store
        .conn()
        .prepare("SELECT html FROM bodies ORDER BY message_id")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    assert_eq!(html, [None, Some("<p>hi</p>".to_string())]);
}

#[test]
fn refuses_a_database_from_a_newer_tern() {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(&format!("PRAGMA user_version = {}", SCHEMA_VERSION + 1)).unwrap();
    let err = Store::init(conn).err().unwrap();
    assert!(err.to_string().contains("newer Tern"));
}

#[test]
fn security_round_trips_through_the_store() {
    let store = Store::open_in_memory().unwrap();
    let mut c = config();
    c.smtp_port = 1465;
    c.smtp_security = Security::Tls;
    c.imap_security = Security::Starttls;
    store.add_account(&c).unwrap();
    let back = &store.accounts().unwrap()[0].config;
    assert_eq!(
        (back.imap_security, back.smtp_port, back.smtp_security),
        (Security::Starttls, 1465, Security::Tls)
    );
}

fn headers_only(uid: u32, subject: &str, date: i64) -> NewMessage {
    NewMessage { body_text: None, size: Some(1000 * uid), headers_only: true, ..message(uid, subject, date) }
}

#[test]
fn headers_show_in_the_list_before_the_body() {
    let (store, account, inbox, _) = setup();
    store.insert_messages(account, inbox, &[headers_only(1, "Lunch?", now())]).unwrap();
    let rows = store.list(&ListTarget::Folder(inbox), None, 10).unwrap();
    assert_eq!((rows[0].subject.as_str(), rows[0].snippet.as_str()), ("Lunch?", ""));
    assert!(!store.thread(rows[0].id).unwrap()[0].body_loaded);
    assert_eq!(store.search("lunch", 10).unwrap().rows.len(), 1, "headers are searchable at once");
}

#[test]
fn filling_a_body_adds_snippet_and_search_text() {
    let (store, account, inbox, _) = setup();
    store.insert_messages(account, inbox, &[headers_only(1, "Lunch?", now())]).unwrap();
    let full = NewMessage {
        snippet: "Shall we try the new place".into(),
        body_text: Some("Shall we try the new place on Friday".into()),
        has_attachments: true,
        ..message(1, "ignored: the row keeps its header subject", now())
    };
    assert_eq!(store.fill_bodies(inbox, std::slice::from_ref(&full)).unwrap(), 1);
    assert_eq!(store.fill_bodies(inbox, &[full]).unwrap(), 0, "a full row is not filled twice");

    let row = &store.list(&ListTarget::Folder(inbox), None, 10).unwrap()[0];
    assert_eq!(
        (row.subject.as_str(), row.snippet.as_str(), row.has_attachments),
        ("Lunch?", "Shall we try the new place", true)
    );
    let thread = store.thread(row.id).unwrap();
    assert!(thread[0].body_loaded);
    assert_eq!(thread[0].body_text.as_deref(), Some("Shall we try the new place on Friday"));
    assert_eq!(store.search("friday", 10).unwrap().rows.len(), 1, "the body is in the index now");
    assert_eq!(store.search("lunch", 10).unwrap().rows.len(), 1, "and the headers still are");
}

#[test]
fn bodies_needed_puts_opened_mail_first_then_the_newest() {
    let (store, account, inbox, _) = setup();
    let day = 86_400;
    store
        .insert_messages(
            account,
            inbox,
            &[
                headers_only(1, "old", now() - 400 * day),
                headers_only(2, "recent", now() - day),
                headers_only(3, "newest", now()),
            ],
        )
        .unwrap();
    let since = now() - 90 * day;
    assert_eq!(
        store.bodies_needed(inbox, since, 10).unwrap(),
        [(3, Some(3000)), (2, Some(2000))],
        "old mail waits"
    );

    let old = store
        .list(&ListTarget::Folder(inbox), None, 10)
        .unwrap()
        .into_iter()
        .find(|r| r.subject == "old")
        .unwrap();
    assert_eq!(store.want_bodies(&[old.id]).unwrap(), [account]);
    assert_eq!(store.bodies_needed(inbox, since, 10).unwrap()[0].0, 1, "opened mail jumps the queue");
    assert_eq!(store.folders_with_wanted_bodies(account).unwrap(), [(inbox, "INBOX".to_string())]);
    assert_eq!(store.bodies_needed(inbox, i64::MAX, 10).unwrap(), [(1, Some(1000))], "only opened mail");
}

#[test]
fn want_bodies_ignores_messages_that_have_theirs() {
    let (store, account, inbox, _) = setup();
    store.insert_messages(account, inbox, &[message(1, "full", now())]).unwrap();
    let id = store.list(&ListTarget::Folder(inbox), None, 10).unwrap()[0].id;
    assert!(store.want_bodies(&[id]).unwrap().is_empty());
}

#[test]
fn migration_4_counts_existing_messages_as_complete() {
    let conn = schema_1_with_accounts();
    conn.execute_batch(
        "INSERT INTO folders (account_id, name, role) VALUES (1, 'INBOX', 'inbox');
         INSERT INTO messages (account_id, folder_id, uid, thread_id, date) VALUES (1, 1, 7, 't', 1);
         INSERT INTO bodies (message_id, text) VALUES (1, 'hello');",
    )
    .unwrap();
    let store = Store::init(conn).unwrap();
    assert!(store.thread(1).unwrap()[0].body_loaded);
    assert!(store.bodies_needed(1, 0, 10).unwrap().is_empty());
}

#[test]
fn the_shelf_keeps_conversations_shelved_outside_the_inbox_or_dated_ahead() {
    let (store, account, inbox, archive) = setup();
    store.insert_messages(account, archive, &[message(1, "Old report", 100)]).unwrap();
    // Dated an hour ahead of when it is shelved, as a sender with a wrong clock makes it.
    store.insert_messages(account, inbox, &[message(2, "From the future", 4_000)]).unwrap();
    let list = |role: &str| -> Vec<String> {
        let rows = store.list_threads(&ListTarget::Role(role.into()), None, 9).unwrap();
        rows.into_iter().map(|t| t.latest.subject).collect()
    };
    let id = |folder: i64| store.list_threads(&ListTarget::Folder(folder), None, 9).unwrap()[0].latest.id;
    store.read_later(&[id(archive), id(inbox)], true, 400).unwrap();
    assert_eq!(list(LATER), ["From the future", "Old report"]);
    assert!(list("inbox").is_empty());
    let reply =
        NewMessage { in_reply_to: Some("2@example.com".into()), ..message(3, "Re: From the future", 5_000) };
    store.insert_messages(account, inbox, &[reply]).unwrap();
    assert_eq!(list(LATER), ["Old report"], "a reply after it still brings it back");
}
