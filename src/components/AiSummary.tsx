import { createEffect, createMemo, createSignal, For, on, Show } from "solid-js";
import { api, type AiFact, type AiSummary as Summary, type ThreadMessage } from "../api";
import { summons } from "../ai";
import type { Facts } from "../facts";
import { promisesIn } from "../promises";
import { settings } from "../settings";
import { dayWord, startTask, todoistOn } from "../app/tasks";
import { snoozeFor, whenSaid } from "./Details";

type Action = { name: string; run: () => void; primary?: boolean };
type Row = { tag: string; tone: "ask" | "day" | "plain" | "done"; text: string; actions: Action[] };

/** The brief under a conversation's subject (docs/design/ui.md §4.2, canvas "Tern summary directions", A + C): what
 * came since you last read it, then what Tern found on this computer (what you were asked, the day, the place), each
 * with what to do about it. With AI on, Explain it (`Shift+S`) adds a sentence on top and the AI's own facts, on
 * request only; a summary kept from before shows at once. Nothing shows when there is nothing to say. */
export function Brief(props: {
  messages: ThreadMessage[];
  mine: (addr: string) => boolean;
  /** What the newest message holds (`facts.ts`), or null. */
  facts: Facts | null;
  /** Coming back to the conversation: how many are new and how many ask you something. */
  back: { count: number; questions: number; first: number } | null;
  ai: boolean;
  onJump: (id: number) => void;
  onReply: (m: ThreadMessage) => void;
  onSnooze: (due: number) => void;
}) {
  const last = () => props.messages[props.messages.length - 1];
  const theirs = () => [...props.messages].reverse().find((m) => !props.mine(m.fromAddr)) ?? last();
  const ai = summary(() => last()?.id, () => props.ai);
  const task = (title: string, due = ""): Action[] =>
    todoistOn() ? [{ name: "Add task", run: () => startTask(last().id, title.replace(/\s*[?.!]+$/, ""), due) }] : [];

  const rows = createMemo((): Row[] => {
    const out: Row[] = [];
    const s = ai.summary();
    if (s) {
      for (const f of s.facts) out.push(aiRow(f));
    } else {
      // Asked of you by someone else, not ticked off in the companion: the newest two.
      const asked = promisesIn(props.messages, props.mine).filter((p) => p.yours && p.who !== "You" && !settings.promisesDone.includes(p.key));
      for (const p of asked.slice(-2)) {
        const m = props.messages.find((x) => x.id === p.message);
        out.push({
          tag: "Asked of you",
          tone: "ask",
          text: `${p.who}: “${p.text}”`,
          actions: [
            ...(m ? [{ name: "Answer", run: () => props.onReply(m), primary: true }] : []),
            ...task(p.text, p.due ? dayWord(p.due) : ""),
            { name: "Show", run: () => props.onJump(p.message) },
          ],
        });
      }
    }
    const w = props.facts?.when;
    if (w && snoozeFor(w) > Date.now() / 1000) {
      out.push({
        tag: "Day",
        tone: "day",
        text: whenSaid(w),
        actions: [{ name: "Snooze till then", run: () => props.onSnooze(snoozeFor(w)) }, ...task(last()?.subject ?? "", dayWord(w.at))],
      });
    }
    const where = props.facts?.where;
    if (where) {
      out.push({
        tag: "Place",
        tone: "plain",
        text: where,
        actions: [{ name: "Map", run: () => api.openUrl(`https://www.openstreetmap.org/search?query=${encodeURIComponent(where)}`) }],
      });
    }
    return out;
  });

  const aiRow = (f: AiFact): Row =>
    f.kind === "asked"
      ? { tag: "Asked of you", tone: "ask", text: f.text, actions: [{ name: "Answer", run: () => props.onReply(theirs()), primary: true }, ...task(f.text)] }
      : f.kind === "due"
        ? { tag: "Due", tone: "day", text: f.text, actions: task(last()?.subject ?? "", f.text) }
        : { tag: "Decided", tone: "done", text: f.text, actions: [] };

  const shown = () => !!props.back || rows().length > 0 || props.ai;
  return (
    <Show when={shown()}>
      <section class="brief" classList={{ bare: !props.back && !rows().length && ai.state() === "idle" }} aria-label="In brief">
        <div class="brief-head">
          <Show when={props.back}>
            {(b) => (
              <span class="since">
                <strong>{b().count === 1 ? "1 new" : `${b().count} new`} since you read it</strong>
                {b().questions ? ` · ${b().questions === 1 ? "a question" : `${b().questions} questions`} for you` : ""}
                <button type="button" class="link" onClick={() => props.onJump(b().first)}>
                  Jump to it
                </button>
              </span>
            )}
          </Show>
          <span class="spacer" />
          <Show when={props.ai}>
            <Show
              when={ai.state() === "done" || ai.state() === "busy"}
              fallback={
                <button type="button" class="ai-ask" onClick={() => void ai.run(false)} title="Explain it with AI (Shift+S). Sends this conversation to your AI provider.">
                  <kbd class="ai-mark">AI</kbd>
                  Explain it
                  <kbd>Shift S</kbd>
                </button>
              }
            >
              <span class="ai-by">
                <kbd class="ai-mark">AI</kbd>
                <Show when={ai.state() === "done"} fallback="Reading the conversation…">
                  <Show when={ai.summary()?.points.length}>
                    <button type="button" class="link" aria-expanded={ai.open()} onClick={() => ai.setOpen(!ai.open())} title="The points (Shift+S)">
                      {ai.open() ? "Less" : "More"}
                    </button>
                  </Show>
                  <button type="button" class="link" onClick={() => void ai.run(true)}>
                    Redo
                  </button>
                  <button type="button" class="link" onClick={ai.dismiss}>
                    Hide
                  </button>
                </Show>
              </span>
            </Show>
          </Show>
        </div>
        <Show when={ai.state() === "busy" ? ai.lede() : ai.summary()?.line}>
          {(line) => (
            <p class="brief-line" aria-live="polite">
              {line()}
            </p>
          )}
        </Show>
        <Show when={ai.state() === "error"}>
          <p class="brief-line error">
            {ai.error()}{" "}
            <button type="button" class="link" onClick={() => void ai.run(false)}>
              Try again
            </button>
          </p>
        </Show>
        <Show when={rows().length}>
          <div class="brief-rows">
            <For each={rows()}>
              {(r) => (
                <div class="brief-row">
                  <span class={`tag ${r.tone}`}>{r.tag}</span>
                  <span class="text">{r.text}</span>
                  <span class="do">
                    <For each={r.actions}>
                      {(a) => (
                        <button type="button" classList={{ primary: !!a.primary }} onClick={a.run}>
                          {a.name}
                        </button>
                      )}
                    </For>
                  </span>
                </div>
              )}
            </For>
          </div>
        </Show>
        <Show when={ai.open() && ai.summary()}>
          {(s) => (
            <>
              <ul class="ai-points">
                <For each={s().points}>{(p) => <li>{p}</li>}</For>
              </ul>
              <p class="ai-note">Written by AI from this conversation. Check what matters.</p>
            </>
          )}
        </Show>
      </section>
    </Show>
  );
}

/** The AI summary of the conversation whose newest message is `id`: nothing is sent until `run`; one kept from before
 * shows at once. New mail (a new `id`) starts over. */
function summary(id: () => number | undefined, on_: () => boolean) {
  const [state, setState] = createSignal<"idle" | "busy" | "done" | "error">("idle");
  const [kept, setKept] = createSignal<Summary | null>(null);
  const [streamed, setStreamed] = createSignal("");
  const [error, setError] = createSignal("");
  const [open, setOpen] = createSignal(false);
  // A conversation changed while an answer was coming: that answer is dropped.
  let asking = 0;
  createEffect(
    on(id, (now) => {
      asking++;
      setState("idle");
      setKept(null);
      setOpen(false);
      if (now && on_())
        void api.aiCachedSummary(now).then(
          (k) => k && now === id() && state() === "idle" && (setKept(k), setState("done")),
          () => {},
        );
    }),
  );
  const run = async (fresh: boolean) => {
    const at = id();
    if (!at || !on_()) return;
    const mine = ++asking;
    setState("busy");
    setStreamed("");
    setError("");
    try {
      const got = await api.aiSummarize(at, fresh, (t) => mine === asking && setStreamed((s) => s + t));
      if (mine !== asking) return;
      setKept(got);
      setState("done");
    } catch (e) {
      if (mine !== asking) return;
      setError(String(e));
      setState("error");
    }
  };
  // Shift+S: ask, or show and hide the points.
  createEffect(
    on(
      summons,
      () => {
        if (state() === "idle" || state() === "error") void run(false);
        else if (state() === "done") setOpen(!open());
      },
      { defer: true },
    ),
  );
  // While it streams: the lede so far, before the facts and points start.
  const lede = () => {
    const out: string[] = [];
    for (const l of streamed().split("\n")) {
      const t = l.trim();
      if (!t) {
        if (out.length) break;
        continue;
      }
      if (/^(Due|Asked|Decided):|^[-•*] /.test(t)) break;
      out.push(t);
    }
    return out.join(" ") || "…";
  };
  const dismiss = () => (setState("idle"), setKept(null), setOpen(false));
  return { state, summary: () => (state() === "done" ? kept() : null), lede, error, open, setOpen, run, dismiss };
}
