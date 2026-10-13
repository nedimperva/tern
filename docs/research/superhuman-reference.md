# Superhuman reference

What we are matching, and where we deliberately differ. Source: Superhuman's public feature pages, help
centre and the published "Keyboard Shortcuts v8 — Windows & Linux" sheet (October 2026). Re-check the sheet
before implementing a sprint's keys; they occasionally change.

## Feel

- **One list, one conversation.** No folder tree on screen by default. The sidebar is a slide-over.
- **Density.** 13 px rows, one line per conversation: participants · subject · snippet · date. Unread is bold,
  not coloured. Chips for labels, a dot for the account in unified views.
- **Everything is a command.** `Cmd+K` lists every action with its key. Keys are shown next to actions in
  menus and in the empty hint strip. `?` opens the sheet.
- **Immediate.** Actions take effect before the server hears about them; the next conversation is focused
  instantly; a small toast at the bottom offers undo.
- **Inbox Zero is celebrated.** Full-screen background image, the time, a sentence.
- **Muted palette.** Near-black and off-white backgrounds, one accent, greys for everything else; thin
  separators; no borders around cards; focus ring is a left bar + background tint, not an outline.
- **Compose is calm.** Fields fade when not focused; formatting toolbar appears on selection; the quote is collapsed.

## Features and where they land

| Feature | Sprint | Notes |
|---|---|---|
| Split Inbox (Important / Other / custom) | 5 | Rules + Gmail Important |
| Mark Done (`e`), Mark Not Done (`Shift+E`) | 0/2 | Archive semantics |
| Remind Me / Snooze (`h`) | 5 | Natural-language picker |
| Follow-up reminders on send | 5 | "If no reply in …" |
| Send Later | 5 | Local scheduler, honest about needing the app running |
| Undo Send | 3 | Outbox delay |
| Snippets (`;`) | 7 | Variables |
| Instant Intro | 7 | Reply-all, move introducer to bcc |
| Quick Quote | 7 | Select text, `r` |
| Autocomplete | 3 | Ranked contacts |
| Autocorrect | — | Browser spellcheck in the editor; not a feature |
| Unsubscribe (`Cmd+U`) | 5 | RFC 8058 / mailto |
| Block | 5 | Rule |
| Mute (`m`) | 5 | |
| Mass archive | 5 | |
| Attachments | 7 | Viewer, drag |
| Read Statuses / Recent Opens | **never** | Tracking pixels |
| Instant Open / Copy / Send | 2/3 | Just speed |
| Offline support | 0 | Local-first by design |
| Calendar: See your day/week (`0`, `0 0`), Create Event, Share availability, Meet/Zoom/Teams join | 9 | CalDAV |
| AI: Write with AI, Instant Reply, Auto Summarize, Ask AI, Auto Labels, Auto Archive, Auto Reminders | 10 | BYO key; Auto Archive later |
| Team features (shared conversations, comments, shared drafts, team snippets) | **never** | Needs a server |
| Tabs / multiple windows (`Cmd+T`, `Cmd+N`) | backlog | |
| Switch accounts (`Ctrl+1…9`) | 4 | |

## Keyboard sheet (Windows & Linux edition)

Tern uses these as-is unless marked. `Cmd` on the sheet is `Ctrl` on Linux/Windows.

### Actions
| Key | Action |
|---|---|
| `Ctrl+K` | Superhuman Command (palette) |
| `/` | Search |
| `Z` | Undo |
| `Ctrl+J` | Ask AI (Tern: `Ctrl+Shift+K` to avoid clashing with "Write with AI" in compose) |
| `X` | Select conversation |
| `Shift+J` / `Shift+K` | Add to selection downwards / upwards |
| `Esc` | Clear selection / back |
| `Shift+X` | Select all from here |
| `Ctrl+A` | Select all |
| `L` | Add or remove label |
| `Y` | Remove label |
| `]` / `[` | Remove label and go to next / previous |
| `Shift+Y` | Remove all labels |
| `V` | Move |
| `E` | Mark Done (archive) |
| `Shift+E` | Mark Not Done |
| `H` | Remind Me (snooze) |
| `S` | Star |
| `U` | Mark read or unread |
| `#` | Trash |
| `!` | Mark spam |
| `M` | Mute |
| `Ctrl+U` | Unsubscribe |

### Go to (`G` then key)
| Key | Where |
|---|---|
| `G I` | Inbox / Important |
| `G O` | Other |
| `G S` | Starred |
| `G D` | Drafts |
| `G T` | Sent Mail |
| `G E` | Done |
| `G H` | Reminders |
| `G M` | Muted |
| `G ;` | Snippets |
| `G !` | Spam |
| `G #` | Trash |
| `G A` | All Mail |
| `G L` | Label… |

### Conversations and messages
| Key | Action |
|---|---|
| `J` / `K` | Next / previous conversation |
| `Enter` | Open conversation (in list) · Reply all (in conversation) |
| `R` | Reply |
| `F` | Forward |
| `C` | Compose |
| `N` / `P` | Next / previous message |
| `O` | Expand message |
| `Shift+O` | Expand all messages |
| `Ctrl+O` | Open links & attachments |
| `Tab` | Cycle through links & dates |
| `Tab` / `Shift+Tab` | Next / previous split (in list) |
| `Space` / `Shift+Space` | Scroll down / up |
| `Ctrl+↑` / `Ctrl+↓` | Jump to top / bottom |
| `Ctrl+;` | Use snippet |
| `Ctrl+Shift+I` | Instant Intro |
| `Ctrl+Shift+H` | Remind me (compose) |
| `Ctrl+Shift+L` | Send later |
| `Ctrl+Enter` | Send |
| `Ctrl+Shift+Enter` | Send & Mark Done |
| `Ctrl+Shift+,` | Discard draft |
| `Ctrl+Shift+B` | Move contacts to bcc |
| `Ctrl+Shift+C` / `Ctrl+Shift+B` | Cc / Bcc field |
| `Ctrl+Shift+F` | From field |
| `Ctrl+Shift+S` | Edit subject |
| `Ctrl+Shift+A` | Attach |

### Filters (in a list)
`Shift+U` unread · `Shift+S` starred · `Shift+I` important · `Shift+R` no reply (Tern: via palette in v1).

### Calendar
`0` open day · `0 0` open week · `T` today · `P`/`N` previous/next · `Ctrl+Shift+E` create event (Tern).

### Format (compose)
`Ctrl+B/I/U` · `Ctrl+K` link · `Ctrl+Shift+X` strike · `Ctrl+Shift+7` numbers · `Ctrl+Shift+8` bullets · `Ctrl+Shift+9` quote · `Ctrl+]`/`[` indent/outdent.

### Navigation
`Ctrl+\` sidebar (Tern) · `Ctrl+,` settings (Tern) · `Ctrl+1…9` switch account · `Ctrl+=`/`-`/`0` font size · `Ctrl+Shift+P` perf overlay (Tern dev) · `?` shortcut sheet.

## Where Tern differs on purpose

- No tracking (read statuses), no team features, no server.
- Works with any IMAP server, not only Gmail/Outlook.
- AI is optional and runs against the user's provider or local model.
- Snooze/Send-later are honest about running locally; Superhuman does them server-side.
