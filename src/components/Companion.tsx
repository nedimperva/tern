// The companion (docs/design/ui.md §4.2b, `Ctrl+.`): a column beside the open conversation. Ask talks about the
// conversation with AI, on request and behind the AI switch; Person, Promises and Files come from the store on this
// computer and need no AI.

import { createMemo, createResource, createSignal, For, Show } from "solid-js";
import { api, type AiAnswer, type ThreadMessage } from "../api";
import { filesOf } from "../files";
import { promisesIn } from "../promises";
import { aiOn, setSetting, settings } from "../settings";
import { when } from "./ConversationRow";
import { Icon } from "./Icon";

type Tab = "ask" | "person" | "promises" | "files";
const TABS: [Tab, string][] = [
  ["ask", "Ask"],
  ["person", "Person"],
  ["promises", "Promises"],
  ["files", "Files"],
];

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
}) {
  const [tab, setTab] = createSignal<Tab>("ask");
  const first = () => props.messages[0];
  const key = () => (first() ? `${first().accountId}:${first().threadId}` : "");
  const newest = () => props.messages[props.messages.length - 1];
  const sender = (m: ThreadMessage) => (props.mine(m.fromAddr) ? "You" : (m.fromName || m.fromAddr).split(/[\s@]/)[0]);

  return (
    <aside class="companion" aria-label="Companion">
      <header>
        <div class="companion-tabs" role="tablist" aria-label="Companion">
          <For each={TABS}>
            {([id, name]) => (
              <button type="button" role="tab" aria-selected={tab() === id} classList={{ on: tab() === id }} onClick={() => setTab(id)}>
                {name}
              </button>
            )}
          </For>
        </div>
        <span class="spacer" />
        <button type="button" class="icon-button" onClick={props.onClose} title="Close the companion (Ctrl+.)" aria-label="Close the companion">
          <Icon name="x" size={15} />
        </button>
      </header>
      <Show when={tab() === "ask"}>
        <Ask
          messages={props.messages}
          chatKey={key()}
          on={aiOn("summaries", newest()?.accountId)}
          sender={sender}
          onJump={props.onJump}
          onOpenAi={props.onOpenAi}
        />
      </Show>
      <Show when={tab() === "person"}>
        <Person messages={props.messages} mine={props.mine} />
      </Show>
      <Show when={tab() === "promises"}>
        <Promises messages={props.messages} mine={props.mine} onJump={props.onJump} />
      </Show>
      <Show when={tab() === "files"}>
        <Files messages={props.messages} sender={sender} />
      </Show>
    </aside>
  );
}

function Ask(props: {
  messages: ThreadMessage[];
  chatKey: string;
  on: boolean;
  sender: (m: ThreadMessage) => string;
  onJump: (id: number) => void;
  onOpenAi: () => void;
}) {
  const [turns, setTurns] = createSignal<Turn[]>(chats.get(props.chatKey) ?? []);
  const [question, setQuestion] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const keep = (next: Turn[]) => {
    setTurns(next);
    chats.set(props.chatKey, next);
  };
  const newest = () => props.messages[props.messages.length - 1];

  const send = async (text = question()) => {
    const q = text.trim();
    if (!q || busy() || !newest()) return;
    setQuestion("");
    setBusy(true);
    const earlier = turns()
      .filter((t) => t.done)
      .map((t) => [t.question, t.answer] as [string, string]);
    const at = turns().length;
    keep([...turns(), { question: q, answer: "", done: null, error: "" }]);
    const update = (patch: Partial<Turn>) => keep(turns().map((t, i) => (i === at ? { ...t, ...patch } : t)));
    try {
      let streamed = "";
      const done = await api.aiAsk(newest().id, q, earlier, (w) => update({ answer: (streamed += w) }));
      update({ answer: done.text, done });
    } catch (e) {
      update({ error: String(e) });
    }
    setBusy(false);
  };

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
    <div class="companion-body ask">
      <Show
        when={props.on}
        fallback={
          <div class="companion-empty">
            <p>Ask about this conversation: who still owes what, what was decided, a summary for someone else.</p>
            <p class="quiet">It needs AI, which is off for this account. Nothing is sent until you ask.</p>
            <button type="button" onClick={props.onOpenAi}>
              Settings → AI
            </button>
          </div>
        }
      >
        <div class="chips">
          <span class="chip">This conversation · {props.messages.length}</span>
        </div>
        <div class="turns" aria-live="polite">
          <For
            each={turns()}
            fallback={
              <div class="suggest">
                <For each={["What do they need from me?", "What was decided?", "Summarise it for someone else."]}>
                  {(s) => (
                    <button type="button" onClick={() => void send(s)}>
                      {s}
                    </button>
                  )}
                </For>
              </div>
            }
          >
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
        </div>
        <form
          class="ask-box"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <label for="companion-ask" class="visually-hidden">
            Ask about this conversation
          </label>
          <textarea
            id="companion-ask"
            rows="2"
            placeholder="Ask about this conversation…"
            value={question()}
            onInput={(e) => setQuestion(e.currentTarget.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <button type="submit" class="send" disabled={busy() || !question().trim()} aria-label="Ask">
            <Icon name="send" size={14} />
          </button>
        </form>
        <div class="quiet">Enter asks · sends this conversation when you ask, nothing before</div>
      </Show>
    </div>
  );
}

function Person(props: { messages: ThreadMessage[]; mine: (addr: string) => boolean }) {
  /** The person the conversation is with: the newest message's sender who isn't you. */
  const who = createMemo(() => [...props.messages].reverse().find((m) => !props.mine(m.fromAddr)));
  const [card] = createResource(() => who()?.fromAddr, (email) => api.contactCard(email));
  const usualReply = createMemo(() => {
    // How long you took to answer them in this conversation, as a rough sense of pace.
    const gaps: number[] = [];
    for (let i = 1; i < props.messages.length; i++) {
      const a = props.messages[i - 1];
      const b = props.messages[i];
      if (!props.mine(a.fromAddr) && props.mine(b.fromAddr)) gaps.push(b.date - a.date);
    }
    if (!gaps.length) return null;
    const mid = gaps.sort((x, y) => x - y)[Math.floor(gaps.length / 2)];
    return mid < 3600 ? `${Math.max(1, Math.round(mid / 60))} min` : mid < 86_400 ? `${Math.round(mid / 3600)} h` : `${Math.round(mid / 86_400)} d`;
  });
  return (
    <div class="companion-body person">
      <Show when={who()} fallback={<p class="companion-empty">Only you wrote in this conversation.</p>}>
        {(m) => (
          <>
            <div class="person-head">
              <strong>{m().fromName || m().fromAddr}</strong>
              <span class="quiet">{m().fromAddr}</span>
            </div>
            <Show when={card()}>
              {(c) => (
                <>
                  <div class="stats">
                    <div>
                      <strong>{c().received}</strong>
                      <span>from them</span>
                    </div>
                    <div>
                      <strong>{c().sent}</strong>
                      <span>from you</span>
                    </div>
                    <Show when={usualReply()}>
                      <div>
                        <strong>{usualReply()}</strong>
                        <span>you take to answer</span>
                      </div>
                    </Show>
                  </div>
                  <h3>Recent with them</h3>
                  <ul class="recent">
                    <For each={c().recent.slice(0, 6)}>
                      {(r) => (
                        <li>
                          <span class="subject">{r.subject || "(no subject)"}</span>
                          <span class="quiet">{when(r.date)}</span>
                        </li>
                      )}
                    </For>
                  </ul>
                </>
              )}
            </Show>
            <p class="quiet foot">From your own mail, on this computer.</p>
          </>
        )}
      </Show>
    </div>
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
  const group = (yours: boolean, title: string, none: string) => (
    <>
      <h3>{title}</h3>
      <For each={all().filter((p) => p.yours === yours)} fallback={<p class="quiet">{none}</p>}>
        {(p) => (
          <div class="pledge" classList={{ done: done(p.key) }}>
            <input type="checkbox" checked={done(p.key)} onChange={() => tick(p.key)} aria-label={`Done: ${p.text}`} />
            <div>
              <button type="button" class="link text" onClick={() => props.onJump(p.message)}>
                {p.text}
              </button>
              <span class="quiet">
                {p.who}
                <Show when={p.due}>{(d) => <span class="due"> · by {new Date(d() * 1000).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })}</span>}</Show>
              </span>
            </div>
          </div>
        )}
      </For>
    </>
  );
  return (
    <div class="companion-body promises">
      {group(true, "You owe", "Nothing asked of you, nothing you said you'd do.")}
      {group(false, "Owed to you", "Nobody owes you anything here.")}
      <p class="quiet foot">Found in the words on this computer: "can you…?", "I'll…". Tick what's done.</p>
    </div>
  );
}

function Files(props: { messages: ThreadMessage[]; sender: (m: ThreadMessage) => string }) {
  const files = createMemo(() =>
    props.messages.flatMap((m) => filesOf(m).map(({ file: a, index }) => ({ m, a, index }))).reverse(),
  );
  const kb = (n: number) => (n > 1_000_000 ? `${(n / 1_000_000).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1000))} kB`);
  return (
    <div class="companion-body files">
      <For each={files()} fallback={<p class="companion-empty">No files in this conversation.</p>}>
        {(f) => (
          <button type="button" class="file" onClick={() => void api.openAttachment(f.m.id, f.index)}>
            <Icon name="file" size={16} />
            <span class="name">{f.a.name}</span>
            <span class="quiet">
              {props.sender(f.m)} · {when(f.m.date)} · {kb(f.a.size)}
            </span>
          </button>
        )}
      </For>
    </div>
  );
}
