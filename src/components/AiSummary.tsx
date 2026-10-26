import { createEffect, createSignal, For, Match, on, Show, Switch } from "solid-js";
import { api, type AiSummary as Summary } from "../api";
import { summons } from "../ai";
import { Icon } from "./Icon";

/** The AI summary under a conversation's subject (docs/design/ui.md §4.2): a Summarize button until asked, then one
 * line that opens to the points under it. Nothing is sent until the person asks; a summary kept from before shows
 * at once. `id` is the newest message, so new mail means a new summary. */
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

  // Shift+S: ask, or open and close what is there.
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

  const firstLine = () => streamed().split("\n").find((l) => l.trim() && !l.trimStart().startsWith("-")) ?? "";

  return (
    <div class="ai-summary" classList={{ open: open() }}>
      <Switch>
        <Match when={state() === "idle"}>
          <button class="ai-ask" onClick={() => void run(false)} title="Summarize with AI (Shift S)">
            <kbd class="ai-mark">AI</kbd>
            Summarize
            <kbd>Shift S</kbd>
          </button>
        </Match>
        <Match when={state() === "busy"}>
          <p class="ai-line" aria-live="polite">
            <kbd class="ai-mark">AI</kbd>
            <span class="text">{firstLine() || "Reading the conversation…"}</span>
          </p>
        </Match>
        <Match when={state() === "done" && summary()}>
          {(s) => (
            <>
              <button class="ai-line" aria-expanded={open()} onClick={() => setOpen(!open())} title={open() ? "Fewer details (Shift S)" : "The points (Shift S)"}>
                <kbd class="ai-mark">AI</kbd>
                <span class="text">{s().line}</span>
                <Show when={s().points.length}>
                  <Icon name="chevron-down" size={13} />
                </Show>
              </button>
              <Show when={open()}>
                <ul class="ai-points">
                  <For each={s().points}>{(p) => <li>{p}</li>}</For>
                </ul>
                <div class="ai-actions">
                  <span>Written by AI from this conversation. Check what matters.</span>
                  <button class="link" onClick={() => void run(true)}>
                    Regenerate
                  </button>
                  <button class="link" onClick={() => (setState("idle"), setOpen(false))}>
                    Dismiss
                  </button>
                </div>
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
