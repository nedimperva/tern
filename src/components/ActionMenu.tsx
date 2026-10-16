import { createSignal, For, onCleanup, Show } from "solid-js";
import { Icon } from "./Icon";

export type MenuItem = { name: string; keys?: string; run: () => void };

/** The conversation's `…` menu (docs/design/ui.md §4.2): every action with its key, so a mouse user can find
 * them and learn the keys on the way. While it is open the arrows, Enter and Esc belong to it. */
export function ActionMenu(props: { items: () => MenuItem[] }) {
  const [open, setOpen] = createSignal(false);
  const [pointed, setPointed] = createSignal(0);
  let root!: HTMLDivElement;

  const close = () => {
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
      <button class="link more" onClick={toggle} aria-label="More actions" aria-expanded={open()} title="More actions">
        <Icon name="more" size={18} />
      </button>
      <Show when={open()}>
        <ul role="menu">
          <For each={props.items()}>
            {(item, i) => (
              <li
                role="menuitem"
                classList={{ pointed: i() === pointed() }}
                onPointerEnter={() => setPointed(i())}
                onClick={() => pick(item)}
              >
                <span>{item.name}</span>
                <Show when={item.keys}>
                  <kbd>{item.keys}</kbd>
                </Show>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </div>
  );
}
