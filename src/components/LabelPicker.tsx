import { createSignal, For, Show } from "solid-js";
import type { Folder } from "../api";
import { labelColour } from "../colours";

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
    const all = q ? props.labels : [...props.labels].sort((a, b) => a.name.localeCompare(b.name));
    return all.filter((l) => !q || l.name.toLowerCase().includes(q));
  };
  // Nested labels (Projects/Alpha) sit under their parent by their own name, as in the sidebar (idea 23). A parent
  // that is not a label itself shows as a heading. While typing, the whole path shows.
  const nest = (l: Folder) => {
    const at = l.name.lastIndexOf("/");
    if (typed().trim() || at < 0) return { name: l.name, depth: 0 };
    return { name: l.name.slice(at + 1), depth: l.name.split("/").length - 1 };
  };
  /** The parent path to show as a heading before `l`, when the label above is not in that parent. */
  const headBefore = (l: Folder, i: number) => {
    const at = l.name.lastIndexOf("/");
    if (typed().trim() || at < 0) return null;
    const parent = l.name.slice(0, at);
    const above = shown()[i - 1]?.name ?? "";
    return above === parent || above.startsWith(`${parent}/`) ? null : parent;
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
    // biome-ignore lint/a11y/noStaticElementInteractions: a click beside the dialog closes it, as Esc does
    <div class="overlay" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div class="command-bar snooze" role="dialog" aria-modal="true" aria-label="Labels">
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
              <>
              <Show when={headBefore(l, i())}>
                {(parent) => (
                  <li class="label-head" role="presentation" style={{ "padding-left": `${(parent().split("/").length - 1) * 18 + 10}px` }}>
                    {parent().slice(parent().lastIndexOf("/") + 1)}
                  </li>
                )}
              </Show>
              <li classList={{ active: i() === index() }} onMouseEnter={() => setIndex(i())} onMouseDown={() => pick(l)}>
                <span class="label-name" style={{ "padding-left": `${nest(l).depth * 18}px` }} title={l.name}>
                  <span class="label-dot" style={{ "--label": labelColour(l.name) }} />
                  {nest(l).name}
                </span>
                <Show when={has(l)}>
                  <span class="when">✓ Remove</span>
                </Show>
              </li>
              </>
            )}
          </For>
        </ul>
        <p class="snooze-note">Gmail gets the change after the undo window. New labels are made in Gmail.</p>
      </div>
    </div>
  );
}
