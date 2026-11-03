# Package 17, first slices (branch `sprint/17-companion`): acceptance checklist

The owner ticks these with a dev build; agents never tick them. Mark a check `- [x] (owner YYYY-MM-DD, Linux)`
when it passed, or leave a note under it when it did not. Built overnight on 2026-11-02, one commit a slice; each
was tried on the browser's fake backend only, so this is the first run in the real app.

## Before you start

- [ ] `git switch sprint/17-companion`, then `scripts/dev-mail-server.sh start` in one terminal and
      `scripts/dev-mail-server.sh tern` in another. The dev database (`<app data>/dev/mail.db`) moves to schema 32;
      the installed Tern's `mail.db` is not touched. Don't run a release build of this branch over the real
      database without a backup.
- [ ] `scripts/dev-mail-server.sh seed 5` gives a few senders to work with.

To send a test mail with your own headers (the one-click case below), with `D=~/.local/share/tern-devmail`:

```bash
printf 'From: Weekly News <news@list.example>\r\nTo: test@localhost\r\nSubject: Weekly issue 1\r\nMessage-ID: <w1-%s@list.example>\r\nDate: %s\r\nList-Unsubscribe: <mailto:leave@list.example>, <https://httpbin.org/post>\r\nList-Unsubscribe-Post: List-Unsubscribe=One-Click\r\n\r\nThis week.\r\n' "$(date +%s)" "$(date -R)" | SSL_CERT_FILE="$D/tls/trust-bundle.pem" curl -sS --user "test@localhost:$(cat $D/test-password)" --url smtps://localhost:1465 --mail-from test@localhost --mail-rcpt test@localhost --upload-file -
```

httpbin.org is an outside site that answers any POST; only `List-Unsubscribe=One-Click` goes to it. Swap in a
webhook.site address of your own to see exactly what arrives.

## Companion (H)

- [ ] Open a conversation with `i`. Under the name, on one row: Write, Copy address, and a drop-down (Important,
      Other, Blocked). The buttons have a thin edge; the drop-down sits on the right.
- [ ] Write opens compose to them. Copy address says "Copied" and the address is on the clipboard.
- [ ] "Recent with {name}" is a card. The open conversation isn't in it. Unread ones have a dot and a bold subject.
      Each row shows a line of its newest text.
- [ ] Clicking a row opens that conversation, scrolled to that message.
- [ ] The last row, "All mail from {name} · N →", puts `from:` them in the search box.
- [ ] Tab reaches every row and button in the column with a visible ring; Enter on a row opens it and does not
      start Reply all.
- [ ] The drop-down: Other says "{name}: Other from now on" with Undo, and the conversation moves split.

## Sidebar Ctrl numbers (J)

- [ ] With two accounts or more, hold Ctrl: each account shows "Ctrl 1", "Ctrl 2" … at its right. Letting go, or
      switching windows with Ctrl held, hides them. One account shows none.

## One-click unsubscribe (D)

- [ ] Send the test mail above. It lands in Other. Open it: the Unsubscribe icon is there.
- [ ] `Ctrl+U`: "Unsubscribed from Weekly News" with Undo, and the conversation goes to Done.
- [ ] The status strip lists "Unsubscribe from Weekly News" while it waits, then it goes; with webhook.site, one
      POST arrives whose body is exactly `List-Unsubscribe=One-Click`, with no cookies or Referer.
- [ ] Again with a second mail, then `z` within 5 seconds: the conversation is back and nothing is sent.
- [ ] A mail with only `<mailto:…>` (drop the https part and the Post line): `Ctrl+U` opens compose to that
      address, as before. One with an https link but no Post line: the page opens in the browser.
- [ ] Point the link at `https://httpbin.org/status/404`: it goes to the problems list at once (no retries).
      `https://httpbin.org/status/503` retries.

## Block (C)

- [ ] In a conversation, the `…` menu and `Ctrl+K` have "Block {name}" and "Block everyone at {domain}". The name
      is the person the companion shows, not whoever wrote last.
- [ ] Block {name}: "Blocked {name}" with Undo, and the conversation goes to Done. `z` puts it back and unblocks.
- [ ] Blocked through the companion's drop-down: the same.
- [ ] After blocking, a new mail from them (seed, or the curl line with their address) arrives read in Archive,
      not in the inbox, and search finds it. No notification.
- [ ] Mail from them that was already here stays where it was.
- [ ] Block everyone at a domain, then set one address there to Important in the companion: that address's mail
      comes to the inbox again, the rest of the domain stays blocked.
- [ ] Settings → Senders: "Your choices" lists Blocked, To Other and Kept in Important, each with Unblock, To
      Important or Forget, and they work.

## New people, the screener (C)

- [ ] Settings → Senders: New people is Off. Turn it On; "People you know at" appears.
- [ ] Mail already in the inbox stays where it is.
- [ ] With it On, New people is in the sidebar under Inbox, always (`g n` goes there). Empty, it says "Nobody new".
- [ ] `scripts/dev-mail-server.sh seed 3`: the three new senders appear in New people, a row each with name and
      address, not in Important, with no notification. The sidebar counts 3, and a line above Important says
      "3 new people want to write to you · Screen them"; clicking it opens New people.
- [ ] Two conversations from one stranger make one row, with a 2 beside the name. Opening one: the companion's
      drop-down says Waiting.
- [ ] Mail from someone you have written to goes to Important. So does a list mail to Other, as before.
- [ ] In New people: `y` lets the focused person in (toast with Undo, all their mail moves to Important), `Shift+O`
      sends them to Other, `Shift+X` blocks them (all their conversations go to Done). The status strip shows these
      keys. Enter opens the mail as usual; choosing in the companion's drop-down does the same.
- [ ] Their next mail goes straight to Important (or Other).
- [ ] Add `localhost` to "People you know at", then seed again: nothing goes to New people.
- [ ] Turn the screener Off: whatever waited shows in Important; New people leaves the sidebar.

## Beta channel (A)

- [ ] Settings → About shows "Updates: Stable / Beta" only in the AppImage and on Windows, not in a dev build
      (dev builds never update; check the row is missing there).
- [ ] Not testable until a beta is tagged: push a `v2.0.0-beta.1` tag (with its CHANGELOG section) from a test
      branch, publish the draft, and check the `beta feed` workflow made a `beta` release holding
      `latest-beta.json`. If the Windows build fails on the MSI version, see Decisions in the sprint file.
- [ ] An installed 1.9.0 AppImage switched to Beta updates to the beta; one on Stable doesn't.

## Found while testing

- [ ] From an empty list (an empty New people tab, an empty folder) back to the inbox: no flash of Inbox Zero
      before the conversations show.

## Upgrade

- [ ] Copy the installed database to the dev path (SQLite backup), start the branch: it opens at schema 32, your
      Important/Other choices from 1.9 still hold (Settings → Senders → Your choices lists them).
