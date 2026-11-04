import { createSignal, For, onCleanup, Show } from "solid-js";
import { api } from "../api";
import { restartToUpdate } from "../app/actions";
import { exporting, stopExport } from "../app/files";
import { problems, setReviewing, update } from "../app/state";
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
  const state = () => syncButton();
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
        classList={{ turning: state().turning, labelled: !!label() }}
        aria-expanded={open()}
        aria-label={`${syncSentence().text || "Sync"}. Sync options`}
        title={syncSentence().text}
        onClick={() => setOpen(!open())}
      >
        <Icon name={update() && !state().label ? "download" : state().icon} size={15} />
        <Show when={label()}>
          <span class="sync-label">{label()}</span>
        </Show>
        <span class="dot" />
      </button>
      <Show when={open()}>
        <div class="sync-panel" role="dialog" aria-label="Sync">
          <div class="sync-head">
            <strong>{syncSentence().text || "No accounts yet"}</strong>
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
              <Show when={problems().length}>
                <button type="button" class="link danger" onClick={review}>
                  {count(problems().length, "1 change didn't go through", "changes didn't go through")}
                </button>
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
                    void api.syncNow();
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
