import { createSignal, onCleanup, Show } from "solid-js";
import { api } from "../api";
import { selection, setConvSlot, setTitleSlot } from "../app/state";
import { Icon } from "./Icon";
import { SelectionBar } from "./SelectionBar";
import { SyncButton } from "./SyncButton";

/** Tern's own title bar (§3): the system draws none. The sidebar button on the left, the window's buttons on the
 * right, and the rest of it drags the window (a double click maximizes). */
export function TitleBar(props: {
  docked: boolean;
  /** Something in the sidebar's place (the docked sidebar, or settings' sections): the bar takes its tone there. */
  sideTone: boolean;
  onSidebar: () => void;
  onCompose: () => void;
  /** The list is what the window shows (not settings or the morning screen), so its tabs belong up here. */
  list: boolean;
}) {
  const [maximized, setMaximized] = createSignal(false);
  onCleanup(api.onMaximized(setMaximized));

  return (
    <header class="titlebar" classList={{ "side-tone": props.sideTone, selecting: props.list && selection().size > 0 }} data-tauri-drag-region="deep">
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
      {/* The list's tabs and search (ListPane portals them here); the fill after it still drags the window. */}
      <div class="titlebar-slot" classList={{ hidden: !props.list }} ref={setTitleSlot} />
      {/* An open conversation's subject and tools (ConversationView portals them here). */}
      <div class="titlebar-conv" ref={setConvSlot} />
      <div class="titlebar-fill" />
      <SyncButton />
      {/* Conversations selected: the bar becomes what can be done with them, over the tabs, search and sync. */}
      <Show when={props.list && selection().size > 0}>
        <SelectionBar />
      </Show>
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
