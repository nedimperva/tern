# Sprint 8 — Desktop integration

**Status:** in progress (desktop polish slice) · started 2026-10-14

## Delivery scope

**M1 error visibility; M2 Linux integration; M3 Windows parity.** Move Offline and errors, including pending/failed outbox visibility, into M1. Notifications/tray/background mode/mailto/autostart follow in M2. Do not wait for all triage features before making failures visible. Re-test plugin behavior on Windows in M3.

Package number is a stable ID, not a delivery week. [PLAN.md](../PLAN.md) defines order and release gates.

## Overview

Tern behaves like a native Linux app: notifications, tray, `mailto:`, start at login, one
instance, honest offline behaviour.

## Goal

Close the window and Tern keeps syncing in the tray; a notification for new Important mail opens the
conversation on click; clicking `mailto:` anywhere opens compose; it starts with the session; it says
when it is offline.

## Tasks

### Plugins
- [x] `tauri-plugin-single-instance` (first in the builder), focusing the window and forwarding argv for `mailto:`.
- [ ] `tauri-plugin-notification`; on Linux this is `org.freedesktop.Notifications` — works on Hyprland with `mako`/`dunst`/`swaync`.
- [x] `tauri-plugin-autostart` (XDG autostart `.desktop` on Linux; registry on Windows later).
- [x] `tauri-plugin-deep-link` for `mailto:`; register the scheme in `tauri.conf.json` and the `.desktop` file (`MimeType=x-scheme-handler/mailto`).
- [ ] `tauri-plugin-dialog` already from Sprint 3; `tauri-plugin-clipboard-manager` for "Copy link / Copy address".
- [x] Review `capabilities/default.json` after each plugin; least privilege.

### Notifications
- [ ] Rules: notify for Important split only by default; per-split toggle; quiet hours; never for muted/snoozed/own sent.
- [ ] Group by thread; body is the snippet; click → open the conversation; actions `Archive` / `Reply` where the server supports notification actions (freedesktop does).
- [ ] Reminder-due and follow-up-due notifications from Sprint 5.

### Tray
- [ ] Tray icon with an unread dot (two icon variants), menu: Open, Compose, Check now, Pause sync, Quit. `libappindicator`/StatusNotifier on Linux (works in Waybar).
- [x] Closing the window hides to the tray when "Keep running in background" is on (default on); `Cmd+Q` quits.

### `mailto:`
- [x] Parse `mailto:` (`to`, `cc`, `bcc`, `subject`, `body`); open compose pre-filled; support both cold start and running instance.
- [x] Settings → "Make Tern the default mail app" (`xdg-settings set default-url-scheme-handler mailto app.tern.mail.desktop`).

### Offline and errors
- [x] Sync state in the status strip with a plain sentence: "Offline — changes will sync when you're back", "Signed out of Gmail — Sign in again", "Fastmail: can't reach imap.fastmail.com".
- [x] Outbox badge: "3 changes waiting". Clicking lists them with retry/discard.
- [x] Network change detection: on Linux `org.freedesktop.NetworkManager` state over D-Bus (`zbus`) → immediate reconnect; fallback to the backoff timer.

### Linux polish
- [ ] `.desktop` file with actions (Compose), icon sizes, `StartupWMClass` matching the Wayland app id.
- [ ] Hyprland: confirm `class` and write the recommended `windowrulev2` lines in README; respect `GTK_THEME`'s dark preference via `prefers-color-scheme` (works through WebKitGTK when the portal is present).
- [ ] Wayland fractional scaling check; text stays crisp at 1.25 / 1.5.
- [ ] First-run: suggest `gnome-keyring` unlock if Secret Service fails, with the exact command.

## Cut first
Notification actions, NetworkManager D-Bus (keep backoff), quiet hours.

## Acceptance
- Window closed, tray present, a new Important mail notifies within 2 s, click opens it.
- `xdg-open 'mailto:a@b.c?subject=Hi'` opens compose in the running instance; also when Tern is not running.
- Log out and back in: Tern is running in the tray.
- Pull the cable: status says offline, archive still works, cable back → outbox drains, status clears.

## Decisions

- 2026-10-15 — **Notifications come from the engine side, with notify-rust.** `tauri-plugin-notification` cannot
  report a click on desktop. Tern asks the store after every sync change for unread inbox mail newer than the last
  look (`Store::new_mail`): from someone else, not muted, dated within a day, and not from an account in its first
  minute of mail (a first sync is not news). Several at once make one notification. On Linux a click opens that
  conversation; Windows shows the toast but cannot report the click yet (M3). Until triage (package 05) builds
  the Important split, "Important" means the inbox.
- 2026-10-15 — **Tern becomes the mailto: handler only when asked.** The packages declare the scheme so Tern shows
  up as a choice; Settings → Desktop → "Open email links in Tern" registers it. Nothing takes over on install.
- 2026-10-15 — **One close listener.** Every Tauri close listener closes the window by itself once its handler is
  done, so compose no longer registers its own: `api.onCloseRequested` collects what must be saved, and one
  listener saves it, then hides the window (background on) or lets it close. Quit (Ctrl+Q, tray) saves the same way.

- 2026-10-15 — **Network back comes from the window, not NetworkManager.** Planned: listen to NetworkManager over
  D-Bus. Built: the webview's `online` event (WebKitGTK takes it from GLib's network monitor, which asks
  NetworkManager where it runs; WebView2 from Windows) calls `network_back`, and every account drops its
  connections and reconnects at once, as after sleep. One path for both systems and no D-Bus code. The sentence
  never says "Offline" from the event alone unless the engine also cannot reach the server.

## Log

- 2026-10-14 — From package 01's retry policy: work Tern gave up on shows in a strip under the list and a review
  dialog with Retry and Discard. Toward "Outbox badge": changes still waiting (not failed) are not counted yet, and
  the strip is not yet the full status strip with the sync-state sentence.
- 2026-10-15 — M1 visibility slice. "N changes waiting" in the status strip counts work past its undo window that
  has not reached the server (waiting for the connection, between retries, or going out now); it opens the same
  dialog as the problems, with a "Waiting to go out" section: what, why the last try failed, when the next try
  is, and Discard (reverts like undo, even after failed tries; refused while it is being sent or a later change
  depends on it). Sentences name the server that cannot be reached, or the account whose password was refused,
  when only some accounts are affected. Network back reconnects every account at once (see Decisions). Engine
  tests for listing, discarding and the dependency case, and for the reconnect signal. UI tried in `npm run dev`
  against the fake mailbox (`#offline` shows the waiting list), light and dark; not yet in the Tauri window.
- 2026-10-15 — M2 slice. Single instance (a second start brings the window back and hands over its link); tray with
  Open, Compose, Check for mail and Quit, and the unread count as its tooltip; closing hides the window by default
  (Settings → Desktop); Ctrl+Q and the tray's Quit save drafts, then quit; start at login straight to the tray
  (`--hidden`); `mailto:` parsed in the engine (`tern_core::mailto`, with tests) and opened in compose at cold start
  or in the running instance; new-mail notifications as in Decisions. The deb depends on libayatana-appindicator.
  Tried under Xvfb: a second start with a mailto: link exits and the first instance opens compose filled in. Tray,
  notifications and hiding need a real desktop; not yet tried on Hyprland or Windows. Not built yet: notification
  actions, quiet hours, tray unread dot, Pause sync, clipboard plugin, .desktop Compose action, Linux polish.
