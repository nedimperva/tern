# M1 private alpha: acceptance checklist

The owner ticks these against a real account and a real window; agents never tick them. Mark a check
`- [x] (owner YYYY-MM-DD, account)` when it passed, or leave a note under it when it did not. Each line says what
to do and what to look for. The milestone's exit evidence is in [PLAN.md](../PLAN.md); the package files keep
their own acceptance lists, and this page gathers the alpha's in one place. Version under test: 0.2.x.

Use a mailbox you can afford to lose changes in. The plan names Fastmail; the owner's IMAP/SMTP work account is
fine for the checks it can show, and the account used goes in the tick.

## Sync and reading (packages 00, 01, 02)

- [ ] Add the account. The folder list shows Inbox, Archive, Sent, Drafts, Trash and Junk with the right roles.
- [ ] A fresh account shows its newest mail within about 10 s; older mail keeps arriving behind it.
- [ ] Send yourself a message from another client: it appears in the list in under 2 s without touching anything.
- [ ] Star or read a message in the provider's web mail: Tern shows it within a few seconds (inbox) or 5 min (other folders).
- [ ] Conversations: a thread with replies shows as one row with a count; opening it shows every message, oldest first.
- [ ] HTML mail renders; remote images stay blocked until "Load images"; "Always for this sender" remembers.
- [ ] Triage 50 conversations with keys only (`j k e s # ! Enter Esc`); nothing needs the mouse.
- [ ] Archive, star, mark read: instant here; `z` within 5 s takes it back; after 5 s the web mail shows it.

## Compose, drafts and sending (package 03)

- [ ] Reply to a thread from Tern; the web mail shows it in the same thread with the quote.
- [ ] Reply-all leaves your own address out; forward carries the original's attachments.
- [ ] Close Tern mid-draft and open it again: the draft is there; the server's Drafts has one copy, not several.
- [ ] Send with two attachments; they arrive intact in another client; a copy is in Sent.
- [ ] Undo send within the window: the message comes back as a draft and never leaves.
- [ ] Signature appears above the quote; recipient autocomplete suggests people you write to.

## Attachments (package 07)

- [ ] A received attachment opens in the system's program from its chip; the arrow saves it where you pick.
- [ ] In a conversation, collapsed messages with files show a paperclip; older mail lists its files after it re-downloads.

## Failures and offline (package 08)

- [ ] Pull the network: the strip says offline or "Can't reach …"; archive still works; "N changes waiting" appears.
- [ ] The waiting list shows each change; Discard takes one back as undo would.
- [ ] Network back: changes go out within a few seconds, without the one-minute wait; the strip clears.
- [ ] A refused send (bad address) shows under "didn't go through" with Edit, Retry and Discard.
- [ ] Restart Tern with changes still waiting: none are lost, and none are sent twice.

## Search (package 06)

- [ ] Words find mail by subject, sender and body as you type.
- [ ] `from:` `to:` `subject:` `is:unread` `has:attachment` `in:sent` `before:` `newer_than:7d` narrow as expected.
- [ ] `-word` and `-in:archive` leave things out; `"exact phrase"` matches as written; `OR` takes either word.
- [ ] `e`, `s`, `#` work on search results; `Esc` clears the search.
- [ ] With old mail not downloaded, the note under the search box says those were searched by sender and subject only.

## Platform

- [ ] Linux (Omarchy/Hyprland): the window opens, fonts look right, the password is kept in the keyring across restarts.
- [ ] Windows: the same checks still work (the release itself is M3).
