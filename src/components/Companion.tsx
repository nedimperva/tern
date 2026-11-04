// The companion (docs/design/ui.md §4.2b, `Ctrl+.`, `i`): one column beside the open conversation. The person at the
// top with ways to write to them and to choose their split, then what the newest message holds (Details), what is
// owed each way, the files and recent conversations with them (each opens),
// all from this computer; Ask sits at the foot and talks about the conversation with AI, on request and behind the
// AI switch.

import { batch, createEffect, createMemo, createSignal, For, type JSX, on, onCleanup, Show } from "solid-js";
import {
  api,
  type AiAnswer,
  type ContactCard,
  type PersonFacts,
  type PersonFile,
  type Sender,
  type SenderState,
  type ThreadMessage,
  type TodoistProject,
} from "../api";
import { filesOf } from "../files";
import { promisesIn } from "../promises";
import { blockSender, splitSenders, unsubscribe } from "../app/actions";
import { go, move } from "../app/list";
import { newPeople, role, setDetailsSlot, setViewing } from "../app/state";
import { addTask, loadTasks, setTaskBox, startTask, suggestTask, taskBox, taskRows, todoistOn, type TaskDraft } from "../app/tasks";
import { showToast } from "../app/toast";
import { aiOn, setSetting, settings } from "../settings";
import { when } from "./ConversationRow";
import { Avatar } from "./ConversationView";
import { Icon } from "./Icon";
import type { PersonActions } from "./PersonCard";

type Turn = { question: string; answer: string; done: AiAnswer | null; error: string };
// Chats live as long as Tern runs, a list per conversation: the person can come back to one in the same session.
const chats = new Map<string, Turn[]>();

const PROVIDERS: Record<string, string> = { anthropic: "Claude", openai: "OpenAI", gemini: "Gemini" };

export function Companion(props: {
  messages: ThreadMessage[];
  mine: (addr: string) => boolean;
  /** Show this message in the conversation (opened, scrolled to). */
  onJump: (id: number) => void;
  onClose: () => void;
  onOpenAi: () => void;
  /** Write to the person, find their mail, open one of your conversations with them. */
  person: PersonActions;
}) {
  const first = () => props.messages[0];
  const key = () => (first() ? `${first().accountId}:${first().threadId}` : "");
  const newest = () => props.messages[props.messages.length - 1];
  const sender = (m: ThreadMessage) => (props.mine(m.fromAddr) ? "You" : (m.fromName || m.fromAddr).split(/[\s@]/)[0]);
  /** The person the conversation is with: the newest message's sender who isn't you. */
  const who = createMemo(() => [...props.messages].reverse().find((m) => !props.mine(m.fromAddr)));
  // A signal, not a resource: a resource read inside the column's Suspense blanked the whole column until it came.
  const [card, setCard] = createSignal<ContactCard | null>(null);
  createEffect(
    on(
      () => who()?.fromAddr,
      (email) => {
        setCard(null);
        if (email) void api.contactCard(email).then((c) => who()?.fromAddr === email && setCard(c), () => {});
      },
    ),
  );

  // Where their mail goes: read when the person changes, and again after a choice made here.
  const [theirs, setTheirs] = createSignal<Sender | null>(null);
  const readSender = (id: number | undefined) => {
    if (id) void api.senderOf(id).then((s) => who()?.id === id && setTheirs(s), () => {});
  };
  createEffect(on(() => who()?.id, (id) => (setTheirs(null), readSender(id))));
  const choose = async (to: SenderState) => {
    const m = who();
    const was = theirs();
    // While they wait, "Important" is a choice too: their state only says where they'd go.
    if (!m || !was || (to === was.state && !was.waiting)) return;
    setTheirs({ ...was, state: to, waiting: false });
    // Blocking also takes this conversation to Done; Important and Other are a choice for the address, which wins
    // over a block of the whole domain.
    if (to === "blocked") await blockSender(false, m);
    else await splitSenders([m.id], [m.fromName || m.fromAddr], to === "other", () => readSender(m.id));
    readSender(m.id);
  };
  const firstName = () => (who() ? sender(who()!) : "");
  /** Other conversations with them, newest first: the open one is already on screen. */
  const recent = () => (card()?.recent ?? []).filter((r) => !(r.accountId === first()?.accountId && r.threadId === first()?.threadId)).slice(0, 4);
  // How much they write, who you know at their domain, your note: read when the person changes.
  const [facts, setFacts] = createSignal<PersonFacts | null>(null);
  createEffect(
    on(
      () => who() && `${who()!.accountId}:${who()!.fromAddr}`,
      () => {
        const m = who();
        setFacts(null);
        if (m) void api.person(m.accountId, m.fromAddr).then((f) => who()?.fromAddr === m.fromAddr && setFacts(f), () => {});
      },
    ),
  );
  /** A list writes to many: its card is about the list, not a person, and it takes no note. */
  const isList = () => facts()?.list ?? false;

  const ask = askAbout(() => props.messages, key);
  let body!: HTMLDivElement;
  // A new question goes to the foot of the column, where its answer streams in.
  createEffect(on(() => ask.turns().length, (n, was) => n > (was ?? n) && requestAnimationFrame(() => body.scrollTo({ top: body.scrollHeight, behavior: "smooth" }))));

  const close = (
    <button type="button" class="icon-button" onClick={props.onClose} title="Close the companion (Ctrl+.)" aria-label="Close the companion">
      <Icon name="x" size={15} />
    </button>
  );

  return (
    <aside class="companion" aria-label="Companion">
      <div class="companion-body" ref={body}>
        <Show
          when={who()}
          fallback={
            <header class="nobody">
              <strong>Only you wrote here</strong>
              {close}
            </header>
          }
        >
          {(m) => (
            <PersonCard
              m={m()}
              first={firstName()}
              card={card()}
              facts={facts()}
              sender={theirs()}
              answer={answerTime(props.messages, props.mine)}
              close={close}
              onChoose={(s) => void choose(s)}
              onWrite={() => props.person.write(m().fromAddr)}
            />
          )}
        </Show>
        <Show when={who() && facts() && !isList() ? who() : null}>
          {(m) => <Note email={m().fromAddr} first={firstName()} note={facts()!.note} />}
        </Show>
        <Show when={isList() && facts() && (facts()!.unopened.length > 1 || props.messages.some((m) => m.listUnsubscribe)) ? facts() : null}>
          {(f) => <Tidy facts={f()} leave={props.messages.some((m) => m.listUnsubscribe)} />}
        </Show>
        <Promises messages={props.messages} mine={props.mine} onJump={props.onJump} />
        <DetailsSlot />
        <Show when={todoistOn() && newest()}>{(m) => <Tasks message={m()} messages={props.messages} mine={props.mine} />}</Show>
        <Files messages={props.messages} sender={sender} email={who() && !isList() ? who()!.fromAddr : null} first={firstName()} />
        <Show when={card() && who() && (recent().length || card()!.received > 0) ? card() : null}>
          {(c) => (
            <section>
              <h2>{isList() ? "Earlier issues" : `Recent with ${firstName()}`}</h2>
              <div class="rows">
                <For each={recent()}>
                  {(r) => (
                    <button type="button" class="recent" classList={{ unread: !r.seen }} onClick={() => props.person.open(r)} title="Open this conversation">
                      <span class="line">
                        <Show when={!r.seen}>
                          <span class="dot" aria-hidden="true" />
                          <span class="visually-hidden">Unread: </span>
                        </Show>
                        <span class="subject">{r.subject || "(no subject)"}</span>
                        <span class="quiet">{when(r.date)}</span>
                      </span>
                      <Show when={r.snippet}>
                        <span class="quiet snippet">{r.snippet}</span>
                      </Show>
                    </button>
                  )}
                </For>
                <button type="button" class="recent all" onClick={() => props.person.search(c().email)}>
                  All mail from {firstName()}
                  {c().received ? ` · ${c().received.toLocaleString()}` : ""} →
                </button>
              </div>
            </section>
          )}
        </Show>
        <p class="found-here">Found on this computer, from the words of the mail.</p>
        <Show when={ask.turns().length}>
          <Turns turns={ask.turns()} messages={props.messages} sender={sender} onJump={props.onJump} />
        </Show>
      </div>
      <AskDock ask={ask} on={aiOn("summaries", newest()?.accountId)} onOpenAi={props.onOpenAi} />
    </aside>
  );
}

/** How long you take to answer them in this conversation ("~3 h"), the middle of your gaps; null before you have. */
function answerTime(messages: ThreadMessage[], mine: (addr: string) => boolean): string | null {
  const gaps: number[] = [];
  for (let i = 1; i < messages.length; i++) {
    const a = messages[i - 1];
    const b = messages[i];
    if (!mine(a.fromAddr) && mine(b.fromAddr)) gaps.push(b.date - a.date);
  }
  if (!gaps.length) return null;
  const mid = gaps.sort((x, y) => x - y)[Math.floor(gaps.length / 2)];
  return `~${mid < 3600 ? `${Math.max(1, Math.round(mid / 60))} min` : mid < 86_400 ? `${Math.round(mid / 3600)} h` : `${Math.round(mid / 86_400)} d`}`;
}

const STATES: { state: SenderState; name: string }[] = [
  { state: "important", name: "Important" },
  { state: "other", name: "Other" },
  { state: "blocked", name: "Blocked" },
];
const monthYear = new Intl.DateTimeFormat(undefined, { month: "short", year: "numeric" });

/** The person on top (ui.md §4.2b): open, the counts, their months and where their mail goes; folded (`Shift+I`, kept
 * for every conversation), one row. Someone waiting in New people gets what helps decide instead, and a list a
 * card about the list. */
function PersonCard(props: {
  m: ThreadMessage;
  first: string;
  card: ContactCard | null;
  facts: PersonFacts | null;
  sender: Sender | null;
  answer: string | null;
  close: JSX.Element;
  onChoose: (s: SenderState) => void;
  onWrite: () => void;
}) {
  const [copied, setCopied] = createSignal(false);
  const copy = async () => {
    await navigator.clipboard.writeText(props.m.fromAddr).catch(() => {});
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  };
  const name = () => props.m.fromName || props.m.fromAddr;
  const waiting = () => props.sender?.waiting ?? false;
  const list = () => props.facts?.list ?? false;
  // Someone waiting is never folded: the card is where they are let in.
  const folded = () => settings.companionFolded && !waiting();
  const fold = () => setSetting("companionFolded", !settings.companionFolded);
  const foldButton = () => (
    <button
      type="button"
      class="icon-button"
      onClick={fold}
      title={folded() ? "Open the card (Shift+I)" : "Fold the card (Shift+I)"}
      aria-label={folded() ? "Open the card" : "Fold the card"}
      aria-expanded={!folded()}
    >
      <Icon name={folded() ? "chevron-down" : "chevron-up"} size={16} />
    </button>
  );
  const states = () => (
    <fieldset class="states" aria-label={`Where ${props.first}'s mail goes`}>
      <For each={STATES}>
        {(s) => (
          <button
            type="button"
            aria-pressed={!waiting() && props.sender?.state === s.state}
            onClick={() => props.onChoose(s.state)}
            title={s.state === "blocked" && props.sender?.domainChoice === "blocked" ? `Everyone at ${props.sender.domain} is blocked` : undefined}
          >
            {s.name}
          </button>
        )}
      </For>
    </fieldset>
  );
  return (
    <Show
      when={!folded()}
      fallback={
        <div class="person folded">
          <Avatar addr={props.m.fromAddr} name={props.m.fromName} />
          <div class="who">
            <strong title={props.m.fromAddr}>{name()}</strong>
            <span>
              <Show when={props.sender}>{(s) => <span class={`state ${s().state}`}>{STATES.find((x) => x.state === s().state)?.name}</span>}</Show>
              {props.card?.received ? ` · ${props.card.received.toLocaleString()} from ${list() ? "the list" : props.first}` : ""}
            </span>
          </div>
          <div class="person-icons">
            <button type="button" class="icon-button" onClick={props.onWrite} title={`Write to ${props.m.fromAddr}`} aria-label={`Write to ${props.first}`}>
              <Icon name="pen-line" size={15} />
            </button>
            {foldButton()}
            {props.close}
          </div>
        </div>
      }
    >
      <div class="person" classList={{ waiting: waiting() }}>
        <div class="person-top">
          <Avatar addr={props.m.fromAddr} name={props.m.fromName} />
          <div class="who">
            <strong title={props.m.fromAddr}>
              {name()}
              <Show when={waiting()}>
                <span class="tag new">New</span>
              </Show>
              <Show when={list() && !waiting()}>
                <span class="tag">List</span>
              </Show>
            </strong>
            <span>{props.m.fromAddr}</span>
          </div>
          <div class="person-icons">
            <Show when={!waiting()}>{foldButton()}</Show>
            {props.close}
          </div>
        </div>
        <Show when={waiting()} fallback={<Known {...props} list={list()} />}>
          <Waiting {...props} />
        </Show>
        <Show when={!waiting() && props.sender}>{states()}</Show>
        <Show when={!waiting() && !list()}>
          <div class="person-do">
            <button type="button" class="primary" onClick={props.onWrite} title={`Write to ${props.m.fromAddr}`}>
              Write to {props.first}
            </button>
            <button type="button" onClick={() => void copy()} title={props.m.fromAddr}>
              {copied() ? "Copied" : "Copy address"}
            </button>
          </div>
        </Show>
      </div>
    </Show>
  );
}

/** The open card's middle for someone known: the counts, then their mail by month; for a list, how much of it is
 * read. */
function Known(props: { first: string; card: ContactCard | null; facts: PersonFacts | null; answer: string | null; list: boolean }) {
  const months = () => props.facts?.months ?? [];
  const max = () => Math.max(1, ...months());
  const now = () => months()[11] ?? 0;
  return (
    <Show
      when={!props.list}
      fallback={
        <Show when={props.facts?.latest ? props.facts : null}>
          {(f) => (
            <div class="opened">
              <div>
                <span>You open</span>
                <strong>
                  {f().opened} of the last {f().latest}
                </strong>
              </div>
              <meter min={0} max={f().latest} value={f().opened} aria-label="Issues opened" />
            </div>
          )}
        </Show>
      }
    >
      <Show when={props.card}>
        {(c) => (
          <div class="tiles">
            <div>
              <strong>{c().received.toLocaleString()}</strong>
              <span>from {props.first}</span>
            </div>
            <div>
              <strong>{c().sent.toLocaleString()}</strong>
              <span>from you</span>
            </div>
            <Show
              when={props.answer}
              fallback={
                <Show when={props.facts?.since}>
                  {(s) => (
                    <div>
                      <strong>{monthYear.format(s() * 1000)}</strong>
                      <span>first mail</span>
                    </div>
                  )}
                </Show>
              }
            >
              <div>
                <strong>{props.answer}</strong>
                <span>you answer</span>
              </div>
            </Show>
          </div>
        )}
      </Show>
      <Show when={months().some((n) => n > 0)}>
        <div class="months">
          <div class="bars" aria-hidden="true">
            <For each={months()}>{(n, i) => <span classList={{ now: i() === 11 }} style={{ height: `${Math.max(8, (n / max()) * 100)}%` }} />}</For>
          </div>
          <div class="quiet">
            <span>The last 12 months</span>
            <span>{now() && now() === max() ? "Busiest this month" : `${now()} this month`}</span>
          </div>
          <span class="visually-hidden">
            {months().reduce((a, b) => a + b, 0)} messages from {props.first} in the last 12 months, {now()} this month.
          </span>
        </div>
      </Show>
    </Show>
  );
}

/** Someone waiting in New people: what Tern knows that helps decide, and the three ways to decide. Each applies to all
 * of their mail, like `y`, `Shift+O` and `Shift+X` in the list. */
function Waiting(props: { m: ThreadMessage; first: string; card: ContactCard | null; facts: PersonFacts | null; onChoose: (s: SenderState) => void }) {
  const since = () => (props.facts?.since ? new Date(props.facts.since * 1000).toLocaleDateString(undefined, { day: "numeric", month: "short" }) : "");
  const others = () => Math.max(0, newPeople() - 1);
  return (
    <>
      <Show when={props.facts}>
        {(f) => (
          <ul class="signs">
            <li class={props.card?.sent ? "good" : "warn"}>
              {f().conversations === 1 ? "1 conversation" : `${f().conversations} conversations`}
              {since() ? ` since ${since()}` : ""}
              {props.card?.sent ? `, ${props.card.sent} answered by you` : ", none answered"}
            </li>
            <Show when={f().knownAtDomain}>{(k) => <li class="good">Same domain as {k()}, who you write to</li>}</Show>
            <li class={f().list ? "warn" : "good"}>{f().list ? "Came through a mailing list" : "Sent to you, not through a list"}</li>
          </ul>
        )}
      </Show>
      <div class="decide">
        <button type="button" class="primary" onClick={() => props.onChoose("important")}>
          Let {props.first} in
        </button>
        <div>
          <button type="button" onClick={() => props.onChoose("other")}>
            To Other
          </button>
          <button type="button" class="danger" onClick={() => props.onChoose("blocked")}>
            Block
          </button>
        </div>
      </div>
      <Show when={others()}>
        <button type="button" class="more-waiting" onClick={() => (role() === "new_people" ? move(1) : go({ role: "new_people" }))}>
          <Icon name="user-plus" size={14} />
          <span>{others() === 1 ? "1 more person waiting" : `${others()} more people waiting`}</span>
          <span class="go">{role() === "new_people" ? "Next" : "Screen them"}</span>
        </button>
      </Show>
    </>
  );
}

/** Your note on someone, kept only on this computer and shown on every conversation with them. Saved as it is typed. */
function Note(props: { email: string; first: string; note: string }) {
  const [text, setText] = createSignal(props.note);
  const [editing, setEditing] = createSignal(false);
  createEffect(on(() => [props.email, props.note], () => (setText(props.note), setEditing(false)), { defer: true }));
  let timer: number | undefined;
  const save = (value: string) => {
    const email = props.email;
    window.clearTimeout(timer);
    timer = window.setTimeout(() => void api.setPersonNote(email, value), 400);
  };
  let field: HTMLTextAreaElement | undefined;
  return (
    <Show
      when={text() || editing()}
      fallback={
        <button type="button" class="note-add" onClick={() => (setEditing(true), requestAnimationFrame(() => field?.focus()))}>
          <Icon name="plus" size={14} />
          Add a note on {props.first}
        </button>
      }
    >
      <section class="note">
        <label for="person-note">
          <Icon name="file-text" size={13} />
          <span>Your note</span>
          <span class="quiet">only on this computer</span>
        </label>
        <textarea
          id="person-note"
          ref={field}
          rows="3"
          value={text()}
          placeholder={`What to remember about ${props.first}`}
          onFocus={() => setEditing(true)}
          onBlur={() => setEditing(false)}
          onInput={(e) => (setText(e.currentTarget.value), save(e.currentTarget.value))}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Escape") e.currentTarget.blur();
          }}
        />
      </section>
    </Show>
  );
}

/** Tasks (ui.md §4.2b), once Todoist is connected: what this conversation already put in Todoist, then the row that
 * adds one (`t`), which becomes the task box. */
function Tasks(props: { message: ThreadMessage; messages: ThreadMessage[]; mine: (addr: string) => boolean }) {
  createEffect(
    on(
      () => props.messages.map((m) => m.id).join(","),
      () => {
        loadTasks(props.message.id);
        // The box belongs to the conversation it was opened in.
        const d = taskBox();
        if (d && !props.messages.some((m) => m.id === d.message)) setTaskBox(null);
      },
    ),
  );
  const start = () => {
    const s = suggestTask(props.messages, props.mine);
    startTask(props.message.id, s.title, s.due);
  };
  return (
    <section class="tasks">
      <div class="files-head">
        <h2>Tasks</h2>
        <span class="count">Todoist</span>
      </div>
      <div class="rows">
        <For each={taskRows()}>
          {(t) => (
            <div class="task">
              <span class="ring" aria-hidden="true" />
              <span class="what">
                <span class="name">{t.title}</span>
                <span class="quiet">
                  {t.due ? `${t.due} · ` : ""}
                  {t.url ? "in Todoist" : "going to Todoist…"}
                </span>
              </span>
              <Show when={t.url}>
                {(url) => (
                  <button type="button" class="link" onClick={() => api.openUrl(url())}>
                    Open
                  </button>
                )}
              </Show>
            </div>
          )}
        </For>
        <Show
          when={taskBox()}
          fallback={
            <button type="button" class="task-add" onClick={start}>
              <Icon name="plus" size={14} />
              <span>Add a task from this mail</span>
              <kbd>T</kbd>
            </button>
          }
        >
          {(d) => <TaskBox draft={d()} accountId={props.message.accountId} />}
        </Show>
      </div>
    </section>
  );
}

// The project's name, read once a session for the box's "To Work" line (the choice itself is in Settings).
let projectNames: Promise<TodoistProject[]> | null = null;

/** The task box: the title, the day as Todoist reads it ("fri", "tomorrow 9am") and a note, going to the project
 * chosen in Settings → Todoist. With AI on, Fill with AI proposes all three from the conversation. Enter adds, Esc
 * drops it. Under it, exactly what goes to Todoist. */
function TaskBox(props: { draft: TaskDraft; accountId: number }) {
  const [title, setTitle] = createSignal(props.draft.title);
  const [due, setDue] = createSignal(props.draft.due);
  const [note, setNote] = createSignal("");
  const [project, setProject] = createSignal("");
  const [problem, setProblem] = createSignal("");
  const [filling, setFilling] = createSignal(false);
  const [filled, setFilled] = createSignal("");
  const chosen = settings.todoist.project;
  if (chosen) {
    projectNames ??= api.todoistProjects();
    void projectNames.then((all) => setProject(all.find((p) => p.id === chosen)?.name ?? ""), () => (projectNames = null));
  }
  let field: HTMLInputElement | undefined;
  requestAnimationFrame(() => field?.select());
  const keys = (e: KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === "Escape") setTaskBox(null);
  };
  const fill = async () => {
    setFilling(true);
    setProblem("");
    try {
      const s = await api.aiTask(props.draft.message);
      setTitle(s.title);
      setDue(s.due);
      setNote(s.note);
      setFilled(`Filled in by ${PROVIDERS[s.route.provider] ?? s.route.provider} from this conversation (${s.sentChars.toLocaleString()} characters sent). Check it before adding.`);
    } catch (e) {
      setProblem(String(e));
    } finally {
      setFilling(false);
    }
  };
  const label = () => settings.todoist.label.trim().replace(/^@/, "");
  return (
    <form
      class="task-box"
      onSubmit={(e) => {
        e.preventDefault();
        if (title().trim()) void addTask(props.draft, title().trim(), due().trim(), note().trim());
      }}
    >
      <div class="task-top">
        <label class="visually-hidden" for="task-title">
          Task
        </label>
        <input id="task-title" ref={field} value={title()} onInput={(e) => setTitle(e.currentTarget.value)} onKeyDown={keys} placeholder="What to do" />
        <Show when={aiOn("summaries", props.accountId)}>
          <button type="button" class="ai-fill" onClick={() => void fill()} disabled={filling()} title="Propose the title, the day and a note from this conversation. Sends it to your AI provider.">
            <kbd class="ai-mark">AI</kbd>
            {filling() ? "Filling…" : "Fill"}
          </button>
        </Show>
      </div>
      <div class="task-fields">
        <label class="visually-hidden" for="task-due">
          When
        </label>
        <input id="task-due" value={due()} onInput={(e) => setDue(e.currentTarget.value)} onKeyDown={keys} placeholder="Day: fri, tomorrow 9am" />
        <span class="task-project" title="Change it in Settings → Todoist">
          To {project() || "Inbox"}
        </span>
      </div>
      <label class="visually-hidden" for="task-note">
        Note
      </label>
      <textarea id="task-note" rows="1" value={note()} onInput={(e) => setNote(e.currentTarget.value)} onKeyDown={keys} placeholder="Note (optional)" />
      <Show when={problem()}>
        <p class="quiet error">{problem()}</p>
      </Show>
      <Show when={filled()}>
        <p class="quiet">{filled()}</p>
      </Show>
      <p class="quiet">
        To Todoist: the title, the day{note().trim() ? ", the note" : ""}{label() ? `, @${label()}` : ""} and who sent the mail
        with its subject. No other mail text.
      </p>
      <div class="task-do">
        <button type="button" onClick={() => setTaskBox(null)}>
          Cancel <kbd>Esc</kbd>
        </button>
        <button type="submit" class="primary" disabled={!title().trim()}>
          Add task <kbd>Enter</kbd>
        </button>
      </div>
    </form>
  );
}

/** A list's own section: archive the issues never opened, or leave the list. */
function Tidy(props: { facts: PersonFacts; leave: boolean }) {
  const [gone, setGone] = createSignal(false);
  const archive = async () => {
    const ids = props.facts.unopened;
    setGone(true);
    try {
      const applied = await api.applyConversations(ids, "archive", { role: "inbox" });
      showToast(ids.length === 1 ? "Archived 1 unopened issue" : `Archived ${ids.length} unopened issues`, applied.token, () => setGone(false));
    } catch (e) {
      setGone(false);
      showToast(String(e), []);
    }
  };
  return (
    <section>
      <h2>Tidy it</h2>
      <div class="rows">
        <Show when={props.facts.unopened.length > 1 && !gone()}>
          <button type="button" class="tidy" onClick={() => void archive()}>
            <span class="name">Archive the {props.facts.unopened.length} unopened</span>
            <span class="quiet">Out of the inbox; Z undoes it</span>
          </button>
        </Show>
        <Show when={props.leave}>
          <button type="button" class="tidy danger" onClick={() => void unsubscribe()}>
            <span class="name">Unsubscribe</span>
            <span class="quiet">Through the list's own link (Ctrl+U)</span>
          </button>
        </Show>
      </div>
    </section>
  );
}

/** The open conversation draws Details here (`Details.tsx`, portalled from ConversationView). */
function DetailsSlot() {
  onCleanup(() => setDetailsSlot(null));
  return <div ref={setDetailsSlot} />;
}

type Ask = ReturnType<typeof askAbout>;

/** The chat about one conversation: its turns are drawn in the column, the box at its foot. */
function askAbout(messages: () => ThreadMessage[], chatKey: () => string) {
  const [turns, setTurns] = createSignal<Turn[]>(chats.get(chatKey()) ?? []);
  createEffect(on(chatKey, (k) => setTurns(chats.get(k) ?? []), { defer: true }));
  const [busy, setBusy] = createSignal(false);
  const keep = (next: Turn[]) => {
    setTurns(next);
    chats.set(chatKey(), next);
  };
  const send = async (q: string) => {
    const newest = messages()[messages().length - 1];
    if (!q || busy() || !newest) return;
    setBusy(true);
    const earlier = turns()
      .filter((t) => t.done)
      .map((t) => [t.question, t.answer] as [string, string]);
    const at = turns().length;
    keep([...turns(), { question: q, answer: "", done: null, error: "" }]);
    const update = (patch: Partial<Turn>) => keep(turns().map((t, i) => (i === at ? { ...t, ...patch } : t)));
    try {
      let streamed = "";
      const done = await api.aiAsk(newest.id, q, earlier, (w) => update({ answer: (streamed += w) }));
      update({ answer: done.text, done });
    } catch (e) {
      update({ error: String(e) });
    }
    setBusy(false);
  };
  return { turns, busy, send };
}

function Turns(props: { turns: Turn[]; messages: ThreadMessage[]; sender: (m: ThreadMessage) => string; onJump: (id: number) => void }) {
  /** The answer with each [n] as a chip naming the message, which shows it in the conversation. */
  const cited = (t: Turn) => {
    const ids = t.done?.messages ?? [];
    return t.answer.split(/(\[\d+\])/).map((part) => {
      const n = /^\[(\d+)\]$/.exec(part)?.[1];
      const id = n ? ids[Number(n) - 1] : undefined;
      const m = id ? props.messages.find((x) => x.id === id) : undefined;
      if (!m) return part;
      return (
        <button type="button" class="cite" onClick={() => props.onJump(m.id)} title="Show this message">
          {props.sender(m)} · {when(m.date)}
        </button>
      );
    });
  };
  return (
    <section class="turns" aria-live="polite">
      <h2>Asked · this conversation, {props.messages.length}</h2>
      <For each={props.turns}>
        {(t) => (
          <div class="turn">
            <div class="question">{t.question}</div>
            <Show when={!t.error} fallback={<div class="error">{t.error}</div>}>
              <div class="answer">{t.answer ? cited(t) : "…"}</div>
              <Show when={t.done}>
                {(d) => (
                  <div class="receipt">
                    {PROVIDERS[d().route.provider] ?? d().route.provider} · sent {d().messages.length}{" "}
                    {d().messages.length === 1 ? "message" : "messages"}, {d().sentChars.toLocaleString()} characters · nothing kept
                  </div>
                )}
              </Show>
            </Show>
          </div>
        )}
      </For>
    </section>
  );
}

// Questions worth asking, shown one at a time in the empty box; Tab takes the one on show.
const HINTS = [
  "What was decided?",
  "What do they need from me?",
  "Is there a deadline?",
  "What's still open?",
  "Summarize this in two lines",
  "Who's waiting on whom?",
  "What did I promise?",
  "What changed since the last message?",
  "Which dates or times came up?",
  "What should my reply cover?",
  "Is anyone unhappy here?",
  "What are the next steps?",
  "Who else should know about this?",
  "What numbers were mentioned?",
  "Did they answer my question?",
  "What's the short version?",
];
const HINT_MS = 4000;

function AskDock(props: { ask: Ask; on: boolean; onOpenAi: () => void }) {
  const [question, setQuestion] = createSignal("");
  // A different question each time the column opens, then the next every few seconds while the box is empty.
  const [hint, setHint] = createSignal(Math.floor(Math.random() * HINTS.length));
  createEffect(() => {
    if (question() || !props.on) return;
    const timer = window.setInterval(() => setHint((h) => (h + 1) % HINTS.length), HINT_MS);
    onCleanup(() => window.clearInterval(timer));
  });
  const send = (text = question()) => {
    const q = text.trim();
    if (!q || props.ask.busy()) return;
    setQuestion("");
    void props.ask.send(q);
  };
  return (
    <Show
      when={props.on}
      fallback={
        <div class="ask-dock off">
          <span>
            Asking about this conversation needs AI, off for this account.{" "}
            <button type="button" class="link" onClick={props.onOpenAi}>
              Settings → AI
            </button>
          </span>
        </div>
      }
    >
      <form
        class="ask-dock"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <div class="ask-box">
          <Icon name="message" size={15} />
          <label for="companion-ask" class="visually-hidden">
            Ask about this conversation
          </label>
          <textarea
            id="companion-ask"
            rows="1"
            placeholder={HINTS[hint()]}
            title="Ask about this conversation. Tab takes the suggested question."
            value={question()}
            onInput={(e) => setQuestion(e.currentTarget.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Tab" && !e.shiftKey && !question()) {
                e.preventDefault();
                setQuestion(HINTS[hint()]);
              } else if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
          />
          <button type="submit" class="send" disabled={props.ask.busy() || !question().trim()} aria-label="Ask">
            <Icon name="send" size={14} />
          </button>
        </div>
      </form>
    </Show>
  );
}

function Promises(props: { messages: ThreadMessage[]; mine: (addr: string) => boolean; onJump: (id: number) => void }) {
  const all = createMemo(() => promisesIn(props.messages, props.mine));
  const done = (key: string) => settings.promisesDone.includes(key);
  const tick = (key: string) => {
    const list = done(key) ? settings.promisesDone.filter((k) => k !== key) : [...settings.promisesDone, key];
    // The newest 500 are plenty: old conversations' ticks can go.
    setSetting("promisesDone", list.slice(-500));
  };
  const said = (p: ReturnType<typeof all>[number]) =>
    p.who === "You" ? (p.yours ? "You said you would" : "You asked") : p.yours ? `${p.who} asked` : `${p.who} said they would`;
  const dueDay = (due: number) => new Date(due * 1000).toLocaleDateString(undefined, { weekday: "short" });
  const dueFull = (due: number) => new Date(due * 1000).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
  // Only what there is: an empty "Owed to you" says nothing worth the room.
  const group = (yours: boolean, title: string) => (
    <Show when={all().some((p) => p.yours === yours)}>
      <section>
        <h2>{title}</h2>
        <div class="rows">
          <For each={all().filter((p) => p.yours === yours)}>
            {(p) => (
              <div class="pledge" classList={{ done: done(p.key) }}>
                <input type="checkbox" checked={done(p.key)} onChange={() => tick(p.key)} aria-label={`Done: ${p.text}`} />
                <div>
                  <button type="button" class="text" onClick={() => props.onJump(p.message)} title="Show it in the conversation">
                    {p.text}
                  </button>
                  <span class="quiet">{said(p)}</span>
                </div>
                <Show when={p.due}>
                  {(d) => (
                    <span class="due" title={`By ${dueFull(d())}`}>
                      {dueDay(d())}
                    </span>
                  )}
                </Show>
              </div>
            )}
          </For>
        </div>
      </section>
    </Show>
  );
  return (
    <>
      {group(true, "You owe")}
      {group(false, "Owed to you")}
    </>
  );
}

/** A file's kind as a short tag and a tint, so a list of them reads at a glance. */
function kindOf(name: string, mime: string): [string, string] {
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  if (ext === "pdf") return ["PDF", "pdf"];
  if (["xls", "xlsx", "csv", "ods", "numbers"].includes(ext)) return [ext === "csv" ? "CSV" : "XLS", "sheet"];
  if (["doc", "docx", "odt", "rtf", "pages"].includes(ext)) return ["DOC", "doc"];
  if (mime.startsWith("image/")) return [(ext || "img").slice(0, 4).toUpperCase(), "image"];
  return [(ext || "file").slice(0, 4).toUpperCase(), "other"];
}

const KINDS: Record<string, string> = { pdf: "PDF", sheet: "Sheets", doc: "Docs", image: "Pictures", other: "Other" };
const kb = (n: number) => (n > 1_000_000 ? `${(n / 1_000_000).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1000))} kB`);
const monthOf = (seconds: number) => {
  const d = new Date(seconds * 1000);
  return d.toLocaleDateString(undefined, d.getFullYear() === new Date().getFullYear() ? { month: "long" } : { month: "long", year: "numeric" });
};
// The person's files from every conversation: the first few, then all on request.
const FIRST_FILES = 8;

/** The files in this conversation, or every file exchanged with the person (by kind, under month headings). Either
 * opens in Tern's viewer; one from another conversation reads that message first. */
function Files(props: { messages: ThreadMessage[]; sender: (m: ThreadMessage) => string; email: string | null; first: string }) {
  const here = createMemo(() => props.messages.flatMap((m) => filesOf(m).map(({ file: a, index }) => ({ m, a, index }))).reverse());
  const [theirs, setTheirs] = createSignal<PersonFile[]>([]);
  // null: the default, this conversation's files when it has any.
  const [wide, setWide] = createSignal<boolean | null>(null);
  const [kind, setKind] = createSignal("all");
  const [more, setMore] = createSignal(false);
  createEffect(
    on(
      () => props.email,
      (email) => {
        batch(() => (setTheirs([]), setWide(null), setKind("all"), setMore(false)));
        if (email) void api.personFiles(email).then((f) => props.email === email && setTheirs(f), () => {});
      },
    ),
  );
  const all = () => wide() ?? !here().length;
  const kinds = createMemo(() => {
    const n = new Map<string, number>();
    for (const f of theirs()) n.set(kindOf(f.name, f.mime)[1], (n.get(kindOf(f.name, f.mime)[1]) ?? 0) + 1);
    return [...n].sort((a, b) => b[1] - a[1]);
  });
  const picked = createMemo(() => theirs().filter((f) => kind() === "all" || kindOf(f.name, f.mime)[1] === kind()));
  const shown = () => (more() ? picked() : picked().slice(0, FIRST_FILES));
  /** The shown files by month, newest first. */
  const months = createMemo(() => {
    const out: { month: string; files: PersonFile[] }[] = [];
    for (const f of shown()) {
      const month = monthOf(f.date);
      if (out.at(-1)?.month === month) out.at(-1)!.files.push(f);
      else out.push({ month, files: [f] });
    }
    return out;
  });
  const show = async (f: PersonFile) => {
    const m = props.messages.find((x) => x.id === f.messageId) ?? (await api.thread(f.messageId)).find((x) => x.id === f.messageId);
    if (m) setViewing({ message: m, index: f.index });
  };
  const row = (tagged: [string, string], name: string, quiet: string, open: () => void) => (
    // The same viewer as a file in the conversation; it has Open with the system for what it can't show.
    <button type="button" class="file" onClick={open} title="Show it">
      <span class={`tile ${tagged[1]}`}>{tagged[0]}</span>
      <span class="what">
        <span class="name">{name}</span>
        <span class="quiet">{quiet}</span>
      </span>
    </button>
  );
  return (
    <Show when={here().length || theirs().length}>
      <section>
        <div class="files-head">
          <h2>Files</h2>
          <Show when={theirs().length > here().length} fallback={<span class="count">{here().length}</span>}>
            <fieldset class="which" aria-label="Which files">
              <button type="button" aria-pressed={!all()} disabled={!here().length} onClick={() => setWide(false)}>
                Here · {here().length}
              </button>
              <button type="button" aria-pressed={all()} onClick={() => setWide(true)}>
                With {props.first} · {theirs().length}
              </button>
            </fieldset>
          </Show>
        </div>
        <Show
          when={all() && theirs().length > here().length}
          fallback={
            <div class="rows">
              <For each={here()}>
                {(f) => row(kindOf(f.a.name, f.a.mime), f.a.name, `${props.sender(f.m)} · ${when(f.m.date)} · ${kb(f.a.size)}`, () => setViewing({ message: f.m, index: f.index }))}
              </For>
            </div>
          }
        >
          <Show when={kinds().length > 1}>
            <fieldset class="kinds" aria-label="Kind of file">
              <button type="button" aria-pressed={kind() === "all"} onClick={() => setKind("all")}>
                All
              </button>
              <For each={kinds()}>
                {([k, n]) => (
                  <button type="button" aria-pressed={kind() === k} onClick={() => setKind(k)}>
                    {KINDS[k]} {n}
                  </button>
                )}
              </For>
            </fieldset>
          </Show>
          <For each={months()}>
            {(g) => (
              <>
                <h3 class="month">{g.month}</h3>
                <div class="rows">
                  <For each={g.files}>
                    {(f) => row(kindOf(f.name, f.mime), f.name, `${f.mine ? "You" : props.first} · ${f.subject || "(no subject)"} · ${when(f.date)}`, () => void show(f))}
                  </For>
                </div>
              </>
            )}
          </For>
          <Show when={!more() && picked().length > FIRST_FILES}>
            <button type="button" class="link more-files" onClick={() => setMore(true)}>
              Show all {picked().length}
            </button>
          </Show>
        </Show>
      </section>
    </Show>
  );
}
