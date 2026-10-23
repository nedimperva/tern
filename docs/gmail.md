# Gmail and Google Workspace

Tern reads Gmail over IMAP and sends over SMTP, like any other account. It can sign in two ways:

| | Continue with Google | App password |
|---|---|---|
| How | Google opens in your browser; you pick the account and allow access | You create a 16-letter password in your Google account and paste it into Tern |
| Password stored | None. Tern keeps a Google token in the system keyring | The app password, in the system keyring |
| Needs | A Tern build with a Google client (see below) | 2-Step Verification on the Google account |
| Ends when | You remove Tern's access in your Google account | You delete the app password, or change your Google password |
| Works for | Gmail and Google Workspace | Gmail; Workspace if the admin allows it |

Either way, mail goes straight between your computer and Google. No server of Tern's sits in between.

## Continue with Google

1. In **Add an account**, choose **Continue with Google**.
2. Pick the account in the browser and allow access. You can close the tab when it says so.
3. Tern checks the sign-in against Gmail and starts syncing.

An account added with an app password can switch: **Settings → the account → Switch to Google sign-in**. Tern then
forgets its copy of the app password. Delete the app password in your Google account too, since it still works
until you do.

If Google later stops accepting the sign-in, the status line says so. Use **Settings → the account → Sign in
again**.

Tern asks Google for the `https://mail.google.com/` scope, the only one IMAP and SMTP accept, plus your address
(`openid`, `email`). It does not use the Gmail API.

## App password

1. Turn on [2-Step Verification](https://myaccount.google.com/signinoptions/twosv) for the Google account.
2. Create an app password at [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords).
3. In **Add an account**, enter your address and paste the app password. The server settings fill in
   themselves (`imap.gmail.com:993`, `smtp.gmail.com:465`, both TLS).

Google does not offer app passwords for accounts in Advanced Protection, and Workspace admins can turn them off.

## Building Tern with Google sign-in

"Continue with Google" needs an OAuth client: an ID Google gives to an app, under a Google Cloud project. The
source code doesn't include one. Each one belongs to whoever created it, and Google holds that person responsible
for it. When you build Tern yourself, you create your own. It's free and takes about ten minutes. Without one, Tern
builds and works as usual and offers app passwords for Gmail.

### 1. Create the client

In the [Google Cloud console](https://console.cloud.google.com/):

1. **Create a project**, for example `tern-mail`.
2. **APIs & Services → Library**: enable the **Gmail API**. Tern doesn't call it, but this makes Gmail's scopes
   show up in the scope list.
3. **Google Auth Platform → Branding**: give the app a name (for example `Tern`) and your support email.
4. **Audience**: choose **External**. Leave it in **Testing** for now and add each Google account that will sign in
   under **Test users**.
5. **Data access → Add or remove scopes**: add `https://mail.google.com/`. Google lists it as restricted, which
   only matters if you publish (see the publishing status table below).
6. **Clients → Create client**: type **Desktop app**, any name. Download the JSON file.

A desktop client has no redirect URLs to set. Tern listens on `127.0.0.1` on a free port for the one redirect and
protects the exchange with PKCE. Google treats a desktop client's secret as not confidential, because anyone can
read it out of an installed app.

### 2. Give it to the build

The build bakes the client into the app (`src-tauri/build.rs`). It reads, in this order:

1. the environment variables `TERN_GOOGLE_CLIENT_ID` and `TERN_GOOGLE_CLIENT_SECRET`;
2. the file `secrets/google-client.json` in the checkout. Save the downloaded JSON there. Git ignores the
   `secrets/` folder, so it never ends up in a commit.

```sh
mkdir -p secrets
cp ~/Downloads/client_secret_*.json secrets/google-client.json
npm run tauri build      # or: npm run tauri dev
```

Release builds made by `.github/workflows/release.yml` take the two values from repository secrets of the same
names. In a fork, add them under **Settings → Secrets and variables → Actions** to get Google sign-in in your
releases.

### 3. Publishing status

What Google allows depends on the project's publishing status, set under **Audience**:

| Status | Who can sign in | Sign-in lasts | Cost |
|---|---|---|---|
| Testing | Only the test users you list (up to 100) | 7 days, then sign in again | Free |
| In production, not verified | Anyone, after a "Google hasn't verified this app" warning (Advanced → Go to the app). 100 accounts over the project's whole life | Until revoked, or unused for about six months | Free |
| In production, verified | Anyone, no warning | Until revoked | Google's verification, including a yearly security assessment by an approved assessor, which is paid |

For yourself, family or a small team, **In production, not verified** is the practical choice: no weekly
sign-in, and no cost. The 100-account limit counts every account that ever signs in, including your tests, and
can't be reset. Verification is only needed to offer Gmail sign-in to the public. See Google's
[restricted scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification).

### 4. Sharing your build

A build with your client can go to friends as it is, the installer from `src-tauri/target/release/bundle/` (or
`target/release/bundle/`). Build it with updates off, or the first release it updates to replaces it with one
that has no Google sign-in, and their Gmail stops syncing:

```sh
TERN_NO_UPDATES=1 npm run tauri build      # PowerShell: $env:TERN_NO_UPDATES=1; npm run tauri build
```

That copy never checks for updates; give your friends a new installer when you want them on a newer Tern. Each of
them counts towards the 100 accounts, and in **Testing** each must be on your test-user list first.

## When something goes wrong

- **"Access blocked" or "Error 403: access_denied" in the browser.** The project is in Testing and the account is
  not a test user. Add it under **Audience → Test users**, or publish the app.
- **"Google hasn't verified this app".** Expected for a project you created and haven't verified. Choose
  **Advanced → Go to (your app's name)**.
- **Signed in, but Gmail refused it.** Workspace admins can turn off IMAP or third-party app access for their
  domain. Ask the admin, or use an app password if that's allowed.
- **Asked to sign in again every week.** The project is still in Testing. See the publishing status table above.
- **No "Continue with Google" button.** The build has no Google client. See
  [Building Tern with Google sign-in](#building-tern-with-google-sign-in).
