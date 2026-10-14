import { For, onCleanup, onMount, Show } from "solid-js";
import type { OutboxProblem } from "../api";

export function ProblemsDialog(props: {
  problems: OutboxProblem[];
  onRetry: (id: number) => void;
  onDiscard: (id: number) => void;
  /** Opens a refused send in compose as a draft, to fix and send again. */
  onEdit: (id: number) => void;
  onClose: () => void;
}) {
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      props.onClose();
    }
  };
  onMount(() => window.addEventListener("keydown", onKey, true));
  onCleanup(() => window.removeEventListener("keydown", onKey, true));

  return (
    <div class="overlay" onClick={(e) => e.target === e.currentTarget && props.onClose()}>
      <div class="problems" role="dialog" aria-label="Changes that didn't go through">
        <h2>Changes that didn't go through</h2>
        <p class="note">
          Tern stopped trying these. Retry sends one again; Discard drops it and puts your mailbox back as it was.
        </p>
        <For each={props.problems} fallback={<p class="note">Nothing left to review.</p>}>
          {(p) => (
            <div class="problem">
              <div class="what">
                <strong>{p.what}</strong>
                <span class="error" title={p.lastError}>
                  {p.lastError}
                </span>
                <span class="note">
                  {p.maybeSent
                    ? "It may have been sent. Check Sent before sending it again."
                    : p.attempts === 1
                      ? "Tried once"
                      : `Tried ${p.attempts} times`}
                </span>
              </div>
              <Show when={p.what.startsWith("Send") && !p.maybeSent}>
                <button onClick={() => props.onEdit(p.id)}>Edit</button>
              </Show>
              <button onClick={() => props.onRetry(p.id)}>{p.maybeSent ? "Send again" : "Retry"}</button>
              <button class="danger" onClick={() => props.onDiscard(p.id)}>
                {p.maybeSent ? "Don't send" : "Discard"}
              </button>
            </div>
          )}
        </For>
        <footer>
          <button onClick={props.onClose}>
            Close <kbd>Esc</kbd>
          </button>
        </footer>
      </div>
    </div>
  );
}
