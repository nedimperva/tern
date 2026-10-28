//! Tern as a desktop app: the tray, running on after the window closes, new-mail notifications, `mailto:` links
//! and starting at login.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, Wry};
use tern_core::mailto::{self, Mailto};
use tern_core::{NewMail, Store};

use crate::AppState;

/// The argument the login item starts Tern with: straight to the tray, no window.
pub const HIDDEN: &str = "--hidden";
/// The launcher's Compose action (`tern.desktop`): open with a new message.
pub const COMPOSE: &str = "--compose";

/// Mail older than this is not news, even if it only arrived now (a first sync, a backfill, a catch-up).
const NEWS_WINDOW: i64 = 24 * 3600;
/// A new account's first sync brings in a whole inbox; stay quiet while it does.
const QUIET_AFTER_FIRST_MAIL: Duration = Duration::from_secs(60);

const TRAY: &[u8] = include_bytes!("../icons/tray.png");
/// The same icon with a dot: unread mail in an inbox.
const TRAY_UNREAD: &[u8] = include_bytes!("../icons/tray-unread.png");
/// The app icon for notifications. Only a .deb or .rpm installs it under the icon theme, so it goes in as a file.
#[cfg(target_os = "linux")]
const NOTICE_ICON: &[u8] = include_bytes!("../icons/128x128.png");

pub struct Desktop {
    tray: Mutex<Option<TrayIcon<Wry>>>,
    /// Pause sync / Resume sync, renamed as it toggles.
    pause_item: Mutex<Option<MenuItem<Wry>>>,
    /// Whether the tray shows the dot now, so the icon is only set when that changes.
    dot: Mutex<Option<bool>>,
    /// A `mailto:` link Tern was started with, until the window asks for it.
    pending: Mutex<Option<Mailto>>,
    news: Mutex<News>,
}

#[derive(Default)]
struct News {
    /// The newest message id already looked at; None until the first look, which only sets it.
    after: Option<i64>,
    /// Accounts with mail, and since when (accounts that had mail at start count as long ago).
    since: HashMap<i64, Instant>,
}

impl Desktop {
    pub fn new() -> Self {
        Desktop {
            tray: Mutex::new(None),
            pause_item: Mutex::new(None),
            dot: Mutex::new(None),
            pending: Mutex::new(None),
            news: Mutex::new(News::default()),
        }
    }
}

/// Brings the window back, from the tray or a second start.
pub fn show(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Builds the tray. Without a tray host (a Hyprland setup with no Waybar tray, say) this does nothing visible;
/// starting Tern again still brings the window back.
pub fn tray(app: &AppHandle) -> tauri::Result<()> {
    let pause = MenuItem::with_id(app, "pause", "Pause sync", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &MenuItem::with_id(app, "open", "Open Tern", true, None::<&str>)?,
            &MenuItem::with_id(app, "compose", "Compose", true, None::<&str>)?,
            &MenuItem::with_id(app, "check", "Check for mail", true, None::<&str>)?,
            &pause,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "quit", "Quit Tern", true, None::<&str>)?,
        ],
    )?;
    let mut builder = TrayIconBuilder::with_id("tern")
        .menu(&menu)
        .tooltip("Tern")
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => show(app),
            "compose" => {
                show(app);
                let _ = app.emit("compose", ());
            }
            "check" => app.state::<AppState>().wake_all(),
            "pause" => set_paused(app, !paused(app)),
            "quit" => quit(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            // Windows; Linux tray hosts show the menu on any click.
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show(tray.app_handle());
            }
        });
    builder = builder.icon(Image::from_bytes(TRAY)?);
    let tray = builder.build(app)?;
    let desktop = app.state::<Desktop>();
    *desktop.tray.lock().unwrap() = Some(tray);
    *desktop.pause_item.lock().unwrap() = Some(pause);
    Ok(())
}

fn paused(app: &AppHandle) -> bool {
    app.try_state::<AppState>().is_some_and(|s| *s.pause.borrow())
}

/// Pauses or resumes every account's sync, from the tray, the palette or the status strip.
pub fn set_paused(app: &AppHandle, on: bool) {
    let Some(state) = app.try_state::<AppState>() else { return };
    state.pause.send_replace(on);
    if let Some(item) = app.state::<Desktop>().pause_item.lock().unwrap().as_ref() {
        let _ = item.set_text(if on { "Resume sync" } else { "Pause sync" });
    }
}

/// Asks the window to save what is being written and then quit; quits anyway if it does not answer.
pub fn quit(app: &AppHandle) {
    let _ = app.emit("quit", ());
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(3)).await;
        app.exit(0);
    });
}

/// A `mailto:` link opened while Tern runs (a second start forwards its link here): compose, filled in.
pub fn open_links(app: &AppHandle, urls: &[String]) {
    if let Some(m) = urls.iter().find_map(|u| mailto::parse(u)) {
        show(app);
        let _ = app.emit("mailto", m);
    }
}

/// The link Tern was started with, for the window to open once it is ready.
pub fn started_with(app: &AppHandle, urls: &[String]) {
    *app.state::<Desktop>().pending.lock().unwrap() = urls.iter().find_map(|u| mailto::parse(u));
}

pub fn take_pending(app: &AppHandle) -> Option<Mailto> {
    app.state::<Desktop>().pending.lock().unwrap().take()
}

pub fn now() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

/// Brings snoozed conversations back when due (or answered): unread again, and announced. Only while Tern runs;
/// one due while it was closed comes back at the next start.
pub fn watch_snoozes(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            let app = app.clone();
            let _ = tauri::async_runtime::spawn_blocking(move || {
                if let Err(e) = wake_snoozed(&app) {
                    log::warn!("snoozed mail: {e:#}");
                }
            })
            .await;
            tokio::time::sleep(Duration::from_secs(20)).await;
        }
    });
}

fn wake_snoozed(app: &AppHandle) -> anyhow::Result<()> {
    let Some(state) = app.try_state::<AppState>() else { return Ok(()) };
    // Follow-ups that came due without an answer join the top of the inbox.
    let unanswered = state.store.check_follow_ups(now())?;
    if !unanswered.is_empty() {
        let _ = app.emit("mail-changed", ());
        if Notices::read(&state.store)?.now() {
            notify(app, &unanswered, Notice::NoReply);
        }
    }
    let back = state.store.wake_snoozed(now())?;
    if back.is_empty() {
        return Ok(());
    }
    let ids: Vec<i64> = back.iter().map(|m| m.id).collect();
    let applied = state.store.apply(&ids, tern_core::Action::MarkUnread, 0)?;
    for account in &applied.accounts {
        state.wake(*account);
    }
    let _ = app.emit("mail-changed", ());
    if Notices::read(&state.store)?.now() {
        notify(app, &back, Notice::Snoozed);
    }
    Ok(())
}

/// The notification settings: on or off, Other too, and quiet hours ("HH:MM" local time, empty for none).
struct Notices {
    on: bool,
    other: bool,
    quiet_from: String,
    quiet_to: String,
}

impl Notices {
    fn read(store: &Store) -> anyhow::Result<Self> {
        let settings = store.settings()?;
        let flag = |key: &str, default| settings.get(key).and_then(|v| v.as_bool()).unwrap_or(default);
        let text = |key: &str| settings.get(key).and_then(|v| v.as_str()).unwrap_or_default().to_string();
        Ok(Notices {
            on: flag("notify", true),
            other: flag("notifyOther", false),
            quiet_from: text("quietFrom"),
            quiet_to: text("quietTo"),
        })
    }

    /// Whether a notification may show now. Mail that arrives in quiet hours is not saved up for later.
    fn now(&self) -> bool {
        use chrono::Timelike;
        let t = chrono::Local::now();
        self.on && !tern_core::triage::quiet(t.hour() * 60 + t.minute(), &self.quiet_from, &self.quiet_to)
    }
}

/// After sync changed something: notify about mail that just arrived, and update the tray's unread count. Runs
/// off the async threads; the queries are small but the store is synchronous. One look at a time: changes that
/// come while one runs (a backfill sends many a second) make one more look after it, not one each.
pub fn mail_changed(app: &AppHandle) {
    use std::sync::atomic::{AtomicBool, Ordering::SeqCst};
    static RUNNING: AtomicBool = AtomicBool::new(false);
    static AGAIN: AtomicBool = AtomicBool::new(false);
    AGAIN.store(true, SeqCst);
    if RUNNING.swap(true, SeqCst) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || loop {
        while AGAIN.swap(false, SeqCst) {
            if let Err(e) = look(&app) {
                log::warn!("new-mail check: {e:#}");
            }
        }
        RUNNING.store(false, SeqCst);
        // A change that came between the last look and letting go is looked at here, unless another call took it.
        if !AGAIN.load(SeqCst) || RUNNING.swap(true, SeqCst) {
            break;
        }
    });
}

fn look(app: &AppHandle) -> anyhow::Result<()> {
    // Sync workers start before the state is in place; their first change can come that early.
    let Some(state) = app.try_state::<AppState>() else { return Ok(()) };
    let desktop = app.state::<Desktop>();
    let store = &state.store;
    if let Some(tray) = desktop.tray.lock().unwrap().as_ref() {
        let unread = store.inbox_unread()?;
        let _ =
            tray.set_tooltip(Some(if unread > 0 { format!("Tern: {unread} unread") } else { "Tern".into() }));
        let mut dot = desktop.dot.lock().unwrap();
        if *dot != Some(unread > 0) {
            *dot = Some(unread > 0);
            let _ = tray.set_icon(Some(Image::from_bytes(if unread > 0 { TRAY_UNREAD } else { TRAY })?));
        }
    }
    let notices = Notices::read(store)?;
    let mut news = desktop.news.lock().unwrap();
    let first = news.after.is_none();
    let (newest, mail) =
        store.new_mail(news.after.unwrap_or(i64::MAX), now() - NEWS_WINDOW, notices.other)?;
    news.after = Some(newest);
    if first {
        // What is here at start is not news, and accounts that already have mail are past their first sync.
        let long_ago = Instant::now() - QUIET_AFTER_FIRST_MAIL;
        for account in store.accounts_with_mail()? {
            news.since.insert(account, long_ago);
        }
        return Ok(());
    }
    let mail: Vec<NewMail> = mail
        .into_iter()
        .filter(|m| {
            let since = *news.since.entry(m.account_id).or_insert_with(Instant::now);
            since.elapsed() >= QUIET_AFTER_FIRST_MAIL
        })
        .collect();
    drop(news);
    if !mail.is_empty() && notices.now() {
        notify(app, &mail, Notice::New);
    }
    Ok(())
}

/// Archives a notification's conversation through the outbox, as `e` in the inbox would.
fn archive(app: &AppHandle, m: &NewMail) -> anyhow::Result<()> {
    use tern_core::{Action, ListTarget};
    let state = app.state::<AppState>();
    // A follow-up's conversation is in Sent: archiving it means done with the reminder.
    state.store.dismiss_follow_ups(&[m.id])?;
    let ids = state.store.conversation_ids(&[m.id], Action::Archive, &ListTarget::Role("inbox".into()))?;
    let applied = state.store.apply(&ids, Action::Archive, crate::UNDO_SECONDS)?;
    for account in &applied.accounts {
        state.wake(*account);
    }
    let _ = app.emit("mail-changed", ());
    Ok(())
}

/// One notification for what arrived together (or came back from snooze): the message itself when it is one
/// conversation, a count otherwise.
/// Why a notification shows.
#[derive(Clone, Copy, PartialEq)]
enum Notice {
    New,
    Snoozed,
    /// A follow-up came due: nobody answered.
    NoReply,
}

fn notify(app: &AppHandle, mail: &[NewMail], why: Notice) {
    let latest = mail.last().expect("some mail").clone();
    let one = mail.iter().all(|m| (m.account_id, &m.thread_id) == (latest.account_id, &latest.thread_id));
    let who = |m: &NewMail| if m.from_name.is_empty() { m.from_addr.clone() } else { m.from_name.clone() };
    let (summary, body) = if one {
        let subject = if latest.subject.is_empty() { "(no subject)" } else { latest.subject.as_str() };
        (who(&latest), format!("{subject}\n{}", latest.snippet))
    } else {
        let mut names: Vec<String> = Vec::new();
        for m in mail.iter().rev() {
            let name = who(m);
            if !names.contains(&name) {
                names.push(name);
            }
        }
        let more = names.len().saturating_sub(3);
        names.truncate(3);
        let list = names.join(", ");
        let what = match why {
            Notice::New => "new messages",
            Notice::Snoozed => "conversations are back from snooze",
            Notice::NoReply => "conversations have no reply yet",
        };
        (format!("{} {what}", mail.len()), if more > 0 { format!("{list} and {more} more") } else { list })
    };
    let summary = match why {
        Notice::Snoozed if one => format!("Back from snooze: {summary}"),
        // A follow-up's newest message is your own; what matters is the conversation.
        Notice::NoReply if one => {
            let subject = if latest.subject.is_empty() { "(no subject)" } else { latest.subject.as_str() };
            return show_notice(app, "No reply yet".into(), subject.to_string(), one, latest);
        }
        _ => summary,
    };
    show_notice(app, summary, body, one, latest);
}

/// Writes the app icon to the cache once a run, so the notification daemon can read it by path.
#[cfg(target_os = "linux")]
fn notice_icon(app: &AppHandle) -> Option<String> {
    static PATH: std::sync::OnceLock<Option<String>> = std::sync::OnceLock::new();
    PATH.get_or_init(|| {
        let dir = app.path().app_cache_dir().ok()?;
        std::fs::create_dir_all(&dir).ok()?;
        let path = dir.join("tern.png");
        std::fs::write(&path, NOTICE_ICON).ok()?;
        path.to_str().map(str::to_owned)
    })
    .clone()
}

/// A notification body may hold markup (`<b>`, `<a href>`, `<img>`) that the daemon renders, and a subject or
/// snippet comes from whoever sent the mail: it is shown as text.
#[cfg(target_os = "linux")]
fn escape_markup(text: &str) -> String {
    text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

/// Shows one notification; a click opens the conversation, and one conversation also gets Archive and Reply.
#[cfg(target_os = "linux")]
fn show_notice(app: &AppHandle, summary: String, body: String, one: bool, latest: NewMail) {
    let mut note = notify_rust::Notification::new();
    note.summary(&summary).body(&escape_markup(&body)).appname("Tern");
    match notice_icon(app) {
        Some(path) => note.icon(&path),
        None => note.icon("mail-unread"),
    };
    note.action("default", "Open");
    // One conversation can be dealt with from the notification itself.
    if one {
        note.action("archive", "Archive").action("reply", "Reply");
    }
    match note.show() {
        Ok(handle) => {
            // Clicking the notification opens that conversation. The wait blocks, so it gets its own thread.
            let app = app.clone();
            std::thread::spawn(move || {
                handle.wait_for_action(|action| match action {
                    "default" => noticed(&app, None, &latest),
                    action => noticed(&app, Some(action), &latest),
                })
            });
        }
        Err(e) => log::warn!("notification: {e}"),
    }
}

/// Scheduled sends that came due while Tern was closed wait for the person (`hold_overdue`). Tern may have started
/// quietly in the tray, so this says so; a click shows them.
pub fn notify_held(app: &AppHandle, held: usize) {
    let Some(state) = app.try_state::<AppState>() else { return };
    if !Notices::read(&state.store).is_ok_and(|n| n.on) {
        return;
    }
    let summary = if held == 1 {
        "A scheduled send is waiting".to_string()
    } else {
        format!("{held} scheduled sends are waiting")
    };
    let body = "Their time passed while Tern was closed. Send them now or keep them as drafts.".to_string();
    show_plain(app, summary, body);
}

#[cfg(target_os = "linux")]
fn show_plain(app: &AppHandle, summary: String, body: String) {
    let mut note = notify_rust::Notification::new();
    note.summary(&summary).body(&escape_markup(&body)).appname("Tern");
    match notice_icon(app) {
        Some(path) => note.icon(&path),
        None => note.icon("mail-send"),
    };
    note.action("default", "Open");
    match note.show() {
        Ok(handle) => {
            let app = app.clone();
            std::thread::spawn(move || {
                handle.wait_for_action(|action| {
                    if action == "default" {
                        show(&app);
                        let _ = app.emit("show-waiting", ());
                    }
                })
            });
        }
        Err(e) => log::warn!("notification: {e}"),
    }
}

#[cfg(windows)]
fn show_plain(app: &AppHandle, summary: String, body: String) {
    let clicked = app.clone();
    let shown = toast(app, &summary, &body, false, move |_| {
        show(&clicked);
        let _ = clicked.emit("show-waiting", ());
    });
    if let Err(e) = shown {
        log::warn!("notification: {e}");
    }
}

/// Shows one notification as a Windows toast; a click opens the conversation, and one conversation also gets
/// Archive and Reply. Windows reports clicks while Tern runs, which in the tray it does.
#[cfg(windows)]
fn show_notice(app: &AppHandle, summary: String, body: String, one: bool, latest: NewMail) {
    let clicked = app.clone();
    if let Err(e) = toast(app, &summary, &body, one, move |action| noticed(&clicked, action, &latest)) {
        log::warn!("notification: {e}");
    }
}

/// The toast is written as XML rather than through a toast library: a click on the toast itself only comes back to
/// Tern when the toast has a `launch` argument, which the libraries leave out.
#[cfg(windows)]
fn toast(
    app: &AppHandle,
    summary: &str,
    body: &str,
    buttons: bool,
    clicked: impl Fn(Option<&str>) + Send + 'static,
) -> windows::core::Result<()> {
    use windows::core::{IInspectable, Interface, HSTRING};
    use windows::Data::Xml::Dom::XmlDocument;
    use windows::Foundation::TypedEventHandler;
    use windows::UI::Notifications::{ToastActivatedEventArgs, ToastNotification, ToastNotificationManager};

    let text = |s: &str| s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;");
    let buttons = if buttons {
        r#"<actions><action content="Archive" arguments="archive"/><action content="Reply" arguments="reply"/></actions>"#
    } else {
        ""
    };
    let xml = format!(
        r#"<toast launch="open"><visual><binding template="ToastGeneric"><text>{}</text><text>{}</text></binding></visual>{buttons}</toast>"#,
        text(summary),
        text(body)
    );
    let doc = XmlDocument::new()?;
    doc.LoadXml(&HSTRING::from(xml))?;
    let toast = ToastNotification::CreateToastNotification(&doc)?;
    toast.Activated(&TypedEventHandler::<ToastNotification, IInspectable>::new(move |_, args| {
        let args: &Option<IInspectable> = &args;
        let action = args
            .as_ref()
            .and_then(|a| a.cast::<ToastActivatedEventArgs>().ok())
            .and_then(|a| a.Arguments().ok())
            .map(|a| a.to_string());
        clicked(action.as_deref().filter(|a| *a != "open"));
        Ok(())
    }))?;
    // An installed Tern has its own app id (the installer puts it on the Start menu shortcut); a build run from
    // the source tree has none, and Windows shows nothing for an unknown id, so it borrows PowerShell's.
    let id = if cfg!(debug_assertions) {
        "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe".to_string()
    } else {
        app.config().identifier.clone()
    };
    ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(id))?.Show(&toast)
}

/// A notification was clicked (`action` None) or one of its buttons.
fn noticed(app: &AppHandle, action: Option<&str>, latest: &NewMail) {
    match action {
        None => {
            show(app);
            let _ = app.emit("open-mail", latest);
        }
        Some("reply") => {
            show(app);
            let _ = app.emit("reply-mail", latest);
        }
        Some("archive") => {
            if let Err(e) = archive(app, latest) {
                log::warn!("archive from a notification: {e:#}");
            }
        }
        Some(_) => {}
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    #[test]
    fn notification_text_is_not_markup() {
        assert_eq!(
            super::escape_markup("<a href=\"x\">Win</a> & more"),
            "&lt;a href=\"x\"&gt;Win&lt;/a&gt; &amp; more"
        );
    }
}
