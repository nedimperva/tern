import { Show } from "solid-js";
import { toast, undo } from "../app/toast";

/** The latest change with its Undo, as a pill at the foot of the window, only while it can be undone. (A selection
 * says so in the title bar.) */
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
    </div>
  );
}
