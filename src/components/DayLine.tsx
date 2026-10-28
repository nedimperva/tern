import { Show } from "solid-js";
import { hideLineToday, start, whenSaid } from "../day";
import { Icon } from "./Icon";

/** "Morning", "Afternoon" or "Evening", by the clock. */
export const greeting = () => {
  const h = new Date().getHours();
  return h < 12 ? "Morning" : h < 18 ? "Afternoon" : "Evening";
};

/** The one quiet line above the inbox (docs/design/ui.md §4.7a): what came in since the person was last here, and
 * pills for what needs them, each with its key. Hidden for the day with ×. */
export function DayLine(props: {
  name: string;
  onRun: (which: "need" | "back" | "waiting") => void;
  onRest: () => void;
}) {
  const s = () => start()!;
  return (
    <section class="day-line" aria-label="Since you were last here">
      <strong>
        {greeting()}
        {props.name ? `, ${props.name}` : ""}.
      </strong>
      <span class="since">
        {s().newSince} new since {whenSaid(s().since)}
        {s().needYou.length || s().back.length || s().waiting.length || s().rest ? ":" : "."}
      </span>
      <Show when={s().needYou.length}>
        <button class="pill strong" onClick={() => props.onRun("need")} title="Go through them one at a time (1)">
          <b>{s().needYou.length}</b> need you <kbd>1</kbd>
        </button>
      </Show>
      <Show when={s().back.length}>
        <button class="pill" onClick={() => props.onRun("back")} title="Back from snooze (2)">
          <b>{s().back.length}</b> back from snooze <kbd>2</kbd>
        </button>
      </Show>
      <Show when={s().waiting.length}>
        <button class="pill" onClick={() => props.onRun("waiting")} title="No answer yet (3)">
          <b>{s().waiting.length}</b> no answer yet <kbd>3</kbd>
        </button>
      </Show>
      <Show when={s().rest}>
        <button class="pill" onClick={props.onRest} title="Updates and lists, in Other (4)">
          <b>{s().rest}</b> the rest <kbd>4</kbd>
        </button>
      </Show>
      <span class="spacer" />
      <button class="close" aria-label="Hide until tomorrow" title="Hide until tomorrow" onClick={hideLineToday}>
        <Icon name="x" size={14} />
      </button>
    </section>
  );
}
