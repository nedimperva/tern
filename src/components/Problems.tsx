import { For, onCleanup, onMount } from "solid-js";
import type { OutboxProblem } from "../api";

/** Bottom of the list while any work has stopped being retried. Stays until each one is retried or discarded. */
export function ProblemsStrip(props: { count: number; onOpen: () => void }) {
  return (
    <div class="problems-strip" role="status">
      <span class="dot" />
      <span>{props.count === 1 ? "1 change didn't go through" : `${props.count} changes didn't go through`}</span>
      <button class="link" onClick={props.onOpen}>
        Review
      </button>
    </div>
  );
}

export function ProblemsDialog(props: {
  problems: OutboxProblem[];
  onRetry: (id: number) => void;
  onDiscard: (id: number) => void;
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
                <span class="note">{p.attempts === 1 ? "Tried once" : `Tried ${p.attempts} times`}</span>
              </div>
              <button onClick={() => props.onRetry(p.id)}>Retry</button>
              <button class="danger" onClick={() => props.onDiscard(p.id)}>
                Discard
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
