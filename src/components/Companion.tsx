// The companion (docs/design/ui.md §4.2b, `Ctrl+.`, `i`): one column beside the open conversation. The person at the
// top with ways to write to them and to choose their split, then what the newest message holds (Details), what is
// owed each way, the files and recent conversations with them (each opens),
// all from this computer; Ask sits at the foot and talks about the conversation with AI, on request and behind the
// AI switch.

import { createEffect, createMemo, createSignal, For, on, onCleanup, Show } from "solid-js";
import { api, type AiAnswer, type ContactCard, type Sender, type SenderState, type ThreadMessage } from "../api";
import { filesOf } from "../files";
import { promisesIn } from "../promises";
import { blockSender, splitSenders } from "../app/actions";
import { setDetailsSlot } from "../app/state";
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
    if (!m || !was || to === was.state) return;
    setTheirs({ ...was, state: to });
    // Blocking also takes this conversation to Done; Important and Other are a choice for the address, which wins
    // over a block of the whole domain.
    if (to === "blocked") await blockSender(false, m);
    else await splitSenders([m.id], [m.fromName || m.fromAddr], to === "other", () => readSender(m.id));
    readSender(m.id);
  };
  const [copied, setCopied] = createSignal(false);
  const copy = async (email: string) => {
    await navigator.clipboard.writeText(email).catch(() => {});
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  };
  const firstName = () => (who() ? sender(who()!) : "");
  /** Other conversations with them, newest first: the open one is already on screen. */
  const recent = () => (card()?.recent ?? []).filter((r) => !(r.accountId === first()?.accountId && r.threadId === first()?.threadId)).slice(0, 4);

  const ask = askAbout(() => props.messages, key);
  let body!: HTMLDivElement;
  // A new question goes to the foot of the column, where its answer streams in.
  createEffect(on(() => ask.turns().length, (n, was) => n > (was ?? n) && requestAnimationFrame(() => body.scrollTo({ top: body.scrollHeight, behavior: "smooth" }))));

  return (
    <aside class="companion" aria-label="Companion">
      <header>
        <Show when={who()} fallback={<div class="who"><strong>Only you wrote here</strong></div>}>
          {(m) => (
            <>
              <Avatar addr={m().fromAddr} name={m().fromName} />
              <div class="who">
                <strong title={m().fromAddr}>{m().fromName || m().fromAddr}</strong>
                <span>{pace(card(), props.messages, props.mine)}</span>
              </div>
            </>
          )}
        </Show>
        <button type="button" class="icon-button" onClick={props.onClose} title="Close the companion (Ctrl+.)" aria-label="Close the companion">
          <Icon name="x" size={15} />
        </button>
        {/* Its own row under the name, the width of the column: beside the avatar the buttons wrapped word by word. */}
        <Show when={who()}>
          {(m) => (
            <div class="person-do">
              {/* "Write", not "Write to {name}": a long name pushed the split choice onto a line of its own. */}
              <button type="button" onClick={() => props.person.write(m().fromAddr)} title={`Write to ${m().fromAddr}`}>
                <Icon name="pen-line" size={13} />
                Write
              </button>
              <button type="button" onClick={() => void copy(m().fromAddr)} title={m().fromAddr}>
                {copied() ? "Copied" : "Copy address"}
              </button>
              <Show when={theirs()}>
                {(s) => (
                  <>
                    <label class="visually-hidden" for="companion-split">
                      Where {firstName()}'s mail goes
                    </label>
                    <select
                      id="companion-split"
                      value={s().state}
                      title={s().domainChoice === "blocked" && s().state === "blocked" ? `Everyone at ${s().domain} is blocked` : undefined}
                      onChange={(e) => void choose(e.currentTarget.value as SenderState)}
                    >
                      <option value="important">Important</option>
                      <option value="other">Other</option>
                      <option value="blocked">Blocked</option>
                    </select>
                  </>
                )}
              </Show>
            </div>
          )}
        </Show>
      </header>
      <div class="companion-body" ref={body}>
        <DetailsSlot />
        <Promises messages={props.messages} mine={props.mine} onJump={props.onJump} />
        <Files messages={props.messages} sender={sender} />
        <Show when={card() && who() && (recent().length || card()!.received > 0) ? card() : null}>
          {(c) => (
            <section>
              <h2>Recent with {firstName()}</h2>
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

/** "12 from them · 9 from you · you answer in ~3 h": the store's counts, and your pace in this conversation. */
function pace(card: ContactCard | null, messages: ThreadMessage[], mine: (addr: string) => boolean): string {
  const gaps: number[] = [];
  for (let i = 1; i < messages.length; i++) {
    const a = messages[i - 1];
    const b = messages[i];
    if (!mine(a.fromAddr) && mine(b.fromAddr)) gaps.push(b.date - a.date);
  }
  const parts = card ? [`${card.received} from them`, `${card.sent} from you`] : [];
  if (gaps.length) {
    const mid = gaps.sort((x, y) => x - y)[Math.floor(gaps.length / 2)];
    parts.push(`you answer in ~${mid < 3600 ? `${Math.max(1, Math.round(mid / 60))} min` : mid < 86_400 ? `${Math.round(mid / 3600)} h` : `${Math.round(mid / 86_400)} d`}`);
  }
  return parts.join(" · ");
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

function AskDock(props: { ask: Ask; on: boolean; onOpenAi: () => void }) {
  const [question, setQuestion] = createSignal("");
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
          <span>Ask about this conversation needs AI, which is off for this account. Nothing is sent until you ask.</span>
          <button type="button" class="link" onClick={props.onOpenAi}>
            Settings → AI
          </button>
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
        <Show when={!props.ask.turns().length}>
          <div class="suggest">
            <For each={["What was decided?", "What do they need from me?"]}>
              {(s) => (
                <button type="button" onClick={() => send(s)}>
                  {s}
                </button>
              )}
            </For>
          </div>
        </Show>
        <div class="ask-box">
          <Icon name="message" size={15} />
          <label for="companion-ask" class="visually-hidden">
            Ask about this conversation
          </label>
          <textarea
            id="companion-ask"
            rows="1"
            placeholder="Ask about this conversation"
            value={question()}
            onInput={(e) => setQuestion(e.currentTarget.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter" && !e.shiftKey) {
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

function Files(props: { messages: ThreadMessage[]; sender: (m: ThreadMessage) => string }) {
  const files = createMemo(() =>
    props.messages.flatMap((m) => filesOf(m).map(({ file: a, index }) => ({ m, a, index }))).reverse(),
  );
  const kb = (n: number) => (n > 1_000_000 ? `${(n / 1_000_000).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1000))} kB`);
  return (
    <Show when={files().length}>
      <section>
        <h2>
          Files <span class="count">{files().length}</span>
        </h2>
        <div class="rows">
          <For each={files()}>
            {(f) => {
              const [tag, tint] = kindOf(f.a.name, f.a.mime);
              return (
                <button type="button" class="file" onClick={() => void api.openAttachment(f.m.id, f.index)} title="Open it">
                  <span class={`tile ${tint}`}>{tag}</span>
                  <span class="what">
                    <span class="name">{f.a.name}</span>
                    <span class="quiet">
                      {props.sender(f.m)} · {when(f.m.date)} · {kb(f.a.size)}
                    </span>
                  </span>
                </button>
              );
            }}
          </For>
        </div>
      </section>
    </Show>
  );
}
