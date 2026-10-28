import { createSignal, onCleanup, Show } from "solid-js";
import { api } from "../api";
import { Icon } from "./Icon";

/** Tern's own title bar (§3): the system draws none. The sidebar button on the left, the window's buttons on the
 * right, and the rest of it drags the window (a double click maximizes). */
export function TitleBar(props: {
  docked: boolean;
  /** Something in the sidebar's place (the docked sidebar, or settings' sections): the bar takes its tone there. */
  sideTone: boolean;
  onSidebar: () => void;
  onCompose: () => void;
}) {
  const [maximized, setMaximized] = createSignal(false);
  onCleanup(api.onMaximized(setMaximized));

  return (
    <header class="titlebar" classList={{ "side-tone": props.sideTone }} data-tauri-drag-region="deep">
      <div class="titlebar-side">
        <button
          type="button"
          class="icon-button"
          onClick={() => props.onSidebar()}
          title={`${props.docked ? "Hide" : "Show"} the sidebar (Ctrl+\\)`}
          aria-label={props.docked ? "Hide the sidebar" : "Show the sidebar"}
        >
          <Icon name="panel-left" size={17} />
        </button>
        <Show when={!props.docked}>
          <button
            type="button"
            class="icon-button"
            onClick={() => props.onCompose()}
            title="New mail (C)"
            aria-label="New mail"
          >
            <Icon name="plus" size={17} />
          </button>
        </Show>
      </div>
      <div class="titlebar-fill" />
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
    </header>
  );
}
