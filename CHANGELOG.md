# Changelog

What changed in each release of Tern, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow the milestones in
[docs/PLAN.md](docs/PLAN.md). The release workflow copies a version's section into its GitHub release, so
every release needs one here before it is tagged.

## [Unreleased]

### Added

- Gmail labels: All Mail is now Tern's archive for Gmail, so archived mail shows even without a label; labels are
  listed under Labels in the side panel, conversations show theirs as coloured chips, and `l` puts a label on or
  takes it off (with undo).
- Before a new version upgrades the mail database, Tern saves a copy of it as it was, so going back to an earlier
  version keeps your mail ([docs/beta.md](docs/beta.md)).
- Settings → About: the version, details for a bug report (without addresses), the log, and a link to report a
  problem. Tern now also writes a log file.
- A guide for beta testers ([docs/beta.md](docs/beta.md)).

### Changed

- Gmail's own Important and Starred folders are no longer downloaded (stars still show), and a message in several
  labels is kept once. Search shows a message once, not once per folder.

### Fixed

- A draft you discarded or sent no longer comes back in Drafts as an ordinary message for a while afterwards.
- Drafts saved in another app (the phone, Gmail on the web) open in compose, like Tern's own, instead of as mail
  to reply to. One with attachments still opens as mail for now.
- On Gmail, old draft versions and discarded drafts are deleted, not kept in All Mail.

## [0.3.5] - 2026-10-19

A redesigned compose, and Google sign-in for builds made with your own Google client. This version upgrades the
mail database, so 0.3.4 and earlier can't open it afterwards.

### Added

- Compose checks before sending: it says when you wrote that something is attached and nothing is (in English,
  Bosnian, Croatian, Serbian, German, French, Spanish, Italian, Portuguese, Dutch, Polish and Turkish, plus your
  own words in Settings → Compose), when there's no subject, and when someone outside your organisation is among
  the recipients.
- Minimize compose to a card in the corner (Ctrl+Shift+M) and keep reading mail; focus mode (Ctrl+Shift+F) gives
  the text the whole window.
- Pictures you attach show as thumbnails, with a size bar against the usual 25 MB limit, and a drop zone shows
  when files are dragged over compose.
- Google sign-in for Gmail and Google Workspace ("Continue with Google"), with no app password, in builds made
  with your own Google client ([docs/gmail.md](docs/gmail.md)). Release builds don't include one yet, so Gmail
  there keeps using an app password.

### Changed

- Compose is tidier: From is a pill at the top beside "Saved", Cc and Bcc sit at the end of the To row,
  recipients show names and initials, Send has a menu for Send & Done, Send later and Remind, and the tools are
  icons.
- A downloaded update is easier to see: "Update ready · Restart" is a button in the status bar, and a message
  says so when the download finishes.

## [0.3.4] - 2026-10-19

Settings are redesigned, with several signatures per account and fuller snippets. This version upgrades the mail
database, so 0.3.3 and earlier can't open it afterwards.

### Added

- Several signatures per account, with formatting (bold, italic, links). Pick one for new mail and one for
  replies and forwards; switch in compose from the footer or with Ctrl+Shift+S. Your existing signature is kept.
- Snippets can be kept to one account, can fill in the subject and add people to Cc, and show how often they
  are used. The `;` picker shows what a snippet will insert before you pick it.
- Rename an account (the name people see on your mail) on its page in Settings.

### Changed

- Settings are grouped into General, Writing and Accounts, with a search field. Snippets and signatures each
  have a list and an editor with a live preview; each account has a page with its server details.

### Fixed

- A draft with a recipient that isn't a full address yet now reaches the server's Drafts folder; the server copy
  leaves that recipient out, and Tern keeps it.
- Deleting a draft from the Drafts list discards it (undo brings it back) instead of failing with "The messages
  are no longer in Drafts on the server". Other actions leave drafts where they are.

## [0.3.3] - 2026-10-19

### Added

- Send later (Ctrl+Shift+L, or Later in compose): the message waits in the outbox until its time. A send whose
  time passed while Tern was closed waits for you to confirm it.
- Remind me (Ctrl+Shift+H): if nobody replies by the time you pick, the conversation is pinned at the top of the
  inbox with "No reply yet" and a notification. Done dismisses it; a reply cancels it.

### Changed

- A new app icon: a tern, replacing the old kite, in the launcher, taskbar, installers, tray and Linux
  notifications.
- The compose footer fits on one line: only Send keeps its key hint and Attach is a paperclip; the other
  shortcuts are in tooltips.

## [0.3.2] - 2026-10-18

The first release that updates itself (AppImage and Windows); 0.3.1 and earlier need this one installed by hand.

### Added

- The AppImage and the Windows installers update themselves: a new version downloads in the background, its
  signature is checked, and "Restart to update" in the status strip installs it. `.deb`, `.rpm` and AUR installs
  are updated by their package manager.
- An AUR package, `tern-bin`, built from the release's `.deb`.
- Pause sync, from the tray, the command palette or the status strip: Tern signs out and changes wait until you
  resume. A restart resumes.
- The tray icon shows a dot while an inbox has unread mail.
- A notification about one conversation has Archive and Reply buttons (Linux).
- Settings → Desktop: notify for Important mail only (the default) or for Other too, and quiet hours.
- The launcher entry has a Compose action (`tern --compose`), and Tern is listed under Internet / Email.
- "Downloading mail: 12,400 of 48,210" in the status strip while a big mailbox comes down; the search note says
  how many messages have their text here.

### Changed

- Releases are published as normal releases rather than pre-releases, so the updater can find the latest one.
- Clicking a search result opens that message; a snippet whose shortcut is already taken says so on its row.
- Conversation lists are about a third faster on big mailboxes.
- When the system keyring refuses a password on Linux, the error says what to install and check.
- Vite 8, TypeScript 7, rusqlite 0.40 and newer Tauri packages.

## [0.3.1] - 2026-10-16

### Changed

- The reading pane puts the newest message on stage, with every earlier one listed above it on a thread line.
- Debug builds are smaller: line tables for Tern only, no debug info for dependencies.

## [0.3.0] - 2026-10-16

The first focused Linux beta build.

### Added

- Tern runs in the tray, keeps syncing after the window closes, notifies about new mail, opens `mailto:` links
  and can start at login. A second start brings back the running window.
- The inbox splits into Important and Other; moving a sender teaches the split. Snooze brings a conversation
  back unread at the time you pick (while Tern runs).
- Common-word search is fast at 50,000 messages, and snippets expand with `;` in compose.
- An attachment viewer, quick quote, a conversation menu and a contact card.
- Messages are drawn in Tern's style; designed mail keeps its own frame, sized to fit.
- Focus mode, sender logos (off unless turned on), and a reply bar under the conversation.

## [0.2.0] - 2026-10-15

The Linux private alpha, and the first installers built from a version tag.

### Added

- Sync for any IMAP account over TLS or STARTTLS: headers first, IDLE on the inbox, QRESYNC and CONDSTORE.
- Conversations with keyboard triage; every change is local first and goes out after a 5-second undo window.
- Changes that are waiting or didn't go through are listed, with retry and discard. An uncertain send is never
  resent without asking.
- Compose with rich text, drafts that survive a restart (one copy on the server), attachments, signatures and
  recipient autocomplete. Reply, reply all and forward.
- Received attachments open with the system or save where you pick; pictures pasted into mail show in place.
- Search by words and filters (`from:`, `in:`, `has:attachment`, `before:`, `-word`, `"phrase"`, `OR`, …).
- Mail HTML renders sandboxed without scripts; remote images wait until you load them.
- Passwords live only in the system keyring.

[Unreleased]: https://github.com/nedimperva/tern/compare/v0.3.5...HEAD
[0.3.5]: https://github.com/nedimperva/tern/compare/v0.3.4...v0.3.5
[0.3.4]: https://github.com/nedimperva/tern/compare/v0.3.3...v0.3.4
[0.3.3]: https://github.com/nedimperva/tern/compare/v0.3.2...v0.3.3
[0.3.2]: https://github.com/nedimperva/tern/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/nedimperva/tern/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/nedimperva/tern/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/nedimperva/tern/releases/tag/v0.2.0
