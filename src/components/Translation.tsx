// A message in the person's language (idea 122), under the conversation, asked for from its … menu. Sent to the AI
// only on that ask, through the same gate as summaries; the original stays above, untouched.

import { createSignal, Show } from "solid-js";
import { api, type AiTranslation } from "../api";
import { Icon } from "./Icon";

/** The language translations go to: the one Tern's window runs in, by name ("German"). */
export function ownLanguage(): string {
  const code = (navigator.language || "en").split("-")[0];
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(code) ?? "English";
  } catch {
    return "English";
  }
}

export function Translation(props: { id: number; to: string; onClose: () => void }) {
  const [streamed, setStreamed] = createSignal("");
  const [got, setGot] = createSignal<AiTranslation | null>(null);
  const [error, setError] = createSignal("");
  void api.aiTranslate(props.id, props.to, (t) => setStreamed((s) => s + t)).then(setGot, (e) => setError(String(e)));
  const text = () => got()?.text ?? streamed();
  return (
    <section class="card translation" aria-live="polite" aria-label={`Translated to ${props.to}`}>
      <header>
        <Icon name="globe" size={14} />
        <span>
          {got() && !got()!.text ? `Already in ${props.to}` : `In ${props.to}`}
          <span class="quiet">{got()?.cached ? " · kept from before, nothing sent" : " · by AI, check what matters"}</span>
        </span>
        <span class="spacer" />
        <button type="button" class="link" onClick={props.onClose}>
          Hide
        </button>
      </header>
      <Show when={!error()} fallback={<p class="error">{error()}</p>}>
        <Show when={text()} fallback={<p class="quiet">{got() ? "" : "Translating…"}</p>}>
          <div class="text">{text()}</div>
        </Show>
      </Show>
    </section>
  );
}
