# Changelog

What changed in each release of Tern, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow the milestones in
[docs/PLAN.md](docs/PLAN.md). The release workflow copies a version's section into its GitHub release, so
every release needs one here before it is tagged.

## [Unreleased]

### Added

- Day headings in the list (Today, Yesterday, the week's days, then months), like a thread's.
- Settings → Appearance shows a preview beside the settings that follows each change of mood and density.
- Done, Snooze and Star on a row while the pointer is on it.
- The sync panel lists each change the server refused, with Retry and Discard beside it.
- Empty views say how mail gets there, with the key that does it.
- The command palette offers "Search your mail for …" and "Ask your mail about …" when no command matches.
- Keys 1 to 5 pick a time in the snooze picker; a time typed with a digit first ("3h") still works.
- Read later rows say how long each takes to read.

### Changed

- Settings read one way on every page: a line on what the page is for, a preview where there is something to see,
  then headed groups of rows, with switches for on and off. Moods are picked from pictures, Senders is one list
  with a split preview, AI shows what would leave the computer, and searching settings marks the matching rows.
- Files in compose fold into one line (how many, how big, their names) and open to a row each; long names are cut
  in the middle so their ends show. The size bar is gone; a note shows only near or past 25 MB.
- Compose's footer: writing tools on the left (attach, AI, snippet, signature), and on the right a red discard icon
  and Send with an arrow for Send & Done, Send later and Remind me. The ⋯ menu is gone.
- Headings are in plain words everywhere instead of capitals; AI is marked with the sparkle everywhere.
- The facts card over a conversation says When, Where and Asked of you with icons, and its actions are links.
- An inline reply starts small; its folded quote shows the quote's first words.
- With little room, a conversation's view buttons move into its ⋯ menu so the subject keeps its space.
- The problems pill keeps its dot and drops the triangle; the search line fits on one line.
- In Tern's title bar a conversation closes from a back arrow before its subject (Esc as before), away from the
  window's own close button.
- A narrow window folds search to its icon before it can lie over the tabs.
- An open message says its time once, after the name, and only the time when it came today.
- With the companion open, the thread's brief keeps its one line: what was asked, the day and the place are in the
  companion. The companion says the counts in a sentence and shows the year's bars only with three months of mail.
- A row that is focused and selected shows a deeper tint, so it still reads as selected. The selection's button says
  "Move sender to Other" (or Important).
- The morning screen greets without a stand-in name and writes the time without a leading zero; its cards fold a
  signature or quote behind the same pill as a thread.
- Search results start with their count, and "Search the server too" is a button. The Narrow it chips show the words
  they add.
- The undo pill names the conversation it acted on, and a thin line runs out with its undo window.
- Refused changes show as an amber "2 to look at" on the sync button; red is kept for a sign-in that stops sync.
- The ⋯ menu comes in groups with shorter names. The label picker nests labels under their parent.
- The sidebar's More has its chevron on the left, like the folders.
- Reading view sits in the middle of the card. The brief's tags are quiet words, and "Add a note" is a plain line.
- The avatars over a conversation are a little larger, with the first on top.
- Compose in focus mode quiets the title bar to what is being written. People in To, Cc and Bcc show as pills with
  their initials.
- The file viewer dims the title bar with it, and its button says Close.
- Settings' drop-downs share one width.
- The command palette shows commands that match by word first, and at most three looser matches under their own
  heading.
- The quoted "On … wrote:" line in a reply folds with the quote, and the pill names whose message it is.
- Problems say what went wrong in plain words, with the server's code beside it and its full reply on hover.
- Morning cards show the subject above what is asked, and say "waiting 3 weeks" rather than a date.
- Starred rows don't repeat the star. A conversation's labels sit at the end of the people line.
- Earlier messages in a thread line up their names, and their snippets end in an ellipsis.
- Settings: accounts show their address under the name; Email links says when Tern already opens them; the
  Appearance preview shows whole rows; Senders says where each sender is now; AI dims the later steps until a key
  is added; Todoist's list runs the full width.

### Fixed

- Received files show their full names again: the compose box's file tiles had taken over their cards.
- The sync panel said "Up to date" (to screen readers too) while changes had failed.
- Long names in the shortcut sheet no longer run into their keys.
- The sync panel said an account was "Up to date" while some of its changes had failed.

## [2.1.0] - 2026-11-06

The title bar does more: tabs, search and an open conversation's tools sit in it. Search the server, Ask your mail,
and your mail as .eml or mbox files.

### Added

- The list's tabs and search sit in Tern's title bar.
- Settings → Senders lists muted conversations, each with Unmute.
- Todoist: tick a task off in the companion, and Tern reads each task's state when the conversation opens. Asks and
  promises get + Task. A task links back to its mail with a `tern://` link.
- Search the server for mail whose text isn't on this computer yet; what it finds says "From the server".
- Search previews are cut around the words you looked for, and N / P step through them in a conversation.
- With AI on: Summarise what came in on the morning screen, and Ask your mail (A), answered from this computer's
  search.
- Your mail as files: a message as .eml, a folder or a search as one mbox file with progress and Stop, and an mbox
  file imported into a new folder on the server.

### Changed

- The title bar does more (canvas "Tern title bar ideas", 1–4): an open conversation's subject and its tools sit in
  it, so the mail starts a row higher; selected conversations turn it into their actions (Done, Snooze, Label,
  Mark read, Other, Trash); search grows over the tabs, its filters show as chips, and a tap adds Unread, Starred,
  With files, This week, Marked or Sent; and New people is a quiet tab, its icon and count, while someone waits and the sidebar is closed. The
  line above Important that said so is gone.
- The strip under the list is gone, and its key hints with it. Sync is one button at the right of the title bar
  (at the end of the list's header on Linux): a dot when all is well, a word when something needs a look, and a
  click for each account, what waits, Sync now and Pause. Undo floats at the foot of the window.
- The list changes only the conversations sync touched instead of reading the page again, and lists read on their
  own connections, so sync no longer holds them up.

### Fixed

- Searching from the title bar keeps the focus after the first letter.

## [2.0.0] - 2026-11-04

Your inbox, your rules: New people, blocking and one-click unsubscribe, the companion beside every conversation, the
brief under its subject, and Todoist. 1.9.0 and 2.0.0-1 were tested but never published, so their changes are here
too.

### Added

- The companion's person card: how much they write, month by month, how fast you answer, and Important, Other or
  Blocked in one control. Fold it to one row with Shift+I; it stays folded until you open it again.
- Someone waiting in New people gets a card that helps decide: how long they've written, whether you know anyone at
  their domain, whether it came through a list. Let them in, send them to Other or block them from there.
- A note on a person, kept only on this computer and shown on every conversation with them.
- Files with a person: switch from this conversation's files to every file you exchanged, by kind and month.
- A newsletter's card says how many issues you open, and can archive the unopened ones or unsubscribe.
- Todoist: connect your own API token in Settings → Todoist, then press T in a conversation (or Add task beside
  something asked or due) to make a task. It goes out after the usual 5-second undo and carries the title, the day,
  the project, a label and who sent the mail. Never the mail's text. The conversation shows "In Todoist" and its
  tasks in the companion. Tasks go to the project chosen in Settings; with AI on, Fill in the task box writes the
  title, the day and a note for you to check.
- The brief under a conversation's subject: what came since you last read it, then what was asked of you, the day
  and the place, each with a button (Answer, Snooze till then, Add task, Map). With AI on, Explain it adds a sentence
  on top.
- One-click unsubscribe: `Ctrl+U` (or the Unsubscribe button) on a list that offers it (RFC 8058) unsubscribes
  without a browser, after the usual five seconds to undo, and the conversation goes to Done. Lists without it
  open their page or start their mail, as before.
- Block a sender, or everyone at their domain, from the companion, the conversation menu or the palette. Their
  later mail is read and archived as it comes, and can still be found. Nothing tells them.
- New people (off by default, Settings → Senders): first mail from someone you haven't written to waits in a place of
  its own in the sidebar (`g n`), a row per person with their address, until you let them in (`y`), send them to
  Other (`Shift+O`) or block them (`Shift+X`); the choice covers all they sent. A line above Important says when
  someone waits. List the domains whose people you know.
- Settings → Senders lists every choice you made about a sender (blocked, sent to Other, kept in Important), each
  with a way back.
- Updates: a Beta channel in Settings → About, for test versions of what comes next.
- The companion: Recent with them is a list you can open (each row opens its conversation; the last finds all
  their mail), and under their name are Write to, Copy address and where their mail goes.
- Hold Ctrl to see each account's number in the sidebar (`Ctrl+1`…`Ctrl+9` opens its inbox).

### Changed

- The "Since you last read" bar and the AI summary's chips are now one brief.
- Clicking a file in the companion opens it in Tern's viewer, as in the conversation.
- Writing help in compose is a sidebar now, not a chat. `Ctrl+J`, the AI key or Space in an empty draft opens it
  beside the text; for a reply it takes the companion's place. It holds everything the old panel did: a Brief you
  edit and write from again (Write it out, Write a reply, Write out these points), tries to step through, Shorter,
  Warmer, Firmer, More formal and Fix grammar, and for new mail the people it found. New: suggested replies as
  Starts, Translate, Reshape on just the selected words, and an "In your style" switch for one mail.
- A try shows in grey where your text is, and is not in the email until you keep it with Tab. People the AI names
  are added only when you add them. Nothing in the sidebar can send.
- Compose is calmer. The subject leads as the mail's title with the people in one small line under it, the text is
  set a little larger, and the tools fade while you type. The footer holds From (when you have more than one
  address), Saved and the word count on the left, and attach, AI, a ⋯ menu (other ways to send, snippets,
  signatures, discard) and Send on the right.
- The signature folds to one line at the foot of the compose window. Open it to read it, switch to another one with
  one click right there, and Fold it again; it also folds again on its own when you go back to your text.
- Drop-downs are Tern's own everywhere (compose's From, Translate, Settings), instead of the system's lists.
- In the sidebar, an account's Junk, Trash and other special folders sit under a "More" heading at the end, like
  Folders and Labels.
- Focus mode (Ctrl+Shift+F) fills the whole window: your mail is a white sheet on the warm background, with
  larger text, the signature line at the foot of the sheet, and Send and attach in a floating pill.
- An empty mail says "Start writing, or press Space for writing help" on its first line, instead of a box.
- Long mails get room in focus mode. The compose window offers focus once a mail is long; focus keeps the subject
  and people at the top, gives the text the window's height, and shows an outline of your paragraphs on the left:
  click one to go there, drag to reorder, or Alt+Up/Down to move the one you're in. If your question sits below
  the first part, it says so once and can move it up. Ctrl+Shift+O hides or shows the outline.

### Fixed

- Enter in the Subject field, or in an empty To field, sent the mail. Only Send and Ctrl+Enter send now.
- A reply left open under a conversation showed up a second time above it, as a draft message, once it was saved.
  It shows only in the reply box now, and comes back as "Draft · R to continue" when you close the reply.
- With a reply open under a conversation, clicking anywhere outside it left every key dead (Esc, C, G I…). The reply
  takes the keys only while you're in it; outside it the usual keys work, R goes back to it, and leaving the
  conversation keeps it as a draft.
- New mail from the 1st to the 9th of a month never arrived from SmarterMail. It writes those dates without the
  space the standard asks for, and Tern dropped the whole message. Tern reads them now, and the missed mail comes
  in on the next check.
- A signature written as HTML code (from a signature generator, say) showed as code in compose and went out as code.
  Tern now sees the code, treats it as an HTML signature and shows it as it looks, including ones saved before.
- The signature in compose stays open once you open it, until you press Fold, also when you switch between a text
  and an HTML signature. It still starts folded, and the folded line now names the signature in the mail.

## [1.8.0] - 2026-11-02

### Added

- Send from more than one address in an account. Settings → an account → Also send as takes other addresses the
  server lets you send from, such as a custom domain set up in iCloud, each with its own name if you like. Compose's
  From picker lists them under the account, and a reply or forward starts from the address the mail was sent to.
  Mail you sent from one of them counts as yours: no notification, it never lands among the people you reply to,
  and it does not cancel a snooze or a follow-up.
- The iCloud preset says how to set up a custom domain: sign in with the iCloud address and add the domain's address
  under Also send as.

- The sidebar nests folders and labels by name: "Projects/Alpha" sits under Projects, which starts folded and
  shows the unread of everything under it. Your own folders get their own Folders heading instead of hiding under
  More, which now holds only the server's special folders (Junk, Trash, All Mail).

### Fixed

- Adding or saving an account could fail with "IMAP LOGOUT failed: server did not send the expected BYE" even
  though the sign-in worked. Some servers end the connection without that goodbye; Tern no longer minds.
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
