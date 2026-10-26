import { For, onCleanup, onMount, Show } from "solid-js";
import { closeScreen, start, waitingSince } from "../day";
import { typing } from "../keys";

const WORDS = ["No", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten"];
const counted = (n: number, one: string, many: string) => `${n <= 10 ? WORDS[n] : n} ${n === 1 ? one : many}`;

/** The morning screen (docs/design/ui.md §4.7a), on the first open of a day when something waits on the person:
 * one sentence on what does, one on the rest, and a way to start with the first. Esc goes to the inbox. */
export function DayScreen(props: {
  name: string;
  /** Start the run through what needs the person (Enter). */
  onStart: () => void;
  /** Done all the updates that came in (Shift+E). */
  onDoneUpdates: () => void;
  /** Something else (compose, a picker) has the keys. */
  paused: () => boolean;
}) {
  const s = () => start()!;
  const first = () => s().needYou[0] ?? s().back[0] ?? s().waiting[0];
  const headline = () => {
    const n = s().needYou.length;
    if (!n) return s().back.length ? "Snoozed mail is back." : "A follow-up has no answer yet.";
    const oldest = s().needYou[0];
    return `${counted(n, "conversation waits", "conversations wait")} on you. The first since ${waitingSince(oldest.date)}.`;
  };
  const more = () => {
    const parts: string[] = [];
    if (s().back.length) parts.push(`${counted(s().back.length, "snoozed conversation", "snoozed conversations").toLowerCase()} came back`);
    if (s().waiting.length) parts.push(`${counted(s().waiting.length, "message", "messages").toLowerCase()} of yours ${s().waiting.length === 1 ? "has" : "have"} no answer yet`);
    const lead = parts.length ? `${parts.join(", and ").replace(/^./, (c) => c.toUpperCase())}.` : "";
    const rest = s().rest ? ` The other ${s().rest} new ${s().rest === 1 ? "is an update" : "are updates and lists"}.` : "";
    return (lead + rest).trim();
  };
  const startLabel = () => {
    const f = first();
    if (!f) return "Start";
    const who = f.fromName || f.fromAddr;
    const subject = f.subject.length > 32 ? `${f.subject.slice(0, 30)}…` : f.subject;
    return `Start with ${who.split(" ")[0]}: ${subject || "(no subject)"}`;
  };
  const day = () => new Date().toLocaleDateString(undefined, { weekday: "long" });
  const time = () => new Date().toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

  const onKey = (e: KeyboardEvent) => {
    if (props.paused() || typing(e)) return;
    if (e.key === "Escape") closeScreen();
    else if (e.key === "Enter") props.onStart();
    else if (e.key === "E" && e.shiftKey && s().rest) props.onDoneUpdates();
    else return;
    e.preventDefault();
    e.stopPropagation();
  };
  onMount(() => window.addEventListener("keydown", onKey, true));
  onCleanup(() => window.removeEventListener("keydown", onKey, true));

  return (
    <div class="day-screen zero" role="dialog" aria-label="Your morning">
      <svg class="day-land" viewBox="0 0 1280 800" preserveAspectRatio="xMidYMax slice" aria-hidden="true">
        <path d="M0 560 C 260 520 420 600 700 560 S 1100 500 1280 540 L1280 800 L0 800 Z" />
        <path d="M0 640 C 300 610 520 680 820 640 S 1150 600 1280 630 L1280 800 L0 800 Z" />
        <path class="bird" d="M930 250 l60 -22 l-26 30 l70 -8 l-80 26 z" />
        <path class="bird small" d="M1040 300 l34 -12 l-14 16 l40 -4 l-46 14 z" />
      </svg>
      <header>
        <span class="spacer" />
        <button class="link" onClick={closeScreen}>
          Go to the inbox <kbd>Esc</kbd>
        </button>
      </header>
      <div class="day-words">
        <span class="kicker">
          {day()} · {time()}
        </span>
        <h1>{headline()}</h1>
        <Show when={more()}>
          <p>{more()}</p>
        </Show>
        <div class="day-actions">
          <button class="primary" onClick={props.onStart}>
            {startLabel()} <kbd>Enter</kbd>
          </button>
          <Show when={s().rest}>
            <button onClick={props.onDoneUpdates}>
              Done all {s().rest} updates <kbd>Shift E</kbd>
            </button>
          </Show>
        </div>
        <span class="hint">Enter opens them one after another, longest waiting first; E or a reply moves to the next.</span>
      </div>
      <div class="day-people">
        <For each={[...s().needYou, ...s().back].slice(0, 6)}>
          {(t) => (
            <span>
              {(t.fromName || t.fromAddr).split(" ")[0]} · {waitingSince(t.date)}
            </span>
          )}
        </For>
      </div>
    </div>
  );
}
