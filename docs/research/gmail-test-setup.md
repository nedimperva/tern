# Gmail test setup (owner, M0)

What the owner prepares so the [IMAP vs API comparison](gmail-backend-decision.md) can run against a real
account. About an hour, most of it seeding mail. Nothing here touches a primary inbox.

## 1. Test account

- [ ] Create a new consumer Gmail account used only for Tern, e.g. `tern.test.<something>@gmail.com`.
      Turn on 2-step verification (Google requires it for some security settings; it also mirrors real users).
- [ ] If intended beta users include **Google Workspace**, say so in the decision record: Workspace admins can
      block third-party apps or IMAP, which changes the comparison. A Workspace test account can come later.

## 2. Seed representative mail

The comparison needs every case it measures. From another account (any other) send, and in
the test account arrange:

- [ ] At least 300 messages, so paging and first-page timing mean something. A short script or a
      mailing-list signup (a few newsletters) fills this quickly.
- [ ] 5+ threads with 3+ replies each, including one where the subject changes mid-thread.
- [ ] 5 messages with attachments (one over 10 MB, one PDF, one image).
- [ ] 4 user labels; put some messages under 2 labels at once; one nested label (`Parent/Child`).
- [ ] 2 starred, some read and some unread, 3 archived (out of Inbox but kept), 2 in Trash, 1 in Spam.
- [ ] 2 drafts (one a reply draft), and several sent messages.
- [ ] In Gmail settings → Labels, leave one user label with "Show in IMAP" **off**; the probe checks how
      each backend sees it.

## 3. Google Cloud project

Follow [Gmail OAuth → Setup](gmail-oauth.md#setup-owner-during-m0), with these settings for the comparison:

- [ ] Project name `tern-mail`. **Record the creation date**: quota rules differ for projects created after
      May 1, 2026 (see the decision checklist).
- [ ] Enable **Gmail API**.
- [ ] Audience: External, publishing status **Testing**, test user = the test account.
- [ ] Scopes: add **both** `https://mail.google.com/` (IMAP path) and
      `https://www.googleapis.com/auth/gmail.modify` (API path), plus `openid` and `email`. Both are needed
      only so the probe can compare; the shipped app requests one, per the decision.
- [ ] OAuth client: **Desktop app**, named `Tern desktop`. Download its JSON.
- [ ] In APIs & Services → Gmail API → Quotas, note the per-user and per-project limits shown for this project.

## 4. Hand-off

- [ ] Save the downloaded client JSON as `secrets/google-client.json` in the repo checkout. `secrets/` is
      git-ignored. A desktop client secret is not confidential by Google's definition, but it stays out of git
      until the decision says how it ships.
- [ ] Tell the agent the test address and the project creation date. **Never share the account password**:
      the probe signs in through the browser consent screen.

Refresh tokens in Testing mode expire after 7 days; expect to re-consent weekly while probing.

## Status

Owner asked to start Gmail preparation in M0 (2026-10-13). Not started by the owner yet.
