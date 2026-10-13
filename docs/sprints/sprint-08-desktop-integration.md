# Sprint 8 — Desktop integration

**Week 9.** Tern behaves like a native Linux app: notifications, tray, `mailto:`, start at login, one
instance, honest offline behaviour.

## Goal

Close the window and Tern keeps syncing in the tray; a notification for new Important mail opens the
conversation on click; clicking `mailto:` anywhere opens compose; it starts with the session; it says
when it is offline.

## Tasks

### Plugins
- [ ] `tauri-plugin-single-instance` (first in the builder), focusing the window and forwarding argv for `mailto:`.
- [ ] `tauri-plugin-notification`; on Linux this is `org.freedesktop.Notifications` — works on Hyprland with `mako`/`dunst`/`swaync`.
- [ ] `tauri-plugin-autostart` (XDG autostart `.desktop` on Linux; registry on Windows later).
- [ ] `tauri-plugin-deep-link` for `mailto:`; register the scheme in `tauri.conf.json` and the `.desktop` file (`MimeType=x-scheme-handler/mailto`).
- [ ] `tauri-plugin-dialog` already from Sprint 3; `tauri-plugin-clipboard-manager` for "Copy link / Copy address".
- [ ] Review `capabilities/default.json` after each plugin; least privilege.

### Notifications
- [ ] Rules: notify for Important split only by default; per-split toggle; quiet hours; never for muted/snoozed/own sent.
- [ ] Group by thread; body is the snippet; click → open the conversation; actions `Archive` / `Reply` where the server supports notification actions (freedesktop does).
- [ ] Reminder-due and follow-up-due notifications from Sprint 5.

### Tray
- [ ] Tray icon with an unread dot (two icon variants), menu: Open, Compose, Check now, Pause sync, Quit. `libappindicator`/StatusNotifier on Linux (works in Waybar).
- [ ] Closing the window hides to the tray when "Keep running in background" is on (default on); `Cmd+Q` quits.

### `mailto:`
- [ ] Parse `mailto:` (`to`, `cc`, `bcc`, `subject`, `body`); open compose pre-filled; support both cold start and running instance.
- [ ] Settings → "Make Tern the default mail app" (`xdg-settings set default-url-scheme-handler mailto app.tern.mail.desktop`).

### Offline and errors
- [ ] Sync state in the status strip with a plain sentence: "Offline — changes will sync when you're back", "Signed out of Gmail — Sign in again", "Fastmail: can't reach imap.fastmail.com".
- [ ] Outbox badge: "3 changes waiting". Clicking lists them with retry/discard.
- [ ] Network change detection: on Linux `org.freedesktop.NetworkManager` state over D-Bus (`zbus`) → immediate reconnect; fallback to the backoff timer.

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
