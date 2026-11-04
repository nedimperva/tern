# Todoist: the decision gate (package 17 G)

Decided 2026-11-04, when the owner asked for the integration to be built.

## API

- **Todoist API v1**, `https://api.todoist.com/api/v1`, which replaced REST v2 and Sync v9. Tern uses two REST
  endpoints: `POST /tasks` (create) and `GET /projects` (list, paged with `results` and `next_cursor`). The client also
  reads a plain array, in case a project list ever comes unpaged.
- Auth: `Authorization: Bearer <token>`.
- The task's link is `https://app.todoist.com/app/task/<id>`.
- Limits: Todoist caps requests per user per 15-minute window (check the current figure in its docs). Tern makes one
  request per task and one project list per opened task box or Settings page, far below any such cap. A 429 is
  retried like any other busy server.
- Not checked against the live API from this machine: the client is tested against a canned local server
  (`todoist::tests`). The first real token is the check.

## Signing in

- **A personal API token**, pasted in Settings → Todoist and kept in the keyring as `todoist` (service `tern-mail`),
  like the AI keys. Never in SQLite or files. The owner leaned this way, and it needs no shipped secret.
- OAuth needs a client secret on the token exchange. A desktop app can't keep one, so it waits until Todoist offers
  PKCE for public clients.
- Connect checks the token by listing the projects before keeping it. Forget deletes it; tasks already made stay.

## What leaves the computer

Only when the person adds a task (`t`, the Tasks row, or Add task beside something asked or due in the brief):

- the title and the day as typed (`due_string`, which Todoist reads itself);
- the project and the label (`@mail` by default, set in Settings);
- one description line: "From {sender} · {subject}", under the note if the person kept one in the box (Fill with AI
  proposes it from the mail; it goes only if it is still there when they press Enter).

Never the mail's text, its files or addresses beyond the sender's name.

## How it runs

- A task is queued in the outbox (`OutboxOp::Task`) with the usual 5-second undo. The `tasks` row (schema v34) shows
  in the conversation at once, and undo deletes it.
- The account's worker sends it with the rest of the outbox. A 4xx other than 429 is permanent
  (`todoist::Refused`) and waits in the problems list, as does a missing token. Anything else retries.
- Tern never asks Todoist anything in the background. Reading a task's state back (done in Todoist) is not built yet.
