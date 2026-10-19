# App icon: acceptance checklist

The owner ticks these on a real machine; agents never tick them. Mark a check `- [x] (owner YYYY-MM-DD)` when it
passed, or leave a note under it when it did not. The new icon is a tern (`src-tauri/icons/icon.svg`) and replaces
the old kite. Installed icons can be cached: if the kite still shows after an install, log out and back in once.

## Linux (Omarchy/Hyprland)

- [ ] `npm run tauri dev`, then add an account screen (rail > Add account): the tern sits above "Add an account".
- [ ] Tray (waybar): the tern shows, readable at bar size. With unread mail in an inbox it has a red dot top right.
- [ ] A new-mail notification shows the tern, not a generic envelope.
- [ ] Install the AppImage or .deb from the release build: the launcher (walker) shows the tern.

## Windows

- [ ] The installer (setup.exe) and the .msi show the tern as their file icon.
- [ ] After install: Start menu, taskbar and the window's title bar show the tern, at 100% and 150% scaling.
- [ ] Tray: the tern, with the red dot when there is unread mail. Check on a dark and a light taskbar.
- [ ] Settings > Apps lists Tern with the tern.
