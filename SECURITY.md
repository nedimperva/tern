# Security policy

Tern handles mail and account passwords, so security reports are welcome and taken seriously.

## Supported versions

Tern is in early alpha. Only the latest release gets security fixes.

| Version | Supported |
|---|---|
| Latest 0.3.x release | Yes |
| Anything older | No |

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Report it privately through GitHub: open the repository's **Security** tab and choose
[**Report a vulnerability**](https://github.com/nedimperva/tern/security/advisories/new). Include:

- what the problem is and what an attacker could do with it,
- steps or a sample message that reproduce it,
- the Tern version and your operating system.

Tern is maintained by one person, so timelines are best effort. You can expect an acknowledgement within a
week, and updates as the fix progresses. Once a fix is released, the advisory is published, with credit to you
unless you'd rather stay anonymous.

## What is in scope

The areas that matter most:

- **Rendering received mail.** Script execution, sandbox escapes, remote content loading without the user's
  consent, or tracking that gets past "Load images".
- **Credentials.** Passwords leaving the OS keyring, or being written to the database, logs or files.
- **Transport.** TLS downgrades, certificate checks being skipped, or STARTTLS stripping.
- **Mail safety.** Sending, deleting or moving mail the user did not ask for.
- **The desktop shell.** Ways for mail content to reach Tauri commands, the file system or other programs.

Out of scope: issues that need an already compromised machine or keyring, and problems in a mail server itself.
