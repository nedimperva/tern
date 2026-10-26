# Tern UI spec

The single source of truth for how Tern looks and behaves on screen. Sprint files say *when* a screen is
built; this file says *what it must look like*. If a sprint needs something not covered here, add it here
first, then build it.

Delivery scope comes from `docs/PLAN.md`: future screens in this spec are not first-release requirements.
Use the roadmap's end-to-end performance evidence; a signal-update timing is not input-to-paint latency.

Direction (owner's decision): **match Superhuman's look and feel as closely as reasonable.** Dense,
calm, keyboard-first, one accent colour, no chrome.

## 1. Principles

1. **The list is the app.** Everything else slides in over it or beside it and leaves with `Esc`.
2. **Keyboard first, mouse welcome.** Every control shows its key on hover; nothing needs the mouse.
3. **Quiet.** One accent. Greys do the work. Borders are rare; spacing and background shifts separate things.
4. **Instant.** No spinners under 300 ms. Skeletons after 300 ms. Optimistic everywhere.
5. **Text is the interface.** Few icons, all with labels or tooltips. Icons never carry meaning alone.
6. **Dense but legible.** 13 px body in lists, 14 px when reading, generous line height, tight vertical rhythm.
7. **Celebrate empty.** Inbox Zero gets the best screen in the app.

## 2. Tokens

All tokens are CSS custom properties on `:root` (light) and `[data-theme="dark"]`. Nothing in a component
uses a raw colour, size or duration. File: `src/styles/tokens.css`.

### Colour

| Token | Light | Dark | Use |
|---|---|---|---|
| `--bg-0` | `#ffffff` | `#111113` | App background, list |
| `--bg-1` | `#fafafa` | `#18181b` | Panels, compose, sidebar |
| `--bg-2` | `#f4f4f5` | `#1f1f23` | Hover rows, chips |
| `--bg-3` | `#e9e9ec` | `#27272b` | Selected/focused row |
| `--fg-0` | `#18181b` | `#ededef` | Primary text, unread |
| `--fg-1` | `#52525b` | `#a1a1aa` | Secondary text, read rows |
| `--fg-2` | `#a1a1aa` | `#71717a` | Meta, snippets, placeholders |
| `--line` | `#e4e4e7` | `#27272a` | The few borders we draw |
| `--accent` | `#5b5bd6` | `#7c7cf0` | Focus bar, links, primary button, selection dot |
| `--accent-fg` | `#ffffff` | `#ffffff` | Text on accent |
| `--accent-soft` | `#eeeefb` | `#232347` | Selected chip, palette match highlight |
| `--ok` | `#2f9e6e` | `#3fbf85` | Sent, synced |
| `--warn` | `#c98a1b` | `#e0a63a` | Offline, waiting |
| `--danger` | `#d0453f` | `#ef6b66` | Errors, discard |
| `--star` | `#e9b81c` | `#f2c94c` | Star |
| `--shadow` | `0 8px 30px rgba(0,0,0,.12)` | `0 8px 30px rgba(0,0,0,.6)` | Palette, dialogs |
| `--soft` | `#f5f5f7` | `#1a1a1e` | Files, the reply row, an inline reply (`--soft-hover` on hover) |
| `--tip` / `--tip-fg` | `#18181b` / `#fafafa` | `#ededef` / `#111113` | Tooltips on the conversation's header icons |

Account colours (unified inbox dots, calendar): a fixed palette of 8 — `#5b5bd6 #2f9e6e #d0453f #c98a1b #0e9bb5 #b24fb0 #7a7f8a #e07a30` — assigned in order of account creation.

### Type

Inter variable (bundled), `font-feature-settings: "cv11", "ss01", "tnum"` for list dates. JetBrains Mono for code and raw source.

| Token | Size / line | Weight | Use |
|---|---|---|---|
| `--t-xs` | 11 / 16 | 500 | Chips, keycaps, section labels (uppercase, 0.04em tracking) |
| `--t-sm` | 12 / 16 | 400 | Meta: dates, counts, status strip |
| `--t-md` | 13 / 18 | 400 / 600 | List rows (600 for unread participants/subject) |
| `--t-rd` | 14 / 21 | 400 | Reading and compose body |
| `--t-lg` | 16 / 22 | 600 | Conversation subject, dialog titles |
| `--t-xl` | 22 / 28 | 600 | Empty-state time, settings page titles |

Mail HTML is rendered in its own iframe with the sender's styling; we only set a base font (`--t-rd`) and colours for the plain-text fallback.

### Space, radius, motion

- Spacing scale: `4 8 12 16 24 32` px (`--s-1 … --s-6`). Rows use 12 px horizontal padding; panels 16; dialogs 24.
- Radius: `--r-sm 4` (chips, keycaps) · `--r-md 6` (buttons, inputs, rows in palette) · `--r-lg 10` (palette, dialogs, compose modal).
- Motion: `--d-fast 120ms` list and focus moves · `--d-base 160ms` panels and toasts · `--d-slow 240ms` dialogs. Easing `cubic-bezier(.2,.8,.2,1)`. Everything is `0ms` under `prefers-reduced-motion`.
- Density setting: `dense` row 36 px (default), `comfortable` 44 px, `spacious` 52 px. Only row height and a 1–2 px type bump change.

### Keycaps

Keys are shown everywhere as keycaps: `--t-xs`, `--bg-2` background, `--line` 1 px border, `--r-sm`, 18 px tall, min-width 18 px, mono digits. Chords render as two keycaps with `then` between (`G then I`).

## 3. Layout

```
┌──────────────────────────────────────────────────────────────────────────┐
│ [rail]  │  Important · 12   Other · 48   Calendar · 2        [search ⌕] │  ← 40 px split bar
│         ├──────────────────────────────────────────────────────┬────────┤
│ hidden  │  ▍ Ana Rossi, me 3      Q3 numbers — here's the…  14:02     │        │
│ by      │    GitHub               [tern] CI failed on main   Mon      │  conv  │
│ default │    Linear               LIN-233 moved to Done      Mon      │  pane  │
│         │    …                                                        │ (opt.) │
│         │                                                             │        │
│         ├──────────────────────────────────────────────────────┴────────┤
│         │  ● Synced · 2 changes waiting            ↩ Undo archive  Z    │  ← 28 px status strip
└──────────────────────────────────────────────────────────────────────────┘
```

- **Window minimum** 720 × 480. At < 960 px wide the conversation always opens full-width over the list.
- **Rail** (`Ctrl+\`): 240 px slide-over from the left with a scrim; accounts (avatar dot + name + unread), labels, settings. It never stays open by default. On ≥ 1440 px the user can pin it (setting).
- **Split bar**: tabs with unread counts, active tab has a 2 px `--accent` underline; search field right-aligned (`/` focuses it; it expands to 320 px on focus).
- **List**: full width when nothing is open. With the conversation open in split mode the list narrows to 40 % (min 360 px) and rows drop the snippet.
- **Conversation pane**: opens with `Enter`, closes with `Esc`. Mode setting: `split` (beside the list) or `full` (over it). Default `split` ≥ 1200 px, else `full`.
- **Status strip**: left = sync state sentence with a dot (`--ok/--warn/--danger`), right = the current undo toast or the three most useful keys for the current context, shown after 2 s of inactivity and hidden on the next keypress.
  A downloaded update shows as a filled `--accent` pill ("Update ready · Restart"), the one control in the strip
  that is a button; a toast says so once when it arrives.

## 4. Components

### 4.1 Conversation row

```
▍ ● Ana Rossi, Tom Berg, me 3   Q3 numbers — here's the deck we talked about… ⌁ ★   14:02
│ │ └ participants (600 if unread) └ subject (600 if unread) └ snippet (--fg-2)  │  │  └ date (--t-sm, tnum, --fg-2)
│ └ account dot (unified views only)                                           │  └ star (--star when set, hidden otherwise unless hovered)
└ 3 px focus bar (--accent), full row height                                   └ attachment glyph
```

- One line. Participants column is fixed at 180 px (dense) and ellipsised; subject + snippet share the rest, subject never truncates below 40 % of its container.
- Participant names: first names when there are ≥ 2; "me" for our addresses; sender of the last unread message first; count badge (`3`) only when > 1.
- Label chips after the subject: max 2, `--t-xs` 600, the label's colour tinted to 16 % as the background and mixed 75 % into `--fg-0` for the text, with a 6 px dot in the full colour; a `+2` chip for the rest. Chips never push the date. Gmail's colours don't come over IMAP, so a label's colour comes from its name (`labelColour`, the account palette): the same label, the same colour in rows, the conversation, the rail and the picker.
- States: `focused` → `--bg-3` + focus bar; `selected` (`x`) → `--accent-soft` background + checkbox replaces the account dot; `hover` → `--bg-2` (no focus bar); `unread` → `--fg-0` weight 600 for participants and subject, otherwise `--fg-1` and 400.
- Snoozed shows a small clock + due text instead of the date; scheduled drafts likewise.
- Row removal (archive, snooze): 120 ms height collapse; focus moves to the next row immediately.

### 4.2 Conversation pane

- Header: subject (`--t-lg`), label chips, a "Done" primary button with the keycap `E` and an overflow (`…`) with every action and its key.
  Built: the `…` menu lists the conversation's actions in the order people reach for them (reply first, Trash
  last) with their keys; arrows or `j`/`k`, `Enter` and `Esc` work in it, and any other key closes it and does
  what it always does.
- A sender's name shows their card when the pointer rests on it (or on a click): name, address (click copies),
  how many messages each way, the last five conversations (click opens one), "Write to them" and "All their mail"
  (`from:` search). It only opens after a real pointer move, so a conversation opening under a still pointer does
  not pop it.
- The pane draws no outlines. Separation comes from space and tones of the background: `--soft` for files, the
  reply row, an inline reply and a conversation's history.
- Header: the subject in `--t-head` (24 px). For two or more messages a line under it: up to four sender avatars,
  the people ("you" last) and the message count. On the right, icons that show only when they apply, each saying
  more in a tooltip: a green shield with the tracker count (what Tern blocked; a click loads the images), a clock
  (reading time from 2 minutes), a book (reading view for designed mail), a leave icon (List-Unsubscribe: a web
  link opens in the browser, a `mailto:` one opens compose; it turns into a check). Then Done (its key on hover),
  `…` and close. "Always load images from this sender" is in `…` while images are blocked.
  The header scrolls away with the messages; once the subject is out of view a 48 px bar (subject, Done) fades in
  over the top of the pane. The bar takes no space, so nothing moves as it comes and goes.
- The newest message, or the only one, takes the stage: a byline (40 px avatar, name, "to you · 2 hours ago") and
  the body a size up (16 px / 1.7). Unread is a 6 px `--accent` dot after the name; your own messages have an
  `--accent` ring on the avatar.
- Above it, every earlier message is one line on a `--soft` panel (24 px avatar, name, snippet, date), all of them
  there, none folded away. A click (or `o`) opens a line in place on `--bg-0`, with "to you, Tom Berg · Tue 14 Oct,
  14:02"; unread ones start open. A closed line the keys act on, and a hovered one, get `--soft-hover`; there is no
  accent bar. Messages two or more days apart get a small "3 days later" label above them.
- Reply, Reply all and Forward sit on one `--soft` row after the last message; their keys show on hover, as the status strip already lists them. An inline reply takes its place.
- Focus mode (`Shift+F`): the conversation over the whole window with the list hidden, until `Shift+F` again.
- Sender logos (Settings → Reading, off by default): a company's logo on white in place of initials, from its own
  website's declared icon, cached for 30 days; shared mail providers (Gmail, Outlook…) keep initials.
- Body: sanitised HTML in an iframe sized to content; tracking pixels (1–2 px or hidden remote images) are removed
  even after images load.
  Mail that is mostly text takes Tern's type (`--t-read`, 15 px / 1.65) and colours and follows dark mode; quotes sit
  behind a 3 px `--line` bar. Mail its sender designed (layout tables with their own colours, wide pictures) keeps its
  look, up to 680 px wide with rounded corners and no well around it; in dark mode it is darkened (backgrounds dark, text light, pictures kept)
  unless Settings → Reading says to keep its colours. Reading view (the book icon) shows a designed mail's words and pictures in
  Tern's colours with a book face. `src/mailview.ts` decides and draws all three.
- Quoted text and signatures collapse behind a `···` pill.
- Attachments strip: file cards on `--soft`, with a type badge (PDF, XLSX…, coloured `--file-*`) or a picture preview once the file is on this computer, name, size and Save; clicking opens it.
- Inline reply box at the bottom when replying (see Compose); `Esc` collapses it and keeps the draft.
- AI (package 10, on request only, shown only when AI is on for the account; redesigned 2026-10-26 from the canvas
  "Tern AI redesign ideas", the owner's picks):
  - Summary, "lede and facts": a quiet "Summarize" (`AI` keycap on `--accent-soft`, `Shift S` on hover) under the
    subject; asked, a lede of one or two sentences in `--t-read` / `--fg-1` with the `AI` keycap inline, then up to
    three chips: Due (`--warn-soft`, clock), Asked of you (`--accent-soft`), Decided (`--ok-soft`, check), and More
    (the 3–5 points), Regenerate and Dismiss at the end of the row. A kept summary shows at once.
  - Suggested replies, "intents first": above the reply row "Suggest replies" with `Q`; asked, "ANSWER WITH" and
    three cards in a row (`--soft`; the pointed one `--bg-0` with a 2 px `--accent` border): a `1`–`3` keycap, a label
    of a few words (Accept, Another time) and the reply's start; under them the pointed reply in full, then Others
    and Dismiss. A click or the digit starts a reply with it above the signature and quote. One column under 760 px.
    Not offered on your own last message.
- Write with AI, "talked through" (redesigned 2026-10-26, canvas boards F and G): an empty draft shows a dashed
  invite under the text ("Write, or press Space and say what to answer"); Space on the empty first line, a click on
  the invite, `Ctrl J` or the `AI` keycap in the footer opens a `--soft` panel. What the person says shows as
  bubbles on the right (`--accent-soft`); each answer as a "Version n" pill, the one on show filled `--accent`
  ("· below"), its text in a `--bg-0` box under them. The field ("Say more, or Tab to keep it", 2 px `--accent`)
  asks again from the version on show; `Tab` keeps it as ordinary text (signature and quote stay; `Ctrl Z` brings
  back what was there), `↑`/`↓` step through versions, `Esc` drops them all. One quiet line says what it reads
  ("Reads this conversation and your style."). It writes from the whole conversation; the draft may be empty.
  Send waits while versions are open ("Keep a version (Tab) or drop them (Esc) before you send.").
  New mail: the same, and the answer also names who it goes to and a subject: To, Cc and Subject show above the
  text, each person matched in the contacts on this computer (the contacts never go to the AI): a found one on
  `--accent-soft` with the address, "also …" to pick another with the same name, "No one called “Zed” in your
  contacts" on `--warn-soft`. Tab fills the fields (Subject only when empty).

### 4.3 Command palette (`Ctrl+K`)

- 560 px wide, centred at 20 % from the top, `--bg-1`, `--r-lg`, `--shadow`. Input at the top with the context on the left as a chip (`Move to`, `Label`, `Snippet`).
- Results: icon-less rows, 36 px, label left, keycap right; matched characters in `--accent`. Groups with `--t-xs` section labels (Recent · Actions · Go to · Labels · Settings).
- `↑/↓` move, `Enter` runs, `Tab` enters argument mode when the command has one, `Esc` steps back.
- Opens in < 50 ms with the first 8 recent commands already rendered.

### 4.4 Compose

- New mail: a centred modal 720 × up to 80 % height, `--bg-1`. Reply: inline at the bottom of the conversation, same internals.
- Top row: the From pill (account colour dot, "From Name · address ▾") when > 1 identity; then, right-aligned,
  "✓ Saved" / "Saving…" in `--fg-2`, and icon buttons Minimize (`Ctrl+Shift+M`), Focus (`Ctrl+Shift+F`) and Close
  (`Esc`, keeps the draft). An inline reply has no Minimize or Focus.
- Field rows: `To` (with `Cc` `Bcc` toggles at its right end, or `Ctrl+Shift+C/B`), then `Cc` `Bcc` when used,
  `Subject`. Labels are `--fg-2` on the left (64 px). Recipients are chips (`--bg-2`, `--r-sm`): initials on
  `--accent-soft`, the contact's name when known (address on hover), remove on `Backspace`. A chip outside the
  sender's organisation (not for public mail services) is on `--warn-soft` with the domain after the name.
- Editor body: `--t-rd`, min 160 px, grows with content. Formatting bar appears only on text selection, floating above the selection: B I U S · link · list · quote.
- Attachments: cards 132 px wide (picture thumbnail, else the file kind's icon; name and size; × on hover) and a
  size bar against 25 MB, `--warn` from 70 %, `--danger` over. Files dragged over the window show a dashed
  `--accent` drop zone over compose.
- Checks before sending, one line each above the footer, never a dialog: "You wrote “u prilogu”, but nothing is
  attached" (Attach… / Send anyway; words in many languages, src/attachmentWords.ts, plus the person's own) and
  "There's no subject" on `--warn-soft`; "x is outside example.com" on `--bg-2` when outside people are mixed
  with the sender's own, dismissible. Sending again while they show sends anyway.
- Footer (above a `--line` rule): split `Send  Ctrl↵` button whose menu holds Send & Done, Send later…, Remind me
  if no reply… with their keys; then attach, snippet and signature as icons; discard as a trash icon at the far end.
- Signature: a pill in the footer ("✎ Full ▾") when the account has any; picking one, or `Ctrl+Shift+S`
  to step through them and None, swaps the signature in the text. Changing From brings the new account's.
- Minimized: the dialog hides (its editor kept) and a 320 px card waits bottom right: subject, recipients, the
  start of the text, Saved. Click or `Ctrl+Shift+M` opens it again; the app's keys work meanwhile.
- Focus mode: compose fills the window, fields hidden behind a one-line summary, the text in a 640 px column at
  16 / 1.7, every paragraph but the caret's at 45 % opacity; word count top right; `Esc` leaves.
- Snippet picker (`;`): a 600 px popover, matches on the left (name, `;shortcut`, keys), and on `--soft` to the
  right the pointed snippet as it would go in, filled for the person written to.
- Autocomplete: dropdown under the field, 5 rows, avatar initials + name + address; `Enter`/`Tab` picks.

### 4.5 Pickers (snooze, send later, remind)

- Small popover anchored to the row (list) or the footer button (compose). Left: 6 presets with their resulting absolute times; right: a text field that parses natural language, result previewed live. `Enter` confirms.

### 4.6 Toasts

- Bottom-right of the list, inside the status strip height, `--bg-3`, `--r-md`. One at a time; newer replaces older. Text + action with keycap (`Undo  Z`). Lives 5 s or until the next action. Sync errors use `--danger` text and persist until dismissed.

### 4.7 Empty state

- Built (2026-10-20): a tern scene a day, drawn in SVG from the app icon's facets (no photos, nothing to licence),
  over the inbox when it is empty (or its Important split). Ten rotate by the day, never one two days running: Pole to
  pole (the migration route, the bird where the day of the year puts it), Flock (one tern per conversation cleared
  today), Two summers, To the Moon and back, Streak (this week, a tern on each Inbox Zero day), Horizon (sun by day,
  moon and stars after 19:00), Colony (a nesting tern per account, in its colour), Your migration (conversations
  cleared this year), The dive (the only animation; still with reduced motion) and Seasons (the coast by month).
  From 22:00 to 05:00 Night shift: a sleeping colony, "Go to sleep." The facts in the lines are the Arctic tern's
  commonly given figures (about 70,000 km a year, 2.4 million km a life, the most daylight of any animal).
- Layout: "side" scenes put the words left (kicker in `--z-kicker`, the time or a count at 56 px, one line) and the
  picture right; "center" ones put the words at the bottom over a full picture. Under 760 px wide the picture steps
  back to 35 % behind centred words. Colours are `--z-*` and `--t1…8` tokens on `.zero`, light and dark.
- Settings → Appearance → Inbox Zero: a different tern each day (default) or one scene. The counts
  are kept with the settings (`zeroLog`), on this computer: what is cleared in another app isn't in them. No buttons.
  `C` still composes.

### 4.8 Settings (`Ctrl+,`)

- Full-screen page over the list with a 232 px left list of sections in three groups, each under a `--t-xs`
  label: General (Appearance · Reading · Notifications · Desktop · AI · About), Writing (Compose · Snippets · Signatures) and
  Accounts (one entry per account, with its colour dot). A search field at the top of the list narrows it to the
  sections whose settings match. Content sits in a 640 px column. Controls are plain: toggles, selects, text
  fields. Every setting has one line of explanation under it.
- Built (2026-10-19), Snippets and Signatures use a wider (1040 px) list-and-detail layout. On the left, a list
  of rows (name, `;shortcut` or "New mail · Replies" in `--fg-2`); the picked row is `--bg-3`, nothing more, and a
  pressed filter pill is `--bg-3` too. Colour is for accounts: a per-account tab is underlined in that account's colour.
  On the right, its editor, with a `--soft` preview at the bottom and a footer that says when it saved.
  Snippets: find field, filter pills (All, each account, Most used), the shortcut checked as it is typed ("Free to
  use" in `--ok`, "Taken by …" in `--danger`), the places as `--accent-soft` chips that insert at the cursor,
  "Available in" (an account) and "Also fill in" (subject, Cc), and a preview written to a made-up person.
  Signatures: a tab per account, the signature in compose's editor (select text to format it), which one goes on
  new mail and which on replies, and above or below the quote as a segmented control. "Format: Write it here / Paste
  from another app" switches the editor for a paste box (a dashed `--line` border; Ctrl+V keeps the copied formatting),
  the HTML source in `--mono` folded under "Edit the HTML", a `--warn-fg` note when a picture has no web address, and the preview shows it in a
  white frame. In compose an HTML signature sits under the text in the same white frame, not in the editor.
- Built (2026-10-26), AI: four steps, each with a 26 px mark (a check on `--ok` once done, the number on `--accent`
  while it is the one to do, `--bg-3` after): Who answers (three provider cards, the picked one `--bg-0` with a 2 px
  `--accent` border), Your key, Mail it may read (accounts, the address filter), What it may do (a `--soft` table:
  feature and key, what goes to the provider when asked, a checkbox; a footer line on what never goes). Then "Review
  and turn on" opens the privacy sheet; once on, a status line at the top (On · provider · model, Turn off), two
  cards (Today: tokens against the daily limit as a meter; Advanced: model and daily limit), "Your writing style"
  per account, and what is kept with Delete AI cache.
  Writing style: after Learn, "Does this sound like you?" (made-up notes written plainly and in the person's style,
  the second with a 2 px `--accent` border, what it picked up as `--accent-soft` tags; Sounds like me, Adjust the
  note, Don't use a style). After that the note shows as parts on `--soft`: greetings and sign-offs as removable
  chips, Length and Tone as segmented controls, habits as a list, with "Edit as text" and Forget.

### 4.9 Account setup

- One centred card, 440 px. Step 1: email address only. Step 2: "Continue with Google / Microsoft" button or the password form, with the detected server names shown and editable under "Advanced". Step 3: progress sentences ("Connecting… Found 14 folders… Fetching the newest mail…") and the inbox fades in behind as soon as the first page exists.

### 4.10 Calendar panel (`0`)

- 320 px right panel, `--bg-1`. Date header, hour grid 48 px per hour, now-line in `--accent`, events as rounded blocks in the calendar's colour with title and time; all-day row on top. Week view: 7 columns, 20 px per hour, titles only.

### 4.11 Attachment viewer

- Full-window overlay, `rgba(0,0,0,.85)`, content centred, filename + size + `Open with system` + `Save` top-right, arrows for next/previous, `Esc` closes.
- Built: `--viewer-scrim` (dark in both themes, blurred behind), filename with size and "n of m" top-left. `V` in a
  conversation or a click on a file card opens it; `←`/`→` step through the message's files, `Ctrl S` saves.
  Pictures fit and click to full size; PDFs show in the web view's own reader; text shows in mono and `.csv`/`.tsv`
  as a table; sound and video play. Other kinds show "Open with system".

## 5. Interaction rules

- Focus is always visible and always exactly one place: a row, a message, a field, or a palette item.
- `Esc` goes one level up, never two. Palette → pane → list → clears selection.
- Actions on the selection if non-empty, else the focused item. The toast says which: "Archived 12 conversations".
- Destructive actions (trash, discard, mark all done) never confirm; they undo. Exception: emptying Trash/Spam.
- Hover reveals, never moves: a hovered row shows star and the action strip (archive, snooze, star, more) over the date without shifting content.
- Scroll keeps the focused row inside the middle 60 % of the viewport; `j`/`k` never cause a jump of more than one row.
- Text selection inside a message does not trigger single-key shortcuts, except `r`: with text selected, the reply
  quotes just that (quick quote) and shows the quote unfolded. Typing in any input never triggers them.
- Long operations (initial sync) show progress in the status strip, never a modal.

## 6. Accessibility

- All text meets WCAG AA against its background in both themes (check with the token table; `--fg-2` on `--bg-0` is the tightest pair, keep it ≥ 4.5:1).
- Rows are `role="row"` inside `role="grid"` with `aria-selected`; the live region announces the toast text.
- Every icon-only control has an `aria-label` and a tooltip with its key.
- Keyboard sheet (`?`) is the documentation; nothing is mouse-only.
- Font size `Ctrl+=`/`-`/`0` scales the whole UI (root `font-size`), not just mail bodies.

## 7. Review checklist (every UI PR)

```
[ ] Uses tokens only — no raw hex, px for type, or ms in component CSS
[ ] Light and dark screenshots attached to the PR, dense density
[ ] Focus visible at all times; Esc behaves per §5
[ ] Keys shown on hover / in the palette for every new action
[ ] j/k input-to-visible-response p50/p95 measured on a 10k list during sync; no visible lag/focus jumps (attach evidence; do not substitute signal-update timing)
[ ] Resize to 720 × 480 and to 1920 wide: nothing overlaps or clips
[ ] prefers-reduced-motion respected
[ ] Empty, loading (> 300 ms), error and offline states exist for the new screen
[ ] Bundle size printed by `vite build` is within budget and noted in the PR
[ ] Copy is short, plain, sentence case, no exclamation marks
```

## 8. Prototyping

Before building a new screen, the agent may drop a static HTML/CSS prototype using the token file in
`docs/design/prototypes/<screen>.html` and link a screenshot in the PR or chat for the owner's reaction.
Prototypes are throwaway; delete them once the real component lands.

## 9. Open questions for the owner

- Empty-state imagery: curated photos (Superhuman-like) or generated gradients? Photos need licences (Unsplash licence is fine).
- Accent colour: the indigo above or something closer to Omarchy's current theme accent?
- Should the rail be pinnable at all, or always a slide-over like Superhuman?
