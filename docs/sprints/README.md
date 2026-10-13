# How to work a sprint

Read this before touching a sprint file. It applies to agents and humans alike.

## Roles

- **Owner** (Nedim): decides at gates, tests against real accounts, reviews and merges PRs.
- **Agent**: implements, tests what can be tested without real accounts, keeps the sprint file current,
  writes the PR with a "How to test" section.

## Starting a sprint

1. Read `docs/PLAN.md`, then the sprint file, then `docs/design/ui.md` if the sprint touches the UI, and
   `docs/research/data-model.md` if it touches the schema.
2. Check the previous sprint file's **Carried over** section. Those tasks come first.
3. Create the branch from `main`: `git checkout -b sprint/NN-short-name` (for example `sprint/01-sync-engine`).
4. Set the status line at the top of the sprint file to `**Status:** in progress · started YYYY-MM-DD`
   and commit it as the first commit of the branch.
5. Do not start a sprint while the previous sprint's PR is open, unless the owner says so.

## While working

- Work through tasks roughly in file order; each task is one or a few commits with an imperative message
  and a body that says why. Reference the task in the body (`Sprint 1: headers-first fetch, phase A`).
- Tick a task **only when it is done by the definition below**. Edit the sprint file in the same commit as
  the code that finishes the task, so the checkbox and the code land together.
- **Definition of done** for a task:
  - compiles (`cargo build --workspace`, `npm run build`) and `cargo test --workspace` passes;
  - engine changes have a test; UI changes were tried in `npm run tauri dev` or, when that is impossible in
    the agent's environment, in `npm run dev` against the fake mailbox, and the sprint file says which;
  - nothing in the speed table regressed (`cargo run --release -p tern-core --example store_bench`);
  - `CLAUDE.md`, `docs/research/*` or `docs/design/ui.md` updated if a decision or a token changed.
- Keep a short **Log** at the bottom of the sprint file: one dated line per working session, what moved,
  what blocked. This is what the next session reads first.
- When something cannot be done as written, do not silently change it. Add a line under **Decisions** in the
  sprint file: what was planned, what you found, what you propose. The owner answers in the PR or in chat;
  record the answer there.
- Scope only grows through the backlog. New ideas go into `sprint-15-plus-backlog.md`, not into the current sprint.

## Checkbox conventions

| Mark | Meaning |
|---|---|
| `- [ ]` | not done |
| `- [x]` | done by the definition above |
| `- [x] (owner YYYY-MM-DD)` | acceptance check verified by the owner against a real account |
| `- [-] ~~text~~ — reason` | cut this sprint, with the reason; copy it to the next sprint's **Carried over** or to the backlog |

Acceptance checks are ticked by the **owner**, never by the agent, because they need real servers, a real
window on Hyprland, or a real inbox. The agent prepares them: exact steps, what to look for, where the log is.

## Decision gates

A gate is a task marked **Decision gate** in the sprint file. The agent:
1. does the time-boxed work (probe, measurement, spike);
2. writes the evidence and a recommendation under **Decisions** in the sprint file;
3. stops on that path and asks the owner (chat or PR comment), continuing with unrelated tasks meanwhile.
The owner's answer is recorded in the sprint file and, if it changes a standing decision, in `docs/research/stack.md`.

## Finishing a sprint

1. All tasks are `[x]` or `[-]` with a reason. Nothing is left `[ ]`.
2. Fill the **Results** block if the sprint has one (bench numbers, bundle size).
3. Move every `[-]` task that is not abandoned into the next sprint file under a `## Carried over from Sprint NN` heading at the top of its task list.
4. Update the **Status** column in the sprint map in `docs/PLAN.md` (`todo → in progress → review → done`).
5. Update `CLAUDE.md` → "Where things stand" with two or three sentences on the new state and any gotchas.
6. Add a section to `CHANGELOG.md` (from Sprint 14 on; before that the sprint file is the changelog).
7. Open the PR to `main`:
   - title `Sprint NN: <theme>`;
   - body: what changed in five lines, **How to test** (numbered steps per acceptance check, with expected results),
     **Decisions needed** (if any), **Carried over** (list);
   - link the sprint file.
8. Set the status line to `**Status:** review · PR #N`. After merge the owner (or the agent on request) sets it to
   `**Status:** done · merged YYYY-MM-DD` and ticks the acceptance checks they verified.

A sprint is **complete** when its PR is merged *and* the owner has ticked the acceptance checks. If an acceptance
check fails after merge, it becomes the first task of the next sprint, not a reopen of the old one.

## Session checklist for agents

```
[ ] read PLAN.md → current sprint file → Log → Carried over
[ ] on the right branch (sprint/NN-…), rebased on main
[ ] cargo test --workspace && npm run build pass before I start
[ ] work task by task; tick in the same commit
[ ] bench and bundle size still green
[ ] Log line written; Decisions written if I deviated
[ ] pushed; PR body updated if the PR exists
```
