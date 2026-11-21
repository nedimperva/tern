import { createSignal, onCleanup, Show } from "solid-js";
import { api } from "../api";

/** The window's own buttons (Windows): the system draws no frame, and Tern draws no title bar either. They sit in
 * the top right corner, at the end of whichever column's head is rightmost; that head keeps room for them
 * (`--window-buttons-w`). Each head drags the window from its empty parts. */
export function WindowButtons() {
  const [maximized, setMaximized] = createSignal(false);
  onCleanup(api.onMaximized(setMaximized));

  return (
    <div class="window-buttons">
      <button type="button" onClick={() => api.windowButton("minimize")} title="Minimize" aria-label="Minimize">
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M0 5h10" stroke="currentColor" />
        </svg>
      </button>
      <button
        type="button"
        onClick={() => api.windowButton("maximize")}
        title={maximized() ? "Restore" : "Maximize"}
        aria-label={maximized() ? "Restore" : "Maximize"}
      >
        <Show
          when={maximized()}
          fallback={
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
              <rect x="0.5" y="0.5" width="9" height="9" rx="1" stroke="currentColor" />
            </svg>
          }
        >
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
            <rect x="0.5" y="2.5" width="7" height="7" rx="1" stroke="currentColor" />
            <path d="M2.5 2.5V1.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-1" stroke="currentColor" />
          </svg>
        </Show>
      </button>
      <button type="button" class="close" onClick={() => api.windowButton("close")} title="Close" aria-label="Close">
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M0 0l10 10M10 0L0 10" stroke="currentColor" />
        </svg>
      </button>
    </div>
  );
}
