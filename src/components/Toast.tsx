import { Show } from "solid-js";
import { toast, undo } from "../app/toast";

/** The latest change with its Undo, as a pill at the foot of the window, only while it can be undone. (A selection
 * says so in the title bar.) A thin line along its foot runs out with the undo window. */
export function Toast() {
  return (
    <div class="float-pills" role="status">
      <Show when={toast()} keyed>
        {(t) => (
          <span class="pill">
            <span class="text">{t.text}</span>
            <Show when={t.token.length || t.undo}>
              <button type="button" onClick={undo}>
                Undo <kbd>Z</kbd>
              </button>
              <span class="undo-time" aria-hidden="true" style={{ "animation-duration": `${Math.max(0, t.until - Date.now())}ms` }} />
            </Show>
          </span>
        )}
      </Show>
    </div>
  );
}
