# Changelog

What changed in each release of Tern, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow the milestones in
[docs/PLAN.md](docs/PLAN.md). The release workflow copies a version's section into its GitHub release, so
every release needs one here before it is tagged.

## [Unreleased]

### Fixed

- A newsletter sometimes opened in a short box with the rest cut off, until reading view was switched on and off.
  The frame is measured again as its pictures and fonts arrive and when its width changes.

## [1.7.0] - 2026-10-30

### Changed

- One column beside a conversation instead of two, and no tabs in it. The companion shows the person at the top
  (how much you write each other and how fast you answer), then what the newest message holds (day, place, codes,
  links, a newsletter's parts and your marks), what you owe and are owed, the files and recent mail with them.
  Ask about the conversation sits at the foot. `i`, `Ctrl+.` and the header's panel button show or hide it. Making a
  note on a passage opens it with the note field ready.
- The day, place and codes sit together in one card with a tile each; files show their kind. What was asked of you
  is listed once, under You owe, for the whole conversation.
- Thin scrollbars without arrows, the same on Windows and Linux. The list, the conversation and the companion show
  theirs only under the pointer.
- A conversation reads more calmly: a heading for each day instead of "3 days later", times on the lines, your own
  lines quieter than theirs, and an open message as a card. Under the newest one sits the answer panel: suggested
  replies when AI is on, then Reply, Reply all and Forward. With the companion open, the people line under the subject
  gives way to the message count and the days.
- A signature folds to one line that says whose it is ("Renato Šuster · Gama Trade d.o.o"), and is now found after a
  bare "--" or a sign-off like "Srdačan pozdrav" or "S poštovanjem", not only after "-- ".

### Removed

- The line above the inbox ("Morning, … 3 need you") and its keys `1`–`4`: the morning screen does its job. `g o`
  opens the morning screen at any time; Settings → Reading → Start of the day is now the screen or off.

### Fixed

- Bosnian, Croatian and Serbian words are read whole: a sentence ending "…na Ostrošcu." is no longer taken for a
  promise, "u četvrtak" now gives a due day, and "Možeš li…?" counts as a question for you.
- Promises: "u prilogu šaljem sliku" (what goes with the mail itself) is no longer something you owe, and the
  joined future ("poslaću", "poslacu sutra") counts as a promise.

## [1.6.0] - 2026-10-29

### Added

- Moods: Settings → Appearance → Mood has Dawn (the light look), Dusk (the dark one), Night Sea (the navy of the
  first Inbox Zero) and System. On Omarchy there is Omarchy too: Tern takes the colours of your Omarchy theme and
  changes with it when you switch themes.
- A little motion that says where things went: a conversation you mark done slides right, one you delete slides
  left, a snoozed one lifts away, and the rows below close up instead of jumping. A star pops when you put it on.
  None of it with reduced motion.
- A sky that changes: Inbox Zero's Horizon follows the hour, from first light to dusk, shows the moon in its real
  phase at night, and snows a little in winter.
- The tide report: on Sundays Inbox Zero shows your week in mail — how much came in, how much you cleared, the days
  you reached zero and the quietest day. It's counted on this computer.
- Coming back to a long conversation: "Since you last read: 3 new · a question for you" with a jump to the first
  new message, and older messages you've read wait behind one "Earlier in this conversation" line.
- Who writes most (Settings, or "Who fills your inbox" in the command bar): the senders behind the last 30 days'
  mail, most first, with Unsubscribe where they offer it and a way to send them to Other.
- The companion (`Ctrl+.`): a column beside the open conversation. Ask questions about it with AI (on request,
  with the messages it rests on as chips and a note of exactly what was sent), see who you're writing with, what
  you owe and what's owed to you, and every file in the conversation. Only Ask uses AI.
- Writing with AI: type a few bullet points and Write with AI offers "Write out these points", keeping each one. A
  tone row (Shorter, Warmer, Firmer) sits in compose's footer, and a reworked version shows exactly what it changed
  before you keep it.
- A conversation reads as a thread: every message one line, oldest first, and the newest open at the end, the same
  size as the others. Earlier messages open when you click them.
- Wing beat: a soft sound when a message leaves the outbox. Off by default; Settings → Notifications → Sound when
  mail leaves. Quiet hours keep it quiet.

### Changed

- The morning screen is now the tide: a band of sky that follows the hour and your mood, a greeting, and three
  columns — who needs you, who you're waiting on (and what came back from snooze), and what there is to read with
  reading times. Click any card to open it; Enter still starts with the first, Shift E still clears the updates.

### Fixed

- On Linux the window is frameless again, as before 1.5.0: Tern's title bar and its minimize, maximize and close
  buttons (which did nothing on Hyprland) are gone, and the window manager handles the window. The sidebar button
  is back at the top left of the list. Windows keeps Tern's title bar.

## [1.5.0] - 2026-10-29

### Changed

- A warmer, calmer look: warm greys instead of cool ones, the logo's navy as the accent, rounded rows. Dark mode
  is a warm charcoal.
- Tern draws its own title bar: the sidebar button at the top left, minimize, maximize and close at the right, and
  the rest drags the window. The system's title bar is gone.
- The sidebar (accounts, folders, labels, saved searches) stays open beside the list in a wide window, with New
  mail at its top and Settings and Add account at its foot. The button at the top left or `Ctrl+\` hides it until
  shown again; Settings → Appearance → Sidebar sets it to slide over the list only when asked.
- A calmer sidebar: each account shows Inbox, Drafts, Sent and Archive, with its other folders under "More";
  accounts, labels and saved searches fold under their headings, and Tern remembers what you folded. Counts show
  only where unread mail matters. With one account there is a single Inbox row at the top.
- The focused row in the list no longer has a coloured bar at its left; its background shows it. Label chips are
  softer, and the greys are a little lighter and cleaner in both themes.
- Inbox Zero and the morning screen take the warm look too: a paper sky, sand and stone below, a terracotta
  heading, and terns in the logo's navy.
- Moving with the keyboard shows a soft ring in the accent colour, and only where it helps: no more black outline
  around the list, the editor or fields. In the sidebar, focus is a tone, as under the pointer.
- Settings look like the rest of Tern: the sections list matches the sidebar, with icons; settings sit in cards,
  each control lined up beside its name and the line under it; dropdowns, fields and buttons are quieter, and
  checkboxes and switches take the accent. The AI page's providers, table and cards, and the snippet and signature
  editors, follow the same look.
- Your writing style has its own page, Settings → Writing style, with a card per account; the AI page links to it
  instead of holding every account's note. On the AI page, the accounts it may read, the status and what is kept
  are cards too.

### Fixed

- Opening some mail could flood the log with "ResizeObserver loop" errors while the message was sized.
- Development builds compile SQLite optimised, so the list no longer takes 150–200 ms per move there.

## [1.4.0] - 2026-10-28

### Added

- Show original, in a conversation's `…` menu: the newest message's headers and source as the server has it,
  to copy or check who really sent it.
- Mark all read (`U`, or from the command bar): every unread message in the list, including the pages not loaded
  yet. One `z` brings them back.
- Hovering a link in a mail shows where it goes, just under the link. When the link's text names one site and it
  points at another, that is said in yellow, and a click opens a menu that says so instead of the browser.
- The words searched for light up in the results (names, subject, preview) and in a conversation opened from them.
- Search filters `is:snoozed` (snoozed conversations) and `has:note` (mail with a note on a mark); `has:mark` is
  the same as `is:marked`.
- Paste a picture into a message, or drop one on its text: it goes out in the text, not as an attachment.
  Taking it out of the text takes it out of the message.
- Saved searches: Save search beside the search box keeps it in the rail (Ctrl+\) and the command bar.
- Account colours: with two or more accounts, the rail starts with each account's badge (a click opens its inbox),
  and rows in the inboxes and search show which account they're in, when the list holds more than one account's
  mail. Pick a colour in Settings → the account.
- Settings → Backup: export your settings, snippets, signatures, saved searches and account colours to a file, and
  import them on another computer. Tick "Include accounts" to add every account with its password or Google
  sign-in, and your AI keys, sealed with a passphrase you choose (PBKDF2 and ChaCha20-Poly1305); importing it asks
  for the passphrase and adds the accounts and keys that aren't there yet.
- Notifications per account: Settings → the account → Notifications sets Important mail, Important and Other, or
  none for that account alone. Accounts without a choice follow Settings → Notifications.
- For contributors: unit tests for the UI's text and HTML helpers (Vitest, `npm test`), Biome for the TypeScript
  (`npm run lint`) and cargo deny for licences and sources (`deny.toml`), all in CI; `npm run check` runs what CI
  runs.

### Changed

- Easier with the keyboard and a screen reader: the rail, Settings' sections and a sender's name are reached with
  Tab; the `…` menu takes the focus and gives it back; the conversation list says the focused conversation as j
  and k move; address suggestions, colour swatches and choices follow the arrow keys. `Z` zooms a picture in the
  attachment viewer.
- `before:` and `after:` in search start at midnight where you are, not midnight UTC.
- Faster while mail downloads: the window reads everything again at most every 150 ms instead of on every frame,
  list rows that did not change stay as they are, and the window reads on a connection of its own, so a sync
  writing a batch never makes a keypress wait.
- New-mail checks for notifications and the tray run one at a time instead of one per change.
- At quit, Tern refreshes SQLite's query statistics and folds the write-ahead log back into the database.
- A downloaded update waits on disk for "Restart to update" instead of in memory.

### Fixed

- The Read later shelf stayed empty for a conversation shelved from Archive or a search, or one with a message
  dated ahead of your clock. It shows there now.

## [1.3.1] - 2026-10-27

### Added

- Settings → your account: Change password (checked with the server before it is saved) and Remove from Tern,
  which deletes Tern's copy of the account's mail and forgets its password. The server keeps the mail.
- Links in plain-text mail open on click.
- `z` takes back every change still in its undo window, newest first. A sent message's undo lasts as long as
  Settings → Compose → Undo send says.
- Settings → About shows how much the downloaded attachments take, with Clear. Tern keeps at most 1 GB of them.

### Fixed

- Mail without a Date header, or with one far in the future, sorts by when the server received it instead of
  sinking to the bottom or sticking to the top. Old rows without a date say "(no date)".
- A new message could show an old, deleted message's inline pictures or attachment, when both got the same number
  in the database. Downloaded files are now kept per message.
- Newsletters and alerts with the same subject every time no longer pile up into one endless conversation.
- Holding `e`, `#` or another action key no longer acts on one conversation after another; only moving repeats.

### Security

- The file picker and the save dialog open from Tern's engine, and the window can only attach files you picked or
  dropped, or save where you chose. A script that got into the window could not read or write other files.
- Subjects and snippets in Linux notifications are shown as text, not markup.
- HTML mail is cleaned again each time it opens, so a fix in the cleaner covers mail stored before it.
- Loaded pictures come over https only; one asked for over http is asked for over https.
- HTML, SVG, Excel add-in (.xll), compiled help (.chm) and similar attachments are saved, not opened.
- Write with AI no longer adds an address it came up with that is neither in your contacts nor in what you typed;
  it shows it instead, for you to add yourself.

## [1.3.0] - 2026-10-27

### Added

- Beside a conversation, what its newest message holds: the day and time it names (snooze it until then), an
  address (open the map), what it asks of you, codes to copy and its links. Found on this computer; Settings →
  Reading turns it off.
- Marks and notes. Select text in a message to quote it in a reply, mark it, add a note or copy it. Marks show in
  the message and beside it; `[` and `]` go from one to the next. `g m` lists everything you marked, search finds
  the words of your marks and notes, and `is:marked` keeps to marked mail. They stay on this computer.
- Newsletters open in reading view, without the list's footer, with their parts and links beside them. The book
  icon switches back; Settings → Reading changes the default.
- Read later. `Shift L` puts a conversation on the shelf, out of the inbox until you take it off or someone
  replies; `g r` shows the shelf. It stays in your inbox on the server.

### Fixed

- One at a time: a long message no longer pushes its card off the bottom of the window, and Reply and Snooze open
  over the cards instead of behind them.

## [1.2.0] - 2026-10-26

### Added

- The start of the day. On the first open of a day, a screen says who waits on you and since when, and Enter takes
  you through them one at a time (Reply, Snooze, Done, Later). After that, one quiet line above the inbox counts
  what came in since you were last here, what needs you, what came back from snooze and what has no answer yet;
  1–4 jump to each. All counted on this computer; Settings → Reading turns either off.

### Changed

- AI: set up several providers at once (Anthropic, OpenAI, Google), each with its own key, and pick the model for
  each feature in Settings → AI. Summaries and suggested replies now use a small, cheap model by default (Claude
  Haiku, GPT-6 Luna or Gemini Flash); Write with AI and learning your style keep the bigger one. A model from a
  provider you haven't allowed yet asks first.

### Fixed

- Some wide mail (newsletters, receipts) flashed many times a second while open: shrinking it to fit the pane kept
  undoing and redoing itself.
- Settings → AI showed the inbox for a few seconds, then flickered, before it opened.
- R (and Reply all) opened the reply at the bottom of a long conversation, out of view; it now scrolls there.
- Write with AI has its quick asks again: Write it out (Write a reply, in an empty reply), Shorter, More formal,
  Friendlier and Fix grammar, above the field; on a version they rework it.

## [1.1.0] - 2026-10-26

### Added

- Optional AI, with your own key from Anthropic (Claude), OpenAI (GPT) or Google (Gemini). It is off until you turn
  it on in Settings → AI, which first shows what is sent and to whom, and it only ever runs when you ask: nothing goes
  in the background, nothing from accounts you didn't tick, and never attachments. Addresses and phone numbers are
  taken out of mail first, a daily limit caps the cost, and what is kept on this computer can be deleted.
- Summaries: Shift S in a conversation, or Summarize under its subject, gives a line or two on where it stands, with
  what is due, what is asked of you and what was decided; More shows the points.
- Suggested replies: Q in a conversation offers three replies, each labelled with what it does; 1, 2 or 3 starts a
  reply with one, to edit before you send.
- Write with AI: in an empty reply, press Space and say what to answer. It writes from the conversation and what you
  tell it; say more to get another version, ↑ to go back, Tab to keep one, Esc to drop them. In new mail it also fills
  in who it goes to and the subject, finding people in your contacts on this computer.
- Your writing style: Settings → AI → "Learn from my sent mail" reads an account's latest sent messages once, shows a
  sample written plainly and in your style, and keeps a note you can tune. Write with AI and suggested replies follow
  it.

### Changed

- The mail database moves to a new version (a copy of the old one is kept beside it, as before every upgrade).

## [1.0.0] - 2026-10-23

### Added

- Inbox Zero has a tern scene a day: the tern's migration from pole to pole, a flock with a bird for each
  conversation you cleared today, two summers, to the Moon and back, your streak this week, the horizon by day and
  by night, the colony (a tern per account), your migration this year, the dive and the seasons on the coast; after
  10 pm a sleeping colony says "Go to sleep". Settings → Appearance keeps the rotation or picks one.
- A right-click on a link in a message offers Open link and Copy link (Copy address for an email address).
- A Send later message whose time passed while Tern was closed now gets a notification when Tern starts; clicking
  it shows the send waiting for you.
- Windows: clicking a notification opens that conversation, and a notification for one conversation has Archive
  and Reply, as on Linux.
- HTML signatures: copy your signature from Gmail's or Outlook's settings and paste it in Settings → Signatures,
  logo, colours and layout included. It shows under the message in compose and goes out exactly as it is.

### Changed

- Windows: F5, Ctrl+R, Ctrl+P, Ctrl+F and the browser's right-click menu no longer reload, print or search the app
  window (right-click still offers Cut, Copy and Paste in text). The title bar follows Tern's Light or Dark setting.
- Settings is quieter: a picked snippet or signature has no coloured bar, filters and "New mail · Replies" are
  grey, and each account's tab is underlined in that account's own colour. The Google sign-in button sits next to
  how the account signs in.

### Fixed

- Security updates for certificate checks (rustls-webpki, webpki-roots: distrusted intermediates are no longer
  accepted) and ctutils.
- Some mail showed only its subject, for good: a flag change the server reported while bodies were downloading
  was saved as that message's body. Those messages download again after the update. A message the server will not
  give, or a batch it refuses, no longer holds up snippets and bodies for the rest of the mailbox.
- The "New messages" and "Replies and forwards" choices in Settings → Signatures no longer show the wrong signature
  after an edit.

## [0.3.7] - 2026-10-20

Two fixes from using 0.3.6.

### Fixed

- Typing a snippet or signature name in Settings no longer loses its place every few seconds while mail syncs.
- Ctrl+Shift+, discards a message being written on any keyboard layout (it did nothing where Shift+, types
  something other than "<", such as Bosnian, Croatian or German).

## [0.3.6] - 2026-10-20

Gmail labels, drafts that behave, and what beta testers need: About, a log file and a guide. This version
upgrades the mail database. It saves a copy first, so going back to 0.3.5 keeps your mail
([docs/beta.md](docs/beta.md)).

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

[Unreleased]: https://github.com/nedimperva/tern/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/nedimperva/tern/compare/v0.3.7...v1.0.0
[0.3.7]: https://github.com/nedimperva/tern/compare/v0.3.6...v0.3.7
[0.3.6]: https://github.com/nedimperva/tern/compare/v0.3.5...v0.3.6
[0.3.5]: https://github.com/nedimperva/tern/compare/v0.3.4...v0.3.5
[0.3.4]: https://github.com/nedimperva/tern/compare/v0.3.3...v0.3.4
[0.3.3]: https://github.com/nedimperva/tern/compare/v0.3.2...v0.3.3
[0.3.2]: https://github.com/nedimperva/tern/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/nedimperva/tern/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/nedimperva/tern/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/nedimperva/tern/releases/tag/v0.2.0
