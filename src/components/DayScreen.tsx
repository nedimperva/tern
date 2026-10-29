import { For, onCleanup, onMount, Show } from "solid-js";
import type { ThreadRow } from "../api";
import { closeScreen, start, waitingSince } from "../day";
import { typing } from "../keys";

const sender = (t: ThreadRow) => t.fromName || t.fromAddr;

/** The tide (docs/design/ui.md §4.7a): the first open of a day when something waits on the person. A sky that
 * follows the hour, then what needs them, what waits on others, what came back and what there is to read, all
 * from the store on this computer. Enter starts with the first, Esc goes to the inbox. */
export function DayScreen(props: {
  name: string;
  /** Start the run through what needs the person (Enter). */
  onStart: () => void;
  /** Done all the updates that came in (Shift+E). */
  onDoneUpdates: () => void;
  /** Open one conversation from the screen. */
  onOpen: (row: ThreadRow) => void;
  /** Something else (compose, a picker) has the keys. */
  paused: () => boolean;
}) {
  const s = () => start()!;
  const first = () => s().needYou[0] ?? s().back[0] ?? s().waiting[0];
  const hour = new Date().getHours();
  const night = hour >= 19 || hour < 6;
  const greeting = () => {
    const when = hour < 12 && hour >= 5 ? "Good morning" : hour < 18 && hour >= 12 ? "Good afternoon" : "Good evening";
    const n = s().needYou.length;
    const tide = n > 6 ? "A busy tide today." : n > 2 ? "A steady tide today." : "A calm tide today.";
    return `${when}${props.name ? `, ${props.name}` : ""}. ${tide}`;
  };
  const kicker = () =>
    `${new Date().toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" })} · ${new Date().toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`;
  const startLabel = () => {
    const f = first();
    return f ? `Start with ${sender(f).split(" ")[0]}` : "Start";
  };
  const overnight = () => {
    const parts = [`${s().newSince} came in since you were here`];
    if (s().rest) parts.push(`${s().rest} went to Other`);
    return parts.join(" · ");
  };
  const readingTime = () => s().toRead.reduce((sum, r) => sum + (r.minutes ?? 0), 0);

  const onKey = (e: KeyboardEvent) => {
    if (props.paused() || typing(e)) return;
    if (e.key === "Escape") closeScreen();
    else if (e.key === "Enter" && !(e.target instanceof HTMLButtonElement)) props.onStart();
    else if (e.key === "E" && e.shiftKey && s().rest) props.onDoneUpdates();
    else return;
    e.preventDefault();
    e.stopPropagation();
  };
  onMount(() => window.addEventListener("keydown", onKey, true));
  onCleanup(() => window.removeEventListener("keydown", onKey, true));

  const Card = (c: { row: ThreadRow; when: string; urgent?: boolean; line?: string }) => (
    <button type="button" class="tide-card" onClick={() => props.onOpen(c.row)}>
      <span class="who">
        <strong>{sender(c.row)}</strong>
        <span class="when" classList={{ urgent: c.urgent }}>
          {c.when}
        </span>
      </span>
      <span class="what">{c.line ?? (c.row.subject || "(no subject)")}</span>
    </button>
  );

  return (
    <div class="tide zero" role="dialog" aria-label="Your day">
      <div class="tide-sky" classList={{ "after-dark": night }}>
        <svg viewBox="0 0 1280 220" preserveAspectRatio="xMidYMax slice" aria-hidden="true">
          <circle class="orb" cx="1060" cy={night ? 80 : 96} r={night ? 34 : 44} />
          <path class="sea" d="M0 170 C 260 160 520 182 780 170 S 1140 158 1280 168 L1280 220 L0 220 Z" />
          <path class="tern" d="M860 70 l64 -24 l-28 32 l76 -9 l-86 28 z" />
          <path class="tern small" d="M960 116 l34 -12 l-14 16 l40 -4 l-46 14 z" />
        </svg>
        <header>
          <span class="spacer" />
          <button type="button" class="link" onClick={closeScreen}>
            Go to the inbox <kbd>Esc</kbd>
          </button>
        </header>
        <div class="tide-words">
          <span class="kicker">{kicker()}</span>
          <h1>{greeting()}</h1>
        </div>
      </div>

      <div class="tide-columns">
        <section aria-labelledby="tide-need">
          <h2 id="tide-need">
            Needs you <span class="count urgent">{s().needYou.length || ""}</span>
          </h2>
          <For each={s().needYou.slice(0, 5)} fallback={<p class="tide-empty">Nothing waits on you.</p>}>
            {(t) => <Card row={t} when={waitingSince(t.date)} urgent={Date.now() / 1000 - t.date > 2 * 86_400} line={t.snippet || t.subject} />}
          </For>
          <Show when={s().needYou.length > 5}>
            <button type="button" class="link tide-more" onClick={props.onStart}>
              and {s().needYou.length - 5} more
            </button>
          </Show>
        </section>

        <section aria-labelledby="tide-waiting">
          <h2 id="tide-waiting">
            Waiting on others <span class="count">{s().waiting.length || ""}</span>
          </h2>
          <For each={s().waiting.slice(0, 4)} fallback={<p class="tide-empty">Nobody owes you an answer.</p>}>
            {(t) => <Card row={t} when={waitingSince(t.date)} line={`You wrote: ${t.subject || "(no subject)"}`} />}
          </For>
          <Show when={s().back.length}>
            <h2 class="tide-sub">Came back today</h2>
            <For each={s().back.slice(0, 3)}>{(t) => <Card row={t} when="back from snooze" />}</For>
          </Show>
        </section>

        <section aria-labelledby="tide-read">
          <h2 id="tide-read">
            To read, when there's time <span class="count">{readingTime() ? `· ${readingTime()} min` : ""}</span>
          </h2>
          <div class="tide-reads">
            <For each={s().toRead} fallback={<p class="tide-empty">Nothing on the shelf.</p>}>
              {(r) => (
                <button type="button" class="tide-read" onClick={() => props.onOpen(r)}>
                  <span class="title">{r.subject || "(no subject)"}</span>
                  <span class="meta">
                    {sender(r)}
                    {r.minutes ? ` · ${r.minutes} min` : ""}
                  </span>
                </button>
              )}
            </For>
          </div>
        </section>
      </div>

      <footer class="tide-foot">
        <span>{overnight()}</span>
        <span class="spacer" />
        <span class="quiet">Made on this computer from your mail.</span>
        <Show when={s().rest}>
          <button type="button" onClick={props.onDoneUpdates}>
            Done all {s().rest} updates <kbd>Shift E</kbd>
          </button>
        </Show>
        <button type="button" class="primary" onClick={props.onStart}>
          {startLabel()} <kbd>Enter</kbd>
        </button>
      </footer>
    </div>
  );
}
