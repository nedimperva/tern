import { createEffect, createSignal, For, on, onMount, Show } from "solid-js";
import { api } from "../api";
import { until } from "./ConversationRow";

/** The choices before anything is typed; each is what the engine's time reader understands. */
const PRESETS: { name: string; text: string }[] = [
  { name: "Later today", text: "later" },
  { name: "This evening", text: "tonight" },
  { name: "Tomorrow", text: "tomorrow" },
  { name: "This weekend", text: "weekend" },
  { name: "Next week", text: "next week" },
];

type Choice = { name: string; due: number };

/** `h`: until when a conversation is snoozed. Typing reads a time ("tomorrow 9am", "3h", "mon", "dec 3"). */
export function SnoozePicker(props: { count: number; onPick: (due: number) => void; onClose: () => void }) {
  const [presets, setPresets] = createSignal<Choice[]>([]);
  const [typed, setTyped] = createSignal("");
  const [parsed, setParsed] = createSignal<number | null>(null);
  const [index, setIndex] = createSignal(0);

  onMount(async () => {
    const out: Choice[] = [];
    for (const p of PRESETS) {
      const due = await api.parseWhen(p.text);
      // "This evening" is gone once the evening has started.
      if (due != null) out.push({ name: p.name, due });
    }
    setPresets(out);
  });
  let asked = 0;
  createEffect(
    on(typed, async (text) => {
      const ticket = ++asked;
      const due = text.trim() ? await api.parseWhen(text) : null;
      if (ticket === asked) (setParsed(due), setIndex(0));
    }),
  );
  const choices = (): Choice[] => {
    if (!typed().trim()) return presets();
    const due = parsed();
    return due == null ? [] : [{ name: typed().trim(), due }];
  };

  const onKeyDown = (e: KeyboardEvent) => {
    const list = choices();
    if (e.key === "Escape") props.onClose();
    else if (e.key === "ArrowDown") setIndex((index() + 1) % Math.max(1, list.length));
    else if (e.key === "ArrowUp") setIndex((index() - 1 + list.length) % Math.max(1, list.length));
    else if (e.key === "Enter") {
      const c = list[index()];
      if (c) props.onPick(c.due);
    } else return;
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <div class="overlay" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div class="command-bar snooze" role="dialog" aria-label="Snooze">
        <div class="head">
          <span class="context">{props.count === 1 ? "Snooze" : `Snooze ${props.count}`}</span>
          <input
            ref={(el) => queueMicrotask(() => el.focus())}
            placeholder="Until when? tomorrow 9am, 3h, mon, dec 3"
            value={typed()}
            onInput={(e) => setTyped(e.currentTarget.value)}
            onKeyDown={onKeyDown}
          />
        </div>
        <ul>
          <For
            each={choices()}
            fallback={<li class="none">{typed().trim() ? "Not a time Tern can read, or it has passed" : ""}</li>}
          >
            {(c, i) => (
              <li
                classList={{ active: i() === index() }}
                onMouseEnter={() => setIndex(i())}
                onMouseDown={() => props.onPick(c.due)}
              >
                <span>{c.name}</span>
                <span class="when">{until(c.due)}</span>
              </li>
            )}
          </For>
        </ul>
        <Show when={!typed().trim()}>
          <p class="snooze-note">It comes back unread, or sooner if someone replies. Tern has to be running.</p>
        </Show>
      </div>
    </div>
  );
}
