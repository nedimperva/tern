# Tern beta: a guide for testers

Thanks for trying Tern. This is a beta: it syncs and sends real mail and its author uses it every day, but some
things are missing and some will break. Keep another mail client around, and tell us what goes wrong
(see [Reporting a problem](#reporting-a-problem)).

## Installing

Get the latest release from [GitHub Releases](https://github.com/nedimperva/tern/releases/latest).

| System | File | Updates |
|---|---|---|
| Linux, any distribution | `Tern_<version>_amd64.AppImage`: make it executable and run it | Itself: "Update ready · Restart" in the status bar |
| Debian, Ubuntu | `.deb` (`sudo apt install ./Tern_…deb`) | With the next `.deb` |
| Fedora, openSUSE | `.rpm` | With the next `.rpm` |
| Windows 10/11 | `-setup.exe`. SmartScreen warns because it isn't signed yet: More info → Run anyway | Itself |

On Linux, passwords are kept by the Secret Service, so a keyring (GNOME Keyring, KWallet) must be running and
unlocked. If adding an account says "No keyring answered", install `gnome-keyring` and `seahorse`, sign out and
in again, and check in Passwords and Keys that a "Login" keyring exists and is unlocked.

## Adding an account

Type your address; Tern fills in the servers it knows and asks for a password.

- **Gmail and Google Workspace**: use an **app password** (Google Account → Security → 2-Step Verification →
  App passwords), not your Google password. 2-Step Verification must be on. Some Workspace admins turn app
  passwords off; then Gmail can't be added to this build. Builds made with your own Google client can sign in
  with Google instead ([docs/gmail.md](gmail.md)).
- **Fastmail**: an app password from Fastmail's settings, with IMAP and SMTP access.
- **Other providers**: any IMAP and SMTP server with TLS or STARTTLS. Tern has been tested with Gmail, SmarterMail
  and Stalwart so far (Fastmail next); tell us how yours goes.
- **Outlook / Microsoft 365** sign-in isn't supported yet.

A large mailbox comes down newest first: the inbox fills in seconds, and the status bar says "Downloading mail:
X of Y" until the rest is here. Mail older than 90 days gets its text when you open it.

## What to expect

Works: the inbox split into Important and Other, conversations, the keyboard (press `?` for every key, `Ctrl K`
for every command), compose with drafts, attachments, signatures and snippets (`;`), send later and "remind me if
no reply", snooze, search with filters (`from:`, `has:attachment`, `newer_than:7d`, …), Gmail labels (`l`), the
tray, notifications, and `mailto:` links.

Not yet, or only partly:

- **Snooze, send later and reminders only happen while Tern is running** (in the tray counts). A send whose time
  passed while Tern was closed waits for you to confirm it.
- **Gmail labels** have a colour of Tern's own; Gmail's colours and its own conversation grouping don't come over
  IMAP. New labels are made in Gmail.
- **Search** reads the text of mail that is on this computer; older mail is found by sender and subject until
  you've opened it.
- **Windows**: notifications can't be clicked yet.
- No calendar, no AI, no Outlook sign-in.

Every change you make (archive, star, move, send) happens here at once and goes to the server after 5 seconds, so
`Z` can undo it. If the server can't be reached, changes wait and the status bar says so; nothing is dropped.

## Where Tern keeps things

| | Linux | Windows |
|---|---|---|
| Mail database | `~/.local/share/app.tern.mail/mail.db` | `%APPDATA%\app.tern.mail\mail.db` |
| Copies from before an upgrade | the same folder, `mail.db.before-v<N>` | the same folder |
| Log | `~/.local/share/app.tern.mail/logs/tern.log` | `%LOCALAPPDATA%\app.tern.mail\logs\tern.log` |
| Passwords | the Secret Service, as "tern-mail" | Credential Manager, as "tern-mail" |

Settings → About shows the log's exact place and opens its folder.

## Going back to an earlier version

Some versions upgrade the mail database, and an older Tern can't open a database a newer one has upgraded. Before
it upgrades, Tern saves a copy of the database as it was, next to it, as `mail.db.before-v<N>` (the two newest
are kept). To go back:

1. Quit Tern (`Ctrl Q`, or Quit in the tray).
2. Install the earlier version.
3. In the folder above, rename `mail.db` to `mail.db.newer` and remove `mail.db-wal` and `mail.db-shm` if they are
   there.
4. Copy the `mail.db.before-v<N>` whose number matches the version you went back to, and name the copy `mail.db`:

   | Version | Database |
   |---|---|
   | 0.3.1 | 17 |
   | 0.3.2 | 18 |
   | 0.3.3 | 19 |
   | 0.3.4 | 20 |
   | 0.3.5 | 21 |
   | 0.3.6 | 22 |

5. Start the earlier version. Mail that arrived since syncs again from the server; changes made in the newer
   version that already reached the server are there too.

No copy for that number? Delete `mail.db` (and `-wal`, `-shm`) instead: Tern downloads your mail again from the
server, and your accounts need adding again. Drafts that were only on this computer would be lost that way, so
send or save them on the server first.

## Starting over

To remove everything Tern keeps: quit it, delete the folder `app.tern.mail` (both of them on Windows), and remove
the "tern-mail" entries from the keyring or Credential Manager. Your mail stays on the server.

## Reporting a problem

Settings → About → **Report a problem** opens the issue form on GitHub with the version filled in. Please add:

- what you did, what you expected and what happened;
- **Details** from Settings → About (Copy): version, system and each account's provider, without addresses;
- for a failure, the end of the log. Remove anything private before pasting.

Ideas and wishes are welcome too, as a feature request on the same page.
