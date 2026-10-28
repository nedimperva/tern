import { createEffect, createSignal, Index, onCleanup, Show } from "solid-js";
import { Icon } from "./Icon";

export type MenuItem = { name: string; keys?: string; run: () => void };

/** The conversation's `…` menu (docs/design/ui.md §4.2): every action with its key, so a mouse user can find
 * them and learn the keys on the way. While it is open the arrows, Enter and Esc belong to it. */
export function ActionMenu(props: { items: () => MenuItem[] }) {
  const [open, setOpen] = createSignal(false);
  const [pointed, setPointed] = createSignal(0);
  let root!: HTMLDivElement;
  let trigger!: HTMLButtonElement;
  const items: HTMLButtonElement[] = [];
  // Focus follows the pointed item, so a screen reader says each one; closing gives it back to the button.
  // A microtask later: the items are drawn after `open` turns true.
  createEffect(() => {
    if (!open()) return;
    const at = pointed();
    queueMicrotask(() => items[at]?.focus());
  });

  const close = () => {
    if (open() && root.contains(document.activeElement)) trigger.focus();
    setOpen(false);
    window.removeEventListener("keydown", onKey, true);
    window.removeEventListener("pointerdown", onOutside, true);
  };
  const pick = (item: MenuItem) => {
    close();
    item.run();
  };
  const onKey = (e: KeyboardEvent) => {
    const items = props.items();
    if (e.key === "Escape") close();
    else if (e.key === "ArrowDown" || e.key === "j") setPointed((pointed() + 1) % items.length);
    else if (e.key === "ArrowUp" || e.key === "k") setPointed((pointed() - 1 + items.length) % items.length);
    else if (e.key === "Enter" && items[pointed()]) pick(items[pointed()]);
    // Any other key closes the menu and then does what it always does.
    else return close();
    e.preventDefault();
    e.stopImmediatePropagation();
  };
  const onOutside = (e: PointerEvent) => !root.contains(e.target as Node) && close();
  const toggle = () => {
    if (open()) return close();
    setPointed(0);
    setOpen(true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("pointerdown", onOutside, true);
  };
  onCleanup(close);

  return (
    <div class="action-menu" ref={root}>
      <button ref={trigger} class="link more" onClick={toggle} aria-label="More actions" aria-haspopup="menu" aria-expanded={open()} title="More actions">
        <Icon name="more" size={18} />
      </button>
      <Show when={open()}>
        <div class="menu-list" role="menu" aria-label="More actions">
          {/* By place, not by item: the items are made afresh as the conversation changes, and new buttons would
              take the focus away from the one pointed at. */}
          <Index each={props.items()}>
            {(item, i) => (
              <button
                ref={(el) => (items[i] = el)}
                type="button"
                role="menuitem"
                tabIndex={-1}
                classList={{ pointed: i === pointed() }}
                onPointerEnter={() => setPointed(i)}
                onClick={() => pick(item())}
              >
                <span>{item().name}</span>
                <Show when={item().keys}>
                  <kbd>{item().keys}</kbd>
                </Show>
              </button>
            )}
          </Index>
        </div>
      </Show>
    </div>
  );
}
