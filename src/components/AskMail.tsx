import { createSignal, For, onMount, Show } from "solid-js";
import { api, type AiAnswer } from "../api";
import { setAskingMail } from "../app/state";

const PROVIDER_NAMES: Record<string, string> = { anthropic: "Claude", openai: "OpenAI", gemini: "Gemini" };
type Turn = { question: string; answer: string; done: AiAnswer | null; error: string };
// The chat lasts while Tern runs, so closing and opening again keeps it.
let kept: Turn[] = [];

/** Ask your mail (package 17 F, `A`): a question over all the mail the AI may read. This computer's search finds the
 * messages (the AI only picks the words to search for), the answer cites them as chips that open their
 * conversations, and a receipt says what was sent. Behind the summaries switch; nothing is kept. */
export function AskMail(props: { onOpen: (id: number) => void }) {
  const [turns, setTurns] = createSignal<Turn[]>(kept);
  const [question, setQuestion] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  let field!: HTMLTextAreaElement;
  onMount(() => queueMicrotask(() => field.focus()));
  const keep = (next: Turn[]) => {
    kept = next;
    setTurns(next);
  };
  const send = async () => {
    const q = question().trim();
    if (!q || busy()) return;
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
      const done = await api.aiAskMail(q, earlier, (w) => update({ answer: (streamed += w) }));
      update({ answer: done.text, done });
    } catch (e) {
      update({ error: String(e) });
    }
    setBusy(false);
  };
  /** The answer with each [n] as a chip that opens that message's conversation. */
  const cited = (t: Turn) => {
    const ids = t.done?.messages ?? [];
    return t.answer.split(/(\[\d+\])/).map((part) => {
      const n = /^\[(\d+)\]$/.exec(part)?.[1];
      const id = n ? ids[Number(n) - 1] : undefined;
      if (!id) return part;
      return (
        <button type="button" class="cite" onClick={() => (setAskingMail(false), props.onOpen(id))} title="Open this conversation">
          {n}
        </button>
      );
    });
  };
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: a click beside the panel closes it; Esc does too
    // biome-ignore lint/a11y/noStaticElementInteractions: the same click, on the scrim behind the panel
    <div class="ask-mail-scrim" onClick={(e) => e.target === e.currentTarget && setAskingMail(false)}>
      <section class="ask-mail" role="dialog" aria-label="Ask your mail">
        <header>
          <kbd class="ai-mark">AI</kbd>
          <h2>Ask your mail</h2>
          <span class="quiet">Searched on this computer; what it finds goes to your AI provider</span>
        </header>
        <div class="ask-mail-turns" aria-live="polite">
          <For each={turns()} fallback={<p class="quiet">Who, what, when: “What did Ana decide about the offsite?”, “Which invoices are still open?”</p>}>
            {(t) => (
              <div class="turn">
                <div class="question">{t.question}</div>
                <Show when={!t.error} fallback={<div class="error">{t.error}</div>}>
                  <div class="answer">{t.answer ? cited(t) : "Searching your mail…"}</div>
                  <Show when={t.done}>
                    {(d) => (
                      <div class="receipt">
                        {PROVIDER_NAMES[d().route.provider] ?? d().route.provider} · {d().messages.length}{" "}
                        {d().messages.length === 1 ? "message" : "messages"} found here, {d().sentChars.toLocaleString()} characters
                        sent · nothing kept
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
          <label for="ask-mail" class="visually-hidden">
            Ask your mail
          </label>
          <textarea
            id="ask-mail"
            ref={field}
            rows="1"
            placeholder="Ask your mail"
            value={question()}
            onInput={(e) => setQuestion(e.currentTarget.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Escape") setAskingMail(false);
              else if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <button type="submit" class="send" disabled={busy() || !question().trim()}>
            Ask
          </button>
        </form>
      </section>
    </div>
  );
}
