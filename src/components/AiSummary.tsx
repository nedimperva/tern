import { createEffect, createSignal, For, Match, on, Show, Switch } from "solid-js";
import { api, type AiFact, type AiSummary as Summary } from "../api";
import { summons } from "../ai";
import { Icon } from "./Icon";

const FACT_LABEL: Record<AiFact["kind"], string> = { due: "Due", asked: "Asked of you", decided: "Decided" };

/** The AI summary under a conversation's subject (docs/design/ui.md §4.2): a quiet Summarize until asked, then a
 * lede of one or two sentences with the conversation's facts as chips (what is due, asked of you, decided), and
 * More for the points. Nothing is sent until the person asks; a summary kept from before shows at once. `id` is the
 * newest message, so new mail means a new summary. */
export function AiSummary(props: { id: number }) {
  const [state, setState] = createSignal<"idle" | "busy" | "done" | "error">("idle");
  const [summary, setSummary] = createSignal<Summary | null>(null);
  const [streamed, setStreamed] = createSignal("");
  const [error, setError] = createSignal("");
  const [open, setOpen] = createSignal(false);
  // A conversation changed while an answer was coming: that answer is dropped.
  let asking = 0;

  createEffect(
    on(
      () => props.id,
      (id) => {
        asking++;
        setState("idle");
        setSummary(null);
        setOpen(false);
        void api.aiCachedSummary(id).then(
          (kept) => kept && id === props.id && state() === "idle" && (setSummary(kept), setState("done")),
          () => {},
        );
      },
    ),
  );

  const run = async (fresh: boolean) => {
    const id = props.id;
    const mine = ++asking;
    setState("busy");
    setStreamed("");
    setError("");
    try {
      const got = await api.aiSummarize(id, fresh, (t) => mine === asking && setStreamed((s) => s + t));
      if (mine !== asking) return;
      setSummary(got);
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
    return out.join(" ");
  };

  return (
    <div class="ai-summary">
      <Switch>
        <Match when={state() === "idle"}>
          <button class="ai-ask" onClick={() => void run(false)} title="Summarize with AI (Shift S)">
            <kbd class="ai-mark">AI</kbd>
            Summarize
            <kbd>Shift S</kbd>
          </button>
        </Match>
        <Match when={state() === "busy"}>
          <p class="ai-lede" aria-live="polite">
            <kbd class="ai-mark">AI</kbd> {lede() || "Reading the conversation…"}
          </p>
        </Match>
        <Match when={state() === "done" && summary()}>
          {(s) => (
            <>
              <p class="ai-lede">
                <kbd class="ai-mark">AI</kbd> {s().line}
              </p>
              <div class="ai-facts">
                <For each={s().facts}>
                  {(f) => (
                    <span class={`ai-fact ${f.kind}`} title={FACT_LABEL[f.kind]}>
                      <Icon name={f.kind === "due" ? "clock" : f.kind === "decided" ? "check" : "chevron-right"} size={12} />
                      <span class="label">{f.kind === "due" ? "Due" : f.kind === "asked" ? "Asked of you:" : "Decided:"}</span> {f.text}
                    </span>
                  )}
                </For>
                <span class="spacer" />
                <Show when={s().points.length}>
                  <button class="link" aria-expanded={open()} onClick={() => setOpen(!open())} title="The points (Shift S)">
                    {open() ? "Less" : "More"}
                  </button>
                </Show>
                <button class="link" onClick={() => void run(true)}>
                  Regenerate
                </button>
                <button class="link" onClick={() => (setState("idle"), setOpen(false))}>
                  Dismiss
                </button>
              </div>
              <Show when={open()}>
                <ul class="ai-points">
                  <For each={s().points}>{(p) => <li>{p}</li>}</For>
                </ul>
                <p class="ai-note">Written by AI from this conversation. Check what matters.</p>
              </Show>
            </>
          )}
        </Match>
        <Match when={state() === "error"}>
          <p class="ai-line error">
            <kbd class="ai-mark">AI</kbd>
            <span class="text">{error()}</span>
            <button class="link" onClick={() => void run(false)}>
              Try again
            </button>
          </p>
        </Match>
      </Switch>
    </div>
  );
}
