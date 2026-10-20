# M3 Windows release: acceptance checklist

The owner ticks these on a real Windows 10/11 machine with real accounts; agents never tick them. Mark a check
`- [x] (owner YYYY-MM-DD, account)` when it passed, or leave a note under it when it did not. The milestone's exit
evidence is in [PLAN.md](../PLAN.md): a clean Windows installation passes the mail-core checks, and Linux stays
green. The [M1](m1-alpha.md) and [M2](m2-beta.md) checklists still apply on Windows; this one adds what is Windows'
own. Version under test: the first release with package 13 (0.3.8 or later).

## Installing and updating

- [ ] On a Windows user that never had Tern: the `-setup.exe` from the release installs without admin rights
      (SmartScreen: More info → Run anyway), starts from the Start menu, adds an account, syncs.
- [ ] The `.msi` installs the same way on another user or machine.
- [ ] No `libssl`/`libcrypto` DLLs in the install folder (`%LOCALAPPDATA%\Tern`).
- [ ] The previous release, installed, shows "Update ready · Restart" within a day of a new release; the restart
      opens the new version with mail, drafts and settings intact.
- [ ] Uninstalling from Settings → Apps removes Tern; reinstalling finds the mail and passwords where they were.

## Desktop

- [ ] New mail shows a Windows notification. Clicking it opens that conversation; with one conversation, Archive
      archives it (gone from the inbox, and from the server after 5 s) and Reply opens a reply.
- [ ] Window closed: Tern stays in the tray; the tray dot shows unread mail; the tray menu's items work.
- [ ] Settings → Desktop → Make Tern the email app opens Windows' default apps; after choosing Tern there, a
      `mailto:` link in Edge opens compose, with Tern running and not.
- [ ] Start at login starts Tern in the tray after signing in to Windows.
- [ ] Passwords are in Credential Manager (Windows Credentials, `tern-mail`), nowhere in `%APPDATA%\app.tern.mail`.
- [ ] Sleep the laptop for 10 minutes and wake it: Tern reconnects by itself and new mail arrives.
- [ ] Wi-Fi off, archive something, Wi-Fi on: the change goes out without a restart.

## Looks and keys

- [ ] Tern set to Dark on a light Windows (and Light on a dark one): the title bar follows Tern.
- [ ] Text is sharp at 100 %, 125 % and 150 % display scaling; nothing is cut off or overlaps.
- [ ] F5, Ctrl+R, Ctrl+P, Ctrl+F and Alt+Left do nothing (no reload, print dialog, find bar or blank page).
- [ ] Right-click on a message or the list shows no browser menu; in a text field and on selected text the menu
      offers Cut, Copy and Paste.
- [ ] Every shortcut in the `?` sheet works, including Ctrl+K, Ctrl+Enter, Ctrl+Shift+, and Ctrl+Shift+M.
