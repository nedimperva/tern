# M2 focused Linux beta: acceptance checklist

The owner ticks these against real accounts and a real window; agents never tick them. Mark a check
`- [x] (owner YYYY-MM-DD, account)` when it passed, or leave a note under it when it did not. The milestone's exit
evidence is in [PLAN.md](../PLAN.md): real Fastmail and Gmail checks pass, testers use Tern for several weeks, no
known mail-loss or unsafe-retry blockers, installation and recovery documented. Version under test: 0.3.6 or later.
The [M1 checklist](m1-alpha.md) still applies; this one adds what M2 brought. Testers follow [docs/beta.md](../beta.md).

## Installing and updating (package 14)

- [ ] Fresh Omarchy (or a new user): the AppImage from the release starts, adds an account, syncs.
- [ ] An installed AppImage of the previous release shows "Update ready · Restart" within a day of a new release;
      the restart opens the new version with mail, drafts and settings intact.
- [ ] Upgrading to a version with a newer database leaves `mail.db.before-v<N>` beside `mail.db`; following
      "Going back" in docs/beta.md opens the earlier version with its mail.
- [ ] Settings → About: the version is right, Copy gives details without any address, Open folder shows
      `tern.log`, Report a problem opens the GitHub form with the version filled in.

## Fastmail (the first supported provider)

- [ ] Add a Fastmail account with an app password: Inbox, Archive, Sent, Drafts, Trash, Junk get their roles.
- [ ] The M1 Sync, Compose, Attachments and Failures checks pass on this account.

## Gmail (app password; package 04)

- [ ] Add a Gmail account with an app password: All Mail downloads ("Downloading mail: X of Y", then "Up to
      date"); Gmail's Important and Starred are not in the folder list; labels are under Labels in the rail.
- [ ] A label's view lists the same conversations as Gmail's web; counts match.
- [ ] Archive from the inbox: gone from Gmail's inbox, still under All Mail and its labels, shown once in Tern.
- [ ] `l` adds a label and removes it; Gmail's web shows each after 5 s; `Z` undoes either.
- [ ] Search finds an inbox message once, not once per label.
- [ ] Trash and Spam behave as in Gmail's web.

## Desktop (package 08)

- [ ] Window closed: Tern stays in the tray; the dot shows while there is unread mail.
- [ ] New mail notifies (Important only by default); Archive and Reply on the notification work; quiet hours stay
      quiet.
- [ ] Pause sync from the tray: nothing goes out until Resume; Resume sends what waited.
- [ ] `mailto:` links and the launcher's Compose action open compose, with Tern running and not.
- [ ] Start at login starts Tern in the tray.

## Triage (package 05)

- [ ] Important and Other split a real inbox sensibly; moving a sender sticks.
- [ ] Snooze for 2 minutes: gone, then back unread; with Tern quit over the due time, back at the next start.
- [ ] Send later for 2 minutes arrives on time; one due while Tern was quit waits as "scheduled send to confirm".
- [ ] Remind me if no reply for 2 minutes: "No reply yet" pins the conversation and notifies; a reply cancels it.

## Search and progress (package 06)

- [ ] A fresh account says "Downloading mail" with counts that reach the total, then "Up to date".
- [ ] Searching old mail says how much of its text is here.

## Tester group

- [ ] At least three testers outside the owner have installed it, each with their own provider, and reported
      at least once (an issue or a "works for me").
- [ ] Several weeks of daily use by the owner and testers with no open mail-loss or unsafe-retry issue.
