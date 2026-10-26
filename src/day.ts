// The start of the day (docs/design/ui.md §4.7a): the morning screen on the first open of a day, the one quiet
// line above the inbox, and the one-at-a-time run through what needs the person. All counted on this computer
// (`day_start`), since the person was last here.

import { createRoot, createSignal } from "solid-js";
import { api, type DayStart } from "./api";
import { setSetting, settings } from "./settings";

/** A local day as "2026-10-26": the morning screen shows once each. */
export const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

const now = () => Math.floor(Date.now() / 1000);

const [start, setStart] = createSignal<DayStart | null>(null);
/** What came in since the person was last here and what needs them; null until read. */
export { start };
const [screen, setScreen] = createSignal(false);
/** The morning screen is up. */
export { screen };
/** The run through what needs the person, one at a time, when it is on. */
export const [deck, setDeck] = createSignal<"need" | "back" | "waiting" | "all" | null>(null);

// When the person was last here, as this visit started. The line above the inbox counts from it all day.
let since = 0;

/** Reads the counts again (mail came in, something was done). */
export async function refreshStart() {
  if (!since) return;
  try {
    setStart(await api.dayStart(since));
  } catch {
    // Nothing to show is fine: the line and the screen just stay away.
  }
}

/** Something waits on the person: worth a line, or a screen. */
export const anything = (s: DayStart | null) => !!s && (s.needYou.length + s.back.length + s.waiting.length > 0 || s.rest > 0);

/** A visit starts: on opening Tern, and when its window comes back after the day changed. */
async function begin() {
  since = settings.lastSeen || now() - 12 * 3600;
  await refreshStart();
  const s = start();
  const waits = !!s && s.needYou.length + s.back.length + s.waiting.length > 0;
  if (settings.dayStart === "screen" && settings.dayShown !== today() && waits) {
    setScreen(true);
    setSetting("dayShown", today());
  }
}

/** The morning screen goes; the inbox, with its line, stays. */
export const closeScreen = () => setScreen(false);

/** The line above the inbox is put away until tomorrow. */
export const hideLineToday = () => setSetting("lineHidden", today());
export const lineShown = () => settings.dayStart !== "off" && settings.lineHidden !== today() && anything(start());

/** Call once settings are loaded. Keeps "last here" up to date while the window shows, so the next visit counts
 * from when the person left. */
export function startDay() {
  createRoot(() => {
    void begin().then(() => setSetting("lastSeen", now()));
    let away = document.visibilityState === "hidden";
    const seen = () => document.visibilityState === "visible" && setSetting("lastSeen", now());
    setInterval(seen, 5 * 60_000);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") {
        setSetting("lastSeen", now());
        away = true;
      } else if (away) {
        away = false;
        // Back on another day: a new start, counted from when the window went away.
        if (settings.dayShown !== today()) void begin();
        else void refreshStart();
      }
    });
  });
}

/** When a time was, said short: "18:40", "18:40 yesterday", "Monday". */
export function whenSaid(seconds: number): string {
  const then = new Date(seconds * 1000);
  const time = then.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const days = Math.round((new Date().setHours(0, 0, 0, 0) - new Date(then).setHours(0, 0, 0, 0)) / 86_400_000);
  if (days <= 0) return time;
  if (days === 1) return `${time} yesterday`;
  if (days < 7) return then.toLocaleDateString(undefined, { weekday: "long" });
  return then.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

/** Since when a message waits, said short: "Tuesday", "yesterday", "07:52". */
export function waitingSince(seconds: number): string {
  const then = new Date(seconds * 1000);
  const days = Math.round((new Date().setHours(0, 0, 0, 0) - new Date(then).setHours(0, 0, 0, 0)) / 86_400_000);
  if (days <= 0) return then.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  if (days === 1) return "yesterday";
  if (days < 7) return then.toLocaleDateString(undefined, { weekday: "long" });
  return then.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}
