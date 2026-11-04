import { Show } from "solid-js";
import { selection } from "../app/state";
import { toast, undo } from "../app/toast";

/** The latest change with its Undo, or how many conversations are selected, as a pill at the foot of the window. It
 * shows only while there is something to say. */
export function Toast() {
  return (
    <div class="float-pills" role="status">
      <Show when={toast()}>
        {(t) => (
          <span class="pill">
            <span class="text">{t().text}</span>
            <Show when={t().token.length || t().undo}>
              <button type="button" onClick={undo}>
                Undo <kbd>Z</kbd>
              </button>
            </Show>
          </span>
        )}
      </Show>
      <Show when={!toast() && selection().size}>
        <span class="pill">{selection().size} selected</span>
      </Show>
    </div>
  );
}
