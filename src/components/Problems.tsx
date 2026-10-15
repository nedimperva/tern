import { For, onCleanup, onMount, Show } from "solid-js";
import type { OutboxProblem, OutboxWaiting } from "../api";

/** "in 40 s", "in 3 min": when waiting work is tried next. */
function nextTry(at: number, now: number) {
  const s = Math.max(0, Math.round(at - now));
  return s < 60 ? `in ${s} s` : `in ${Math.round(s / 60)} min`;
}

export function ProblemsDialog(props: {
  problems: OutboxProblem[];
  /** Work still on its way to the server, past its undo window. */
  waiting: OutboxWaiting[];
  /** No connection at all: waiting work goes out once it is back. */
  offline: boolean;
  /** Unix seconds, for when the next try is. */
  now: number;
  onDiscardWaiting: (id: number) => void;
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

  const waitingNote = (w: OutboxWaiting) => {
    if (w.sending) return "Going out now";
    if (props.offline) return "Goes out when the connection is back";
    if (w.attempts === 0) return "Goes out in a moment";
    const tried = w.attempts === 1 ? "Tried once" : `Tried ${w.attempts} times`;
    return w.notBefore > props.now ? `${tried}. Next try ${nextTry(w.notBefore, props.now)}` : `${tried}. Trying again`;
  };

  return (
    <div class="overlay" onClick={(e) => e.target === e.currentTarget && props.onClose()}>
      <div class="problems" role="dialog" aria-label="Changes on their way to the server">
        <Show when={props.problems.length || !props.waiting.length}>
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
        </Show>
        <Show when={props.waiting.length}>
          <h2>Waiting to go out</h2>
          <p class="note">
            These are done here and still on their way to the server. Tern keeps trying. Discard takes one back, as
            undo would.
          </p>
          <For each={props.waiting}>
            {(w) => (
              <div class="problem">
                <div class="what">
                  <strong>{w.what}</strong>
                  <Show when={w.lastError}>
                    <span class="error" title={w.lastError}>
                      {w.lastError}
                    </span>
                  </Show>
                  <span class="note">{waitingNote(w)}</span>
                </div>
                <Show
                  when={w.canDiscard}
                  fallback={
                    <Show when={!w.sending}>
                      <span class="note" title="A later change to the same messages counts on this one">
                        Needed by a later change
                      </span>
                    </Show>
                  }
                >
                  <button class="danger" onClick={() => props.onDiscardWaiting(w.id)}>
                    Discard
                  </button>
                </Show>
              </div>
            )}
          </For>
        </Show>
        <footer>
          <button onClick={props.onClose}>
            Close <kbd>Esc</kbd>
          </button>
        </footer>
      </div>
    </div>
  );
}
