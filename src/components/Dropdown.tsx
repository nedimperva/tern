import { createEffect, createSignal, createUniqueId, For, type JSX, onCleanup, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { Icon } from "./Icon";

export type Choice = {
  value: string;
  label: string;
  /** A second, quieter line under the label (an address's full name, a model's company). */
  detail?: string;
  /** Choices sharing a group sit under its name, as an <optgroup> would. */
  group?: string;
};

/** Tern's own drop-down (docs/design/ui.md §2): a quiet button with the choice and a chevron, opening a list drawn
 * like the other menus. WebKitGTK and WebView2 draw native <select> lists in the system's look, which matches
 * nothing else in Tern. The list sits on the page's top layer, so a dialog's scrolling never clips it. Arrows, Home,
 * End, Enter and Esc work it; letters jump to the next choice starting with them. */
export function Dropdown(props: {
  value: string;
  choices: Choice[];
  onChange: (value: string) => void;
  /** What it picks, for screen readers when no <label> holds it. */
  label?: string;
  disabled?: boolean;
  class?: string;
  /** Shown when no choice has the value (Translate…). */
  placeholder?: string;
  /** Before the choice's name in the button, as the account's dot. */
  lead?: JSX.Element;
  title?: string;
}) {
  const id = createUniqueId();
  const [open, setOpen] = createSignal(false);
  const [pointed, setPointed] = createSignal(0);
  const [place, setPlace] = createSignal({ left: 0, top: 0, width: 0, up: false });
  let button!: HTMLButtonElement;
  let list: HTMLDivElement | undefined;
  const current = () => props.choices.find((c) => c.value === props.value);

  const close = (refocus = true) => {
    if (!open()) return;
    setOpen(false);
    window.removeEventListener("keydown", onKey, true);
    window.removeEventListener("pointerdown", onOutside, true);
    window.removeEventListener("resize", onResize);
    if (refocus) button.focus();
  };
  const choose = (c: Choice) => {
    close();
    if (c.value !== props.value) props.onChange(c.value);
  };
  const onKey = (e: KeyboardEvent) => {
    const n = props.choices.length;
    if (e.key === "Escape") close();
    else if (e.key === "ArrowDown") setPointed((pointed() + 1) % n);
    else if (e.key === "ArrowUp") setPointed((pointed() - 1 + n) % n);
    else if (e.key === "Home") setPointed(0);
    else if (e.key === "End") setPointed(n - 1);
    else if (e.key === "Enter" || e.key === " ") {
      const c = props.choices[pointed()];
      if (c) choose(c);
    } else if (e.key === "Tab") return close(false);
    else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const k = e.key.toLowerCase();
      for (let i = 1; i <= n; i++) {
        const at = (pointed() + i) % n;
        if (props.choices[at].label.toLowerCase().startsWith(k)) {
          setPointed(at);
          break;
        }
      }
    } else return;
    // While it is open the keys belong to it: Esc must not also close compose or the settings page.
    e.preventDefault();
    e.stopImmediatePropagation();
  };
  const onOutside = (e: PointerEvent) => {
    const t = e.target as Node;
    if (!button.contains(t) && !list?.contains(t)) close(false);
  };
  const onResize = () => close(false);
  const show = () => {
    if (props.disabled || !props.choices.length) return;
    const r = button.getBoundingClientRect();
    // Up when there is more room above than below, as a footer's picker at the foot of the window needs.
    const below = window.innerHeight - r.bottom;
    setPlace({ left: r.left, top: below < 240 && r.top > below ? r.top : r.bottom, width: r.width, up: below < 240 && r.top > below });
    setPointed(Math.max(0, props.choices.indexOf(current() as Choice)));
    setOpen(true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("pointerdown", onOutside, true);
    window.addEventListener("resize", onResize);
  };
  onCleanup(() => close(false));
  createEffect(() => {
    if (!open()) return;
    const at = pointed();
    queueMicrotask(() => list?.querySelector(`[data-at="${at}"]`)?.scrollIntoView({ block: "nearest" }));
  });

  // Ahead of each choice that starts a new group, its group's name.
  const startsGroup = (i: number) => {
    const g = props.choices[i].group;
    return g && (i === 0 || props.choices[i - 1].group !== g) ? g : null;
  };

  return (
    <>
      <button
        ref={button}
        type="button"
        role="combobox"
        class={`dropdown ${props.class ?? ""}`}
        classList={{ open: open(), empty: !current() }}
        disabled={props.disabled}
        aria-haspopup="listbox"
        aria-expanded={open()}
        aria-controls={open() ? id : undefined}
        aria-activedescendant={open() ? `${id}-${pointed()}` : undefined}
        aria-label={props.label}
        title={props.title ?? current()?.detail}
        onClick={() => (open() ? close() : show())}
        onKeyDown={(e) => {
          if (!open() && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
            e.preventDefault();
            show();
          }
        }}
      >
        {props.lead}
        <span class="dropdown-value">{current()?.label ?? props.placeholder ?? ""}</span>
        <Icon name="chevron-down" size={13} />
      </button>
      <Show when={open()}>
        <Portal>
          <div
            ref={list}
            id={id}
            class="dropdown-list"
            classList={{ up: place().up }}
            role="listbox"
            aria-label={props.label}
            style={{
              left: `${Math.min(place().left, window.innerWidth - 16 - Math.max(place().width, 180))}px`,
              top: place().up ? undefined : `${place().top + 4}px`,
              bottom: place().up ? `${window.innerHeight - place().top + 4}px` : undefined,
              "min-width": `${Math.max(place().width, 180)}px`,
            }}
          >
            <For each={props.choices}>
              {(c, i) => (
                <>
                  <Show when={startsGroup(i())}>{(g) => <div class="dropdown-group">{g()}</div>}</Show>
                  {/* biome-ignore lint/a11y/useFocusableInteractive: the list keeps focus on its button and points with aria-activedescendant; the keys work it from there. */}
                  <div
                    id={`${id}-${i()}`}
                    data-at={i()}
                    role="option"
                    aria-selected={c.value === props.value}
                    classList={{ pointed: pointed() === i(), chosen: c.value === props.value }}
                    onPointerMove={() => setPointed(i())}
                    onPointerDown={(e) => (e.preventDefault(), choose(c))}
                  >
                    <span class="dropdown-text">
                      {c.label}
                      <Show when={c.detail}>
                        <span class="dropdown-detail">{c.detail}</span>
                      </Show>
                    </span>
                    <Show when={c.value === props.value}>
                      <Icon name="check" size={14} />
                    </Show>
                  </div>
                </>
              )}
            </For>
          </div>
        </Portal>
      </Show>
    </>
  );
}
