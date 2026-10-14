import { createSignal, For, Show } from "solid-js";
import { api } from "../api";

/** A plausible address: something@something.tld. The server has the last word; this only flags typos. */
export const validAddress = (a: string) => /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/.test(a);

/** "Ada <ada@x.com>" or a bare address → the address. */
const addressOf = (s: string) => s.match(/<([^>]+)>/)?.[1].trim() ?? s.trim();

/** Splits typed or pasted text into addresses ("a@x, b@y; Ada <c@z>"). */
export function splitAddresses(text: string): string[] {
  return text
    .split(/[,;\n]+/)
    .map(addressOf)
    .filter(Boolean);
}

/** A To/Cc/Bcc row: addresses as chips, typed into a field at the end (docs/design/ui.md §4.4). */
export function RecipientField(props: {
  label: string;
  value: string[];
  onChange: (v: string[]) => void;
  ref?: (el: HTMLInputElement) => void;
}) {
  const [text, setText] = createSignal("");
  // Suggestions for what is being typed, and which one ↑/↓ points at.
  const [people, setPeople] = createSignal<{ email: string; name: string }[]>([]);
  const [pointed, setPointed] = createSignal(0);
  let asked = 0;
  let input!: HTMLInputElement;
  const suggest = async (q: string) => {
    const ticket = ++asked;
    const found = q.trim().length ? await api.contacts(q.trim()) : [];
    if (ticket !== asked) return;
    setPeople(found.filter((p) => !props.value.includes(p.email)));
    setPointed(0);
  };
  const pick = (email: string) => {
    if (!props.value.includes(email)) props.onChange([...props.value, email]);
    setText("");
    setPeople([]);
  };

  const commit = () => {
    const found = splitAddresses(text());
    if (found.length) props.onChange([...props.value, ...found.filter((a) => !props.value.includes(a))]);
    setText("");
  };

  const onKeyDown = (e: KeyboardEvent) => {
    const open = people().length > 0;
    if (open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      setPointed((pointed() + (e.key === "ArrowDown" ? 1 : people().length - 1)) % people().length);
      return;
    }
    if (open && ((e.key === "Enter" && !e.ctrlKey && !e.metaKey) || e.key === "Tab")) {
      e.preventDefault();
      pick(people()[pointed()].email);
      return;
    }
    if (open && e.key === "Escape") {
      // Closes the suggestions, not compose.
      e.preventDefault();
      e.stopPropagation();
      setPeople([]);
      return;
    }
    if ((e.key === "Enter" && !e.ctrlKey && !e.metaKey) || e.key === "," || e.key === ";" || (e.key === "Tab" && text().trim())) {
      if (!text().trim()) return;
      e.preventDefault();
      commit();
    } else if (e.key === "Backspace" && !text() && props.value.length) {
      // Takes the last chip back into the field to edit.
      e.preventDefault();
      const last = props.value[props.value.length - 1];
      props.onChange(props.value.slice(0, -1));
      setText(last);
    }
  };

  const onPaste = (e: ClipboardEvent) => {
    const pasted = e.clipboardData?.getData("text") ?? "";
    if (!/[,;\n]/.test(pasted)) return;
    e.preventDefault();
    setText(text() + pasted);
    commit();
  };

  return (
    <div class="field recipients" onMouseDown={(e) => e.target === e.currentTarget && (e.preventDefault(), input.focus())}>
      <span class="label">{props.label}</span>
      <For each={props.value}>
        {(a, i) => (
          <span class="chip" classList={{ invalid: !validAddress(a) }} title={validAddress(a) ? a : `${a} does not look like an address`}>
            {a}
            <button
              type="button"
              tabIndex={-1}
              aria-label={`Remove ${a}`}
              onClick={() => props.onChange(props.value.filter((_, j) => j !== i()))}
            >
              ×
            </button>
          </span>
        )}
      </For>
      <input
        ref={(el) => ((input = el), props.ref?.(el))}
        value={text()}
        onInput={(e) => (setText(e.currentTarget.value), void suggest(e.currentTarget.value))}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        onBlur={() => (setPeople([]), commit())}
        aria-label={props.label}
        aria-autocomplete="list"
      />
      <Show when={people().length}>
        <ul class="suggestions" role="listbox">
          <For each={people()}>
            {(p, i) => (
              <li
                role="option"
                aria-selected={i() === pointed()}
                classList={{ pointed: i() === pointed() }}
                onMouseDown={(e) => (e.preventDefault(), pick(p.email))}
              >
                <span class="name">{p.name || p.email}</span>
                <Show when={p.name}>
                  <span class="addr">{p.email}</span>
                </Show>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </div>
  );
}
