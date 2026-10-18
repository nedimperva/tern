import { createMemo, createSignal, For, Show } from "solid-js";
import { keyLabel, type Binding } from "../keys";
import { fuzzy } from "./CommandBar";

const PLACES: { context: Binding["context"]; title: string }[] = [
  { context: undefined, title: "Anywhere" },
  { context: "list", title: "In the list" },
  { context: "conversation", title: "In a conversation" },
];

/** `?`: every key, searchable. This sheet is the documentation (docs/design/ui.md §6). */
export function ShortcutSheet(props: { bindings: Binding[]; onClose: () => void }) {
  const [query, setQuery] = createSignal("");
  const shown = createMemo(() => {
    const q = query().trim();
    return props.bindings.filter((b) => !b.hidden && b.keys && (!q || fuzzy(b.name, q) || keyLabel(b.keys).toLowerCase() === q.toLowerCase()));
  });
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    props.onClose();
  };

  return (
    <div class="overlay" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div class="sheet" role="dialog" aria-label="Keyboard shortcuts">
        <input
          ref={(el) => queueMicrotask(() => el.focus())}
          placeholder="Find a shortcut"
          value={query()}
          onInput={(e) => setQuery(e.currentTarget.value)}
          onKeyDown={onKeyDown}
        />
        <div class="sheet-body">
          <For each={PLACES}>
            {(place) => (
              <Show when={shown().some((b) => b.context === place.context)}>
                <section>
                  <h3>{place.title}</h3>
                  <For each={shown().filter((b) => b.context === place.context)}>
                    {(b) => (
                      <div class="shortcut">
                        <span>{b.name}</span>
                        <span class="caps">
                          <For each={keyLabel(b.keys).split(" then ")}>
                            {(part, i) => (
                              <>
                                <Show when={i() > 0}>
                                  <span class="then">then</span>
                                </Show>
                                <kbd>{part}</kbd>
                              </>
                            )}
                          </For>
                        </span>
                      </div>
                    )}
                  </For>
                </section>
              </Show>
            )}
          </For>
        </div>
      </div>
    </div>
  );
}
