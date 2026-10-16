//! Tern as a desktop app: the tray, running on after the window closes, new-mail notifications, `mailto:` links
//! and starting at login.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, Wry};
use tern_core::mailto::{self, Mailto};
use tern_core::NewMail;

use crate::AppState;

/// The argument the login item starts Tern with: straight to the tray, no window.
pub const HIDDEN: &str = "--hidden";

/// Mail older than this is not news, even if it only arrived now (a first sync, a backfill, a catch-up).
const NEWS_WINDOW: i64 = 24 * 3600;
/// A new account's first sync brings in a whole inbox; stay quiet while it does.
const QUIET_AFTER_FIRST_MAIL: Duration = Duration::from_secs(60);

pub struct Desktop {
    tray: Mutex<Option<TrayIcon<Wry>>>,
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
        Desktop { tray: Mutex::new(None), pending: Mutex::new(None), news: Mutex::new(News::default()) }
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
    let menu = Menu::with_items(
        app,
        &[
            &MenuItem::with_id(app, "open", "Open Tern", true, None::<&str>)?,
            &MenuItem::with_id(app, "compose", "Compose", true, None::<&str>)?,
            &MenuItem::with_id(app, "check", "Check for mail", true, None::<&str>)?,
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
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    let tray = builder.build(app)?;
    *app.state::<Desktop>().tray.lock().unwrap() = Some(tray);
    Ok(())
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
    if state.store.settings()?.get("notify").and_then(|v| v.as_bool()).unwrap_or(true) {
        notify(app, &back, true);
    }
    Ok(())
}

/// After sync changed something: notify about mail that just arrived, and update the tray's unread count. Runs
/// off the async threads; the queries are small but the store is synchronous.
pub fn mail_changed(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if let Err(e) = look(&app) {
            log::warn!("new-mail check: {e:#}");
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
    }
    let mut news = desktop.news.lock().unwrap();
    let first = news.after.is_none();
    let (newest, mail) = store.new_mail(news.after.unwrap_or(i64::MAX), now() - NEWS_WINDOW)?;
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
    let on = store.settings()?.get("notify").and_then(|v| v.as_bool()).unwrap_or(true);
    if on && !mail.is_empty() {
        notify(app, &mail, false);
    }
    Ok(())
}

/// One notification for what arrived together (or came back from snooze): the message itself when it is one
/// conversation, a count otherwise.
fn notify(app: &AppHandle, mail: &[NewMail], snoozed: bool) {
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
        let what = if snoozed { "conversations are back from snooze" } else { "new messages" };
        (format!("{} {what}", mail.len()), if more > 0 { format!("{list} and {more} more") } else { list })
    };
    let summary = if snoozed && one { format!("Back from snooze: {summary}") } else { summary };
    let mut note = notify_rust::Notification::new();
    note.summary(&summary).body(&body).appname("Tern");
    #[cfg(target_os = "linux")]
    {
        note.icon("mail-unread").action("default", "Open");
    }
    #[cfg(windows)]
    {
        note.app_id(&app.config().identifier);
    }
    match note.show() {
        #[cfg(target_os = "linux")]
        Ok(handle) => {
            // Clicking the notification opens that conversation. The wait blocks, so it gets its own thread.
            let app = app.clone();
            std::thread::spawn(move || {
                handle.wait_for_action(|action| {
                    if action == "default" {
                        show(&app);
                        let _ = app.emit("open-mail", &latest);
                    }
                })
            });
        }
        #[cfg(not(target_os = "linux"))]
        Ok(_) => {}
        Err(e) => log::warn!("notification: {e}"),
    }
}
