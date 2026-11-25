// The filter chips over the Files and Paper trail screens: a chip says what is picked, opens a small panel to
// change it, and a set chip has its own ✕. Panels sit on the top layer, so the list's scrolling never clips them.

import { createSignal, For, type JSX, onCleanup, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { type DateRange, dayKey, monthGrid, PRESETS, type Preset, parseDay, rangeLabel } from "../dateRange";
import { Icon, type IconName } from "./Icon";

/** A chip's panel is open: the screen leaves Esc and the arrows to it. */
export const [chipOpen, setChipOpen] = createSignal(false);

export function Chip(props: {
  label: string;
  /** Something other than "all" is picked: the chip is blue and can be cleared. */
  set: boolean;
  onClear?: () => void;
  icon?: IconName;
  /** The panel; `close` puts it away (after a single choice). */
  children: (close: () => void) => JSX.Element;
}) {
  const [open, setOpen] = createSignal(false);
  const [place, setPlace] = createSignal({ left: 0, top: 0 });
  let button!: HTMLButtonElement;
  let panel: HTMLDivElement | undefined;
  const close = (refocus = true) => {
    if (!open()) return;
    setOpen(false);
    setChipOpen(false);
    window.removeEventListener("keydown", onKey, true);
    window.removeEventListener("pointerdown", onOutside, true);
    if (refocus) button.focus();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    close();
  };
  const onOutside = (e: PointerEvent) => {
    const t = e.target as Node;
    if (!panel?.contains(t) && !button.contains(t)) close(false);
  };
  const show = () => {
    const r = button.getBoundingClientRect();
    setPlace({ left: Math.max(8, Math.min(r.left, window.innerWidth - 500)), top: r.bottom + 6 });
    setOpen(true);
    setChipOpen(true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("pointerdown", onOutside, true);
    queueMicrotask(() => panel?.querySelector<HTMLElement>("input, button")?.focus());
  };
  onCleanup(() => close(false));
  return (
    <span class="chip-wrap">
      <button
        type="button"
        class="chip"
        classList={{ set: props.set, open: open() }}
        ref={button}
        aria-expanded={open()}
        aria-haspopup="dialog"
        onClick={() => (open() ? close() : show())}
      >
        <Show when={props.icon}>{(i) => <Icon name={i()} size={13} />}</Show>
        {props.label}
        <Show when={!(props.set && props.onClear)}>
          <Icon name="chevron-down" size={13} />
        </Show>
      </button>
      <Show when={props.set && props.onClear}>
        <button type="button" class="chip-x" aria-label={`Clear ${props.label}`} onClick={() => props.onClear?.()}>
          <Icon name="x" size={12} />
        </button>
      </Show>
      <Show when={open()}>
        <Portal>
          <div class="chip-pop" role="dialog" aria-label={props.label} ref={panel} style={{ left: `${place().left}px`, top: `${place().top}px` }}>
            {props.children(close)}
          </div>
        </Portal>
      </Show>
    </span>
  );
}

export type Tick = { value: string; label: string; count?: number };

/** Several of a list (people, kinds, currencies), with their counts; a search field once the list is long. */
export function Ticks(props: { items: Tick[]; picked: string[]; onChange: (picked: string[]) => void; find?: string; children?: JSX.Element }) {
  const [typed, setTyped] = createSignal("");
  const shown = () => {
    const w = typed().trim().toLowerCase();
    const all = w ? props.items.filter((i) => i.label.toLowerCase().includes(w)) : props.items;
    // The picked stay in view however long the list.
    return all.filter((i, n) => n < 40 || props.picked.includes(i.value));
  };
  const flip = (v: string) => props.onChange(props.picked.includes(v) ? props.picked.filter((p) => p !== v) : [...props.picked, v]);
  return (
    <div class="ticks">
      <Show when={props.find && props.items.length > 8}>
        <input class="ticks-find" placeholder={props.find} value={typed()} onInput={(e) => setTyped(e.currentTarget.value)} aria-label={props.find} />
      </Show>
      <div class="ticks-list">
        <For each={shown()} fallback={<p class="quiet">Nothing by that name.</p>}>
          {(i) => (
            <label class="tick">
              <input type="checkbox" checked={props.picked.includes(i.value)} onChange={() => flip(i.value)} />
              <span class="name">{i.label}</span>
              <Show when={i.count !== undefined}>
                <span class="count">{i.count}</span>
              </Show>
            </label>
          )}
        </For>
      </div>
      {props.children}
    </div>
  );
}

/** One of a few (received or sent, a size, an account). */
export function Choices(props: { items: { value: string; label: string }[]; value: string; onChange: (v: string) => void }) {
  return (
    <div class="choices">
      <For each={props.items}>
        {(i) => (
          <button type="button" aria-pressed={props.value === i.value} classList={{ on: props.value === i.value }} onClick={() => props.onChange(i.value)}>
            <span class="mark">
              <Show when={props.value === i.value}>
                <Icon name="check" size={13} />
              </Show>
            </span>
            {i.label}
          </button>
        )}
      </For>
    </div>
  );
}

const monthName = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" });
const dayName = new Intl.DateTimeFormat(undefined, { weekday: "narrow" });
const WEEK = Array.from({ length: 7 }, (_, i) => dayName.format(new Date(2026, 10, 16 + i)));

/** The mail-date panel: named spans on the left, a calendar to pick days on the right (first click the start,
 * second the end), and the weeks around the mail that is open, when one is. */
export function DatePanel(props: { value: DateRange; onChange: (r: DateRange) => void; presets: Preset[]; around?: number | null; close: () => void }) {
  const now = new Date();
  const first = props.value.kind === "days" ? parseDay(props.value.from) : now;
  const [shownMonth, setShownMonth] = createSignal(new Date(first.getFullYear(), first.getMonth(), 1));
  const [start, setStart] = createSignal<string | null>(null);
  const [hover, setHover] = createSignal<string | null>(null);
  const pick = (r: DateRange) => (props.onChange(r), props.close());
  const ends = (): [string, string] | null => {
    const s = start();
    if (s) return [s, hover() ?? s].sort() as [string, string];
    return props.value.kind === "days" ? ([props.value.from, props.value.to].sort() as [string, string]) : null;
  };
  const day = (d: Date) => {
    const k = dayKey(d);
    const s = start();
    if (!s) setStart(k);
    else pick({ kind: "days", from: s, to: k });
  };
  const move = (by: number) => setShownMonth(new Date(shownMonth().getFullYear(), shownMonth().getMonth() + by, 1));
  return (
    <div class="date-panel">
      <div class="date-presets">
        <For each={PRESETS.filter((p) => props.presets.includes(p.kind))}>
          {(p) => (
            <button type="button" classList={{ on: props.value.kind === p.kind }} onClick={() => pick({ kind: p.kind })}>
              {p.label}
            </button>
          )}
        </For>
        <Show when={props.around}>
          {(at) => (
            <button type="button" class="around" classList={{ on: props.value.kind === "around" }} onClick={() => pick({ kind: "around", at: at() })}>
              Around the open mail
              <span>Two weeks either side of {rangeLabel({ kind: "days", from: dayKey(new Date(at() * 1000)), to: dayKey(new Date(at() * 1000)) })}</span>
            </button>
          )}
        </Show>
      </div>
      <div class="calendar">
        <div class="cal-head">
          <button type="button" class="icon-button" onClick={() => move(-1)} aria-label="Month before">
            <Icon name="chevron-left" size={15} />
          </button>
          <strong>{monthName.format(shownMonth())}</strong>
          <button type="button" class="icon-button" onClick={() => move(1)} aria-label="Month after" disabled={shownMonth() > now}>
            <Icon name="chevron-right" size={15} />
          </button>
        </div>
        <div class="cal-grid">
          <For each={WEEK}>{(w) => <span class="wd">{w}</span>}</For>
          <For each={monthGrid(shownMonth().getFullYear(), shownMonth().getMonth()).flat()}>
            {(d) =>
              d ? (
                <button
                  type="button"
                  classList={{
                    today: dayKey(d) === dayKey(now),
                    in: !!ends() && dayKey(d) >= ends()![0] && dayKey(d) <= ends()![1],
                    end: !!ends() && (dayKey(d) === ends()![0] || dayKey(d) === ends()![1]),
                  }}
                  onMouseEnter={() => setHover(dayKey(d))}
                  onClick={() => day(d)}
                >
                  {d.getDate()}
                </button>
              ) : (
                <span />
              )
            }
          </For>
        </div>
        <p class="quiet">{start() ? "Now the last day." : "Pick the first day, then the last."}</p>
      </div>
    </div>
  );
}
