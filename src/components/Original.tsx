import { createResource, onCleanup, onMount, Show } from "solid-js";
import { api } from "../api";

/** "Show original": a message's headers and source as the server holds it, for checking who really sent it or
 * where it went on the way. Shown as text, never rendered, over everything like the attachment viewer. */
export function Original(props: { id: number; subject: string; onClose: () => void }) {
  const [source] = createResource(() => props.id, (id) => api.messageSource(id));
  const copy = () => void navigator.clipboard.writeText(source() ?? "").catch(() => {});

  // Tern's shortcuts wait while it is open; the arrows, Page Down and Ctrl+C still work on the text.
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") (e.preventDefault(), props.onClose());
    e.stopPropagation();
  };
  onMount(() => window.addEventListener("keydown", onKey, true));
  onCleanup(() => window.removeEventListener("keydown", onKey, true));

  return (
    <div class="viewer original" role="dialog" aria-label={`Original of ${props.subject}`}>
      <header>
        <span class="title">
          <strong>{props.subject}</strong>
          <span>Original message, as the server has it</span>
        </span>
        <button onClick={copy} disabled={!source()}>
          Copy
        </button>
        <button class="close" onClick={props.onClose} aria-label="Close">
          <kbd>Esc</kbd>
        </button>
      </header>
      <div class="stage">
        <Show when={!source.error} fallback={<p class="viewer-problem">{String(source.error)}</p>}>
          <Show when={source()} fallback={<p class="viewer-note">Getting the message from the server…</p>}>
            {(text) => <pre class="text">{text()}</pre>}
          </Show>
        </Show>
      </div>
    </div>
  );
}
