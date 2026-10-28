import { For, Show } from "solid-js";
import { api } from "../api";
import { restartToUpdate } from "../app/actions";
import { idle, problems, selection, setReviewing, update } from "../app/state";
import { held, hints, late, paused, scheduled, syncSentence } from "../app/status";
import { toast, undo } from "../app/toast";
import { Icon } from "./Icon";

/** The line under the list: how sync is doing, work waiting or refused, the latest change with its Undo, and a
 * few keys when the keyboard has been still. */
export function StatusStrip() {
  return (
    <footer class="status">
      <span class={`sync ${syncSentence().tone}`}>
        <span class="dot" />
        {syncSentence().text}
      </span>
      <Show when={paused()}>
        <button class="link waiting-link" onClick={() => void api.setSyncPaused(false)}>
          Resume
        </button>
      </Show>
      <Show when={late().length}>
        <button class="link waiting-link" onClick={() => setReviewing(true)}>
          {late().length === 1 ? "1 change waiting" : `${late().length} changes waiting`}
        </button>
      </Show>
      <Show when={held().length}>
        <button class="link problems-link" onClick={() => setReviewing(true)}>
          {held().length === 1 ? "1 scheduled send to confirm" : `${held().length} scheduled sends to confirm`}
        </button>
      </Show>
      <Show when={scheduled().length}>
        <button class="link waiting-link" onClick={() => setReviewing(true)}>
          {scheduled().length === 1 ? "1 scheduled" : `${scheduled().length} scheduled`}
        </button>
      </Show>
      <Show when={problems().length}>
        <button class="link problems-link" onClick={() => setReviewing(true)}>
          {problems().length === 1 ? "1 change didn't go through" : `${problems().length} changes didn't go through`}
        </button>
      </Show>
      <Show when={update()}>
        {(v) => (
          <button class="update-link" onClick={restartToUpdate} title={`Tern ${v()} is downloaded and checked. Restart to install it.`}>
            <Icon name="download" size={12} />
            Update ready · Restart
          </button>
        )}
      </Show>
      <Show when={selection().size}>
        <span class="selected-count">{selection().size} selected</span>
      </Show>
      <span class="spacer" />
      <Show when={!toast() && idle()}>
        <span class="hints">
          <For each={hints()}>
            {([k, what]) => (
              <span>
                <kbd>{k}</kbd> {what}
              </span>
            )}
          </For>
        </span>
      </Show>
      <Show when={toast()}>
        {(t) => (
          <span class="toast" role="status">
            <span>{t().text}</span>
            <Show when={t().token.length || t().undo}>
              <button class="link" onClick={undo}>
                Undo <kbd>Z</kbd>
              </button>
            </Show>
          </span>
        )}
      </Show>
    </footer>
  );
}
