import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import { api } from "../api";
import { discardProblem, restartToUpdate } from "../app/actions";
import { exporting, stopExport } from "../app/files";
import { refresh } from "../app/list";
import { plainError } from "../plainError";
import { problems, setReviewing, syncStates, update } from "../app/state";
import { accountStates, held, late, paused, scheduled, syncButton, syncSentence } from "../app/status";
import { Icon } from "./Icon";

/** The title bar's one word on sync (canvas "Tern toolbar and status bar", A): arrows and a dot while all is well,
 * a word or two when something needs a look. A click opens how each account is doing, what waits, Sync now and
 * Pause. It takes the place of the strip that ran under the list. */
export function SyncButton() {
  const [open, setOpen] = createSignal(false);
  let box: HTMLDivElement | undefined;

  // A click anywhere else closes it; so does Esc, without reaching the window's keys.
  const away = (e: PointerEvent) => {
    if (box && !box.contains(e.target as Node)) setOpen(false);
  };
  const esc = (e: KeyboardEvent) => {
    if (e.key === "Escape" && open()) {
      e.stopPropagation();
      setOpen(false);
    }
  };
  document.addEventListener("pointerdown", away);
  // Before the window's own keys, which would close the conversation too.
  document.addEventListener("keydown", esc, true);
  onCleanup(() => {
    document.removeEventListener("pointerdown", away);
    document.removeEventListener("keydown", esc, true);
  });

  const review = () => {
    setOpen(false);
    setReviewing(true);
  };
  const count = (n: number, one: string, many: string) => (n === 1 ? one : `${n} ${many}`);
  // "Up to date" is about the connection; with changes the server refused, those lead instead.
  const headline = () => {
    const n = problems().length + held().length;
    const sentence = syncSentence();
    if (n && sentence.tone !== "danger") return n === 1 ? "1 change needs a look" : `${n} changes need a look`;
    return sentence.text || "No accounts yet";
  };
  const state = () => syncButton();
  // Sync now turns the arrows until every account has been through a pass (or 20 s, for a server that is slow to
  // say so). A turn always finishes: stopping mid-turn, or starting again on each short pass, looked jerky.
  const [asked, setAsked] = createSignal(false);
  const [seenBusy, setSeenBusy] = createSignal(false);
  const busy = () => Object.values(syncStates()).some((s) => s === "syncing" || s === "connecting");
  createEffect(() => {
    if (!asked()) return;
    if (busy()) setSeenBusy(true);
    else if (seenBusy()) setAsked(false);
  });
  const syncNow = () => {
    setSeenBusy(false);
    setAsked(true);
    window.setTimeout(() => setAsked(false), 20_000);
    void api.syncNow();
  };
  const want = () => state().turning || asked();
  const [spinning, setSpinning] = createSignal(false);
  createEffect(() => {
    if (want()) return setSpinning(true);
    // The turn's end stops it; this catches a window that draws no frames (hidden) and so never ends a turn.
    const late = window.setTimeout(() => setSpinning(false), 1100);
    onCleanup(() => clearTimeout(late));
  });
  // An update or an export says so on the button too: those are the things worth a click.
  const label = () => (update() && !state().label ? "Restart to update" : exporting() && !state().label ? `Exporting ${exportShare()}%` : state().label);
  const exportShare = () => {
    const x = exporting();
    return x?.total ? Math.floor((x.done / x.total) * 100) : 0;
  };

  return (
    <div class="sync-box" ref={box}>
      <button
        type="button"
        class={`sync-button ${state().tone}`}
        classList={{ turning: spinning(), labelled: !!label() }}
        aria-expanded={open()}
        aria-label={`${headline() === "No accounts yet" ? "Sync" : headline()}. Sync options`}
        title={headline()}
        onClick={() => setOpen(!open())}
      >
        {/* "N to look at" has its amber dot; a warning triangle as well said it twice (idea 80). */}
        <Show when={!(state().tone === "warn" && state().label && !spinning())}>
          <span class="sync-icon" onAnimationIteration={() => !want() && setSpinning(false)}>
            <Icon name={update() && !state().label ? "download" : state().icon} size={15} />
          </span>
        </Show>
        <Show when={label()}>
          <span class="sync-label">{label()}</span>
        </Show>
        <span class="dot" />
      </button>
      <Show when={open()}>
        <div class="sync-panel" role="dialog" aria-label="Sync">
          <div class="sync-head">
            <strong>{headline()}</strong>
          </div>
          <ul class="sync-accounts">
            <For each={accountStates()}>
              {(a) => (
                <li class={a.tone}>
                  <span class="dot" />
                  <span class="email">{a.email}</span>
                  <span class="word">{a.word}</span>
                </li>
              )}
            </For>
          </ul>
          <Show when={late().length || scheduled().length || held().length || problems().length}>
            <div class="sync-waiting">
              {/* Each change the server refused, with its own Retry and Discard (idea 19). A send that may have gone
                  out is settled in the full list, where Send again and Don't send are explained. */}
              <Show when={problems().length}>
                <ul class="sync-problems">
                  <For each={problems().slice(0, 3)}>
                    {(p) => (
                      <li>
                        <span class="dot" />
                        <span class="what">
                          {p.what}
                          <small title={p.lastError}>{p.maybeSent ? "It may have gone out already" : p.lastError ? plainError(p.lastError).said : `Stopped after ${p.attempts} tries`}</small>
                        </span>
                        <Show
                          when={!p.maybeSent}
                          fallback={
                            <button type="button" class="mini" onClick={review}>
                              Look
                            </button>
                          }
                        >
                          <button type="button" class="mini" onClick={() => void api.retryProblem(p.id).then(() => refresh())}>
                            Retry
                          </button>
                          <button type="button" class="mini" onClick={() => void discardProblem(p.id)}>
                            Discard
                          </button>
                        </Show>
                      </li>
                    )}
                  </For>
                </ul>
                <Show when={problems().length > 3}>
                  <button type="button" class="link" onClick={review}>
                    All {problems().length} changes
                  </button>
                </Show>
              </Show>
              <Show when={held().length}>
                <button type="button" class="link danger" onClick={review}>
                  {count(held().length, "1 scheduled send to confirm", "scheduled sends to confirm")}
                </button>
              </Show>
              <Show when={late().length}>
                <button type="button" class="link" onClick={review}>
                  {count(late().length, "1 change waiting", "changes waiting")}
                </button>
              </Show>
              <Show when={scheduled().length}>
                <button type="button" class="link" onClick={review}>
                  {count(scheduled().length, "1 scheduled send", "scheduled sends")}
                </button>
              </Show>
            </div>
          </Show>
          <Show when={exporting()}>
            {(x) => (
              <div class="sync-export" role="status">
                <span>
                  Exporting {x().done.toLocaleString()} of {x().total.toLocaleString()}
                </span>
                <span class="bar">
                  <span style={{ width: `${exportShare()}%` }} />
                </span>
                <button type="button" class="link" onClick={() => void stopExport()}>
                  Stop
                </button>
              </div>
            )}
          </Show>
          <div class="sync-actions">
            <Show
              when={update()}
              fallback={
                <button
                  type="button"
                  class="primary"
                  disabled={paused()}
                  onClick={() => {
                    syncNow();
                    setOpen(false);
                  }}
                >
                  Sync now
                </button>
              }
            >
              {(v) => (
                <button type="button" class="primary" onClick={restartToUpdate} title={`Tern ${v()} is downloaded and checked.`}>
                  Restart to update
                </button>
              )}
            </Show>
            <button type="button" onClick={() => void api.setSyncPaused(!paused())}>
              {paused() ? "Resume sync" : "Pause sync"}
            </button>
          </div>
        </div>
      </Show>
    </div>
  );
}
