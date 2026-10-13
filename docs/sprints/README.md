# How to work a sprint

Read this before touching a work-package file. Existing sprint filenames are stable IDs, not sequential
weeks. The milestone order and release scope live in `docs/PLAN.md`. Select a small task slice and its
acceptance checks before implementation; record required versus deferred tasks in the package log.
A milestone may finish while a package still contains explicitly future work. Only mark a whole package
complete when all its tasks have been completed or explicitly dispositioned. It applies to agents and humans alike.

## Roles

- **Owner** (Nedim): decides at gates, tests against real accounts, reviews and merges PRs.
- **Agent**: implements, tests what can be tested without real accounts, keeps the sprint file current,
  writes the PR with a "How to test" section.

## Starting a sprint

1. Read `docs/PLAN.md`, then the sprint file, then `docs/design/ui.md` if the sprint touches the UI, and
   `docs/research/data-model.md` if it touches the schema.
2. Check the active milestone's prerequisites and explicitly carried-over safety work. Numeric package order does not determine priority.
3. Create a small slice branch from `main`, such as `sprint/01-reconnect-tests`. One package may use several PRs.
4. Set the status line at the top of the sprint file to `**Status:** in progress · started YYYY-MM-DD`
   and commit it as the first commit of the branch.
5. Do not start work whose prerequisite evidence or owner gate is missing. Independent slices may proceed; keep reviews small.

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
- Deferred features do not automatically become next-milestone requirements. Reliability/security blockers cannot be deferred just to meet a date.
- Scope only grows through the backlog. New ideas go into `sprint-15-plus-backlog.md`, not into the current sprint.

## Checkbox conventions

| Mark | Meaning |
|---|---|
| `- [ ]` | not done |
| `- [x]` | done by the definition above |
| `- [x] (owner YYYY-MM-DD)` | acceptance check verified by the owner against a real account |
| `- [-] ~~text~~ — reason` | cut this sprint, with the reason; record an owner-approved destination milestone or backlog entry |

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
3. Assign deferred tasks an explicit future milestone or backlog destination. Do not automatically carry them into the next numeric package or release milestone.
4. Update the package status and evidence for the active milestone in `docs/PLAN.md`; only mark the milestone done when all required slices and owner acceptance pass.
5. Update `CLAUDE.md` → "Where things stand" with two or three sentences on the new state and any gotchas.
6. Add a section to `CHANGELOG.md` once beta distribution begins; before that the package log records changes.
7. Open the PR to `main`:
   - title `Sprint NN: <theme>`;
   - body: what changed in five lines, **How to test** (numbered steps per acceptance check, with expected results),
     **Decisions needed** (if any), **Carried over** (list);
   - link the sprint file.
8. Set the status line to `**Status:** review · PR #N`. After merge the owner (or the agent on request) sets it to
   `**Status:** done · merged YYYY-MM-DD` and ticks the acceptance checks they verified.

A sprint is **complete** when its PR is merged *and* the owner has ticked the acceptance checks. If an acceptance
check fails after merge, reopen the affected release gate and prioritize the fix. Never count an unsafe
or unreliable release as complete because its PR merged.

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
