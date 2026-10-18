# Changelog

What changed in each release of Tern, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow the milestones in
[docs/PLAN.md](docs/PLAN.md). The release workflow copies a version's section into its GitHub release, so
every release needs one here before it is tagged.

## [Unreleased]

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

[Unreleased]: https://github.com/nedimperva/tern/compare/v0.3.2...HEAD
[0.3.2]: https://github.com/nedimperva/tern/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/nedimperva/tern/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/nedimperva/tern/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/nedimperva/tern/releases/tag/v0.2.0
