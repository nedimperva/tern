import { createSignal, For, Show } from "solid-js";
import type { Folder } from "../api";

/** `l`: Gmail labels for the conversations in hand. Type to narrow; Enter puts the label on, or takes it off when
 * every one of them already has it. */
export function LabelPicker(props: {
  labels: Folder[];
  /** Labels every conversation in hand already has. */
  applied: string[];
  count: number;
  onPick: (label: Folder, add: boolean) => void;
  onClose: () => void;
}) {
  const [typed, setTyped] = createSignal("");
  const [index, setIndex] = createSignal(0);
  const shown = () => {
    const q = typed().trim().toLowerCase();
    return props.labels.filter((l) => !q || l.name.toLowerCase().includes(q));
  };
  const has = (l: Folder) => props.applied.includes(l.name);
  const pick = (l: Folder | undefined) => l && props.onPick(l, !has(l));

  const onKeyDown = (e: KeyboardEvent) => {
    const list = shown();
    if (e.key === "Escape") props.onClose();
    else if (e.key === "ArrowDown") setIndex((index() + 1) % Math.max(1, list.length));
    else if (e.key === "ArrowUp") setIndex((index() - 1 + list.length) % Math.max(1, list.length));
    else if (e.key === "Enter") pick(list[index()]);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <div class="overlay" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div class="command-bar snooze" role="dialog" aria-label="Labels">
        <div class="head">
          <span class="context">{props.count === 1 ? "Label" : `Label ${props.count}`}</span>
          <input
            ref={(el) => queueMicrotask(() => el.focus())}
            placeholder="Which label?"
            value={typed()}
            onInput={(e) => (setTyped(e.currentTarget.value), setIndex(0))}
            onKeyDown={onKeyDown}
          />
        </div>
        <ul>
          <For each={shown()} fallback={<li class="none">No label by that name</li>}>
            {(l, i) => (
              <li classList={{ active: i() === index() }} onMouseEnter={() => setIndex(i())} onMouseDown={() => pick(l)}>
                <span>{l.name}</span>
                <Show when={has(l)}>
                  <span class="when">✓ Remove</span>
                </Show>
              </li>
            )}
          </For>
        </ul>
        <p class="snooze-note">Gmail gets the change after the undo window. New labels are made in Gmail.</p>
      </div>
    </div>
  );
}
