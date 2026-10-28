import { For, onCleanup, onMount, Show } from "solid-js";
import type { OutboxProblem, OutboxWaiting } from "../api";
import { until } from "./ConversationRow";

/** "in 40 s", "in 3 min": when waiting work is tried next. */
function nextTry(at: number, now: number) {
  const s = Math.max(0, Math.round(at - now));
  return s < 60 ? `in ${s} s` : `in ${Math.round(s / 60)} min`;
}

export function ProblemsDialog(props: {
  problems: OutboxProblem[];
  /** Work still on its way to the server, past its undo window (and scheduled sends held after Tern was closed). */
  waiting: OutboxWaiting[];
  /** Sends scheduled for later. */
  scheduled: OutboxWaiting[];
  onSendNow: (id: number) => void;
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
    if (w.held) return `Was due ${new Date(w.notBefore * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}, while Tern was closed. Send it now, or edit it.`;
    if (w.sending) return "Going out now";
    if (props.offline) return "Goes out when the connection is back";
    if (w.attempts === 0) return "Goes out in a moment";
    const tried = w.attempts === 1 ? "Tried once" : `Tried ${w.attempts} times`;
    return w.notBefore > props.now ? `${tried}. Next try ${nextTry(w.notBefore, props.now)}` : `${tried}. Trying again`;
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/useKeyWithClickEvents: a click beside the dialog closes it, as Esc does
    <div class="overlay" onClick={(e) => e.target === e.currentTarget && props.onClose()}>
      <div class="problems" role="dialog" aria-modal="true" aria-label="Changes on their way to the server">
        <Show when={props.problems.length || (!props.waiting.length && !props.scheduled.length)}>
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
                <Show when={w.held}>
                  <button onClick={() => props.onEdit(w.id)}>Edit</button>
                  <button onClick={() => props.onSendNow(w.id)}>Send now</button>
                </Show>
                <Show
                  when={w.canDiscard && !w.held}
                  fallback={
                    <Show when={!w.sending && !w.held}>
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
        <Show when={props.scheduled.length}>
          <h2>Scheduled</h2>
          <p class="note">
            These go out at their time while Tern is running. If Tern is closed then, it asks when it next starts.
          </p>
          <For each={props.scheduled}>
            {(w) => (
              <div class="problem">
                <div class="what">
                  <strong>{w.what}</strong>
                  <span class="note">Sends {until(w.notBefore)}</span>
                </div>
                <button onClick={() => props.onEdit(w.id)}>Edit</button>
                <button onClick={() => props.onSendNow(w.id)}>Send now</button>
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
