import { createEffect, createSignal, For, Match, on, onCleanup, Show, Switch } from "solid-js";
import { api, type AiSuggestion } from "../api";
import { replyAsks, setSuggestions } from "../ai";

/** Suggested replies (docs/design/ui.md §4.2), above the reply row: "Suggest replies" until asked, then three cards
 * that say what each reply does ("Accept", "Another time"), the pointed one's words under them. A click, or 1–3,
 * starts a reply with it, to edit and send as usual. Nothing is sent until the person asks. `id` is the newest
 * message. */
export function AiReplies(props: { id: number; onPick: (text: string) => void }) {
  const [state, setState] = createSignal<"idle" | "busy" | "done" | "error">("idle");
  const [list, setList] = createSignal<AiSuggestion[]>([]);
  const [pointed, setPointed] = createSignal(0);
  const [streamed, setStreamed] = createSignal("");
  const [error, setError] = createSignal("");
  let asking = 0;

  createEffect(
    on(
      () => props.id,
      () => {
        asking++;
        setState("idle");
        setList([]);
      },
    ),
  );
  createEffect(() => setSuggestions(state() === "done" ? list().map((s) => s.text) : []));
  onCleanup(() => setSuggestions([]));

  const run = async (fresh: boolean) => {
    const id = props.id;
    const mine = ++asking;
    setState("busy");
    setStreamed("");
    try {
      const got = await api.aiReplies(id, fresh, (t) => mine === asking && setStreamed((s) => s + t));
      if (mine !== asking) return;
      setList(got);
      setPointed(0);
      setState("done");
    } catch (e) {
      if (mine !== asking) return;
      setError(String(e));
      setState("error");
    }
  };
  createEffect(on(replyAsks, () => state() !== "busy" && void run(state() === "done"), { defer: true }));

  // While streaming, the labels so far.
  const partial = () =>
    streamed()
      .split("\n")
      .map((l) => l.replace(/^\s*\d[.)]\s*/, "").split("|")[0].trim())
      .filter(Boolean);

  return (
    <div class="ai-replies">
      <Switch>
        <Match when={state() === "idle"}>
          <button class="ai-ask" onClick={() => void run(false)} title="Suggest replies with AI (Q)">
            <kbd class="ai-mark">AI</kbd>
            Suggest replies
            <kbd>Q</kbd>
          </button>
        </Match>
        <Match when={state() === "busy"}>
          <div class="ai-answer-head" aria-live="polite">
            <kbd class="ai-mark">AI</kbd>
            <span class="kicker">Answer with</span>
            <span class="ai-wait">{partial().join(" · ") || "Thinking of replies…"}</span>
          </div>
        </Match>
        <Match when={state() === "done"}>
          <div class="ai-answer-head">
            <kbd class="ai-mark">AI</kbd>
            <span class="kicker">Answer with</span>
          </div>
          <div class="ai-intents">
            <For each={list()}>
              {(s, i) => (
                <button
                  class="ai-intent"
                  classList={{ pointed: pointed() === i() }}
                  onMouseEnter={() => setPointed(i())}
                  onFocus={() => setPointed(i())}
                  onClick={() => props.onPick(s.text)}
                  title={`Reply with this (${i() + 1})`}
                >
                  <span class="head">
                    <kbd>{i() + 1}</kbd>
                    <strong>{s.label}</strong>
                  </span>
                  <span class="gist">{s.text}</span>
                </button>
              )}
            </For>
          </div>
          <Show when={list()[pointed()]}>{(s) => <div class="ai-intent-text">{s().text}</div>}</Show>
          <div class="ai-intent-foot">
            <span>1, 2 or 3 starts a reply with it, to edit before you send.</span>
            <span class="spacer" />
            <button class="link" onClick={() => void run(true)} title="Three others (Q)">
              Others
            </button>
            <button class="link" onClick={() => setState("idle")}>
              Dismiss
            </button>
          </div>
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
