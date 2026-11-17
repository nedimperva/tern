// Motion that says where things went (ui.md §2, Motion). The list's rows close up on their own (`.vrow` eases its
// transform); these add the row that left, sliding the way it went, a small pop for a star, the panes moving
// between the list and a mail, and a thread's messages making room. Durations come from the tokens, so reduced
// motion (0 ms there) turns all of it off.

import { keyOf } from "./app/rows";
import type { ThreadRow } from "./api";

/** Which way a row leaves: Done to the right, Trash to the left, snoozed or shelved up out of the way. */
export type Way = "right" | "left" | "up" | "fade";

const OFF: Record<Way, string> = {
  right: "translateX(48px)",
  left: "translateX(-48px)",
  up: "translateY(-10px) scale(0.98)",
  fade: "scale(0.99)",
};
const EASE = "cubic-bezier(0.2, 0.8, 0.2, 1)";

/** The element id of a row in the list. */
export const rowId = (row: ThreadRow) => `crow-${keyOf(row).replace(/[^\w-]/g, "_")}`;

function ms(token: "--d-base" | "--d-slow") {
  return Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue(token)) || 0;
}

/** The colour the list is drawn on, so a leaving row hides the one sliding in under it rather than mixing text. */
function ground(el: HTMLElement) {
  for (let at: HTMLElement | null = el; at; at = at.parentElement) {
    const bg = getComputedStyle(at).backgroundColor;
    if (bg && bg !== "transparent" && !bg.endsWith(", 0)")) return bg;
  }
  return "";
}

/** Leaves a copy of each row, still drawn, sliding away while the real ones close up under it. Call before the
 * rows are taken off the list. */
export function leave(hit: ThreadRow[], way: Way) {
  const duration = ms("--d-slow");
  if (!duration) return;
  for (const row of hit) {
    const slot = document.getElementById(rowId(row))?.closest<HTMLElement>(".vrow");
    if (!slot?.parentElement) continue;
    const ghost = slot.cloneNode(true) as HTMLElement;
    for (const el of [ghost, ...ghost.querySelectorAll("[id]")]) el.removeAttribute("id");
    ghost.classList.add("vrow-ghost");
    ghost.style.background = ground(slot.parentElement);
    ghost.setAttribute("aria-hidden", "true");
    slot.parentElement.append(ghost);
    const at = ghost.style.transform;
    ghost
      .animate([{ transform: at, opacity: 1 }, { transform: `${at} ${OFF[way]}`, opacity: 0 }], { duration, easing: EASE })
      .finished.finally(() => ghost.remove());
  }
}

/** A star that was just put on grows for a moment. */
export function pop(hit: ThreadRow[]) {
  const duration = ms("--d-slow");
  if (!duration) return;
  // On the next frame: the row is drawn again with its star.
  requestAnimationFrame(() => {
    for (const row of hit) {
      document
        .getElementById(rowId(row))
        ?.querySelector(".star")
        ?.animate([{ transform: "scale(1)" }, { transform: "scale(1.45)" }, { transform: "scale(1)" }], { duration, easing: EASE });
    }
  });
}

// MARK: Between screens (ideas 82–86)

/** What changes between two screens, which says how the panes move: the open mail comes in from the right and goes
 * back out to it, another mail fades in its place, a mail that was acted on leaves the way its row does, and the
 * companion slides in at the edge. */
export type Shift = "open" | "close" | "switch" | "gone-right" | "gone-left" | "gone-up" | "side";

type Transition = { finished: Promise<void> };
type WithTransitions = Document & { startViewTransition?: (update: () => unknown) => Transition };

let running: Transition | null = null;
let lastShift = 0;
/** A key held down repeats faster than this: those steps change the screen at once, with no motion. */
const HELD_MS = 180;

/** Makes a change between screens with the webview's view transitions (`styles.css`, "Between screens"). Where the
 * webview has none, with reduced motion, while one is running or when the key is held, the change just happens. */
export function shift(kind: Shift, change: () => unknown) {
  const doc = document as WithTransitions;
  const now = performance.now();
  const held = now - lastShift < HELD_MS;
  lastShift = now;
  if (!doc.startViewTransition || running || held || !ms("--d-base")) {
    void change();
    return;
  }
  const root = document.documentElement;
  root.dataset.shift = kind;
  const t = doc.startViewTransition(change);
  running = t;
  const done = () => {
    if (running !== t) return;
    running = null;
    delete root.dataset.shift;
  };
  t.finished.then(done, done);
}

/** The webview holds the old screen until the new one is drawn: a mail that takes longer than this to come out of
 * the store moves in anyway, and fills in where it stands. */
export const settle = <T>(work: Promise<T>) => Promise.race([work, new Promise((r) => setTimeout(r, 120))]);

/** A message opened or closed in a thread: what is below it glides down or up instead of jumping (idea 85). The
 * rows are measured before and after the change, and each one that moved starts where it was. */
export function glide(change: () => void) {
  const duration = ms("--d-base");
  const thread = document.querySelector(".conversation .history");
  if (!duration || !thread) return change();
  const items = [...thread.children] as HTMLElement[];
  const before = new Map(items.map((el) => [el, el.getBoundingClientRect().top]));
  change();
  for (const el of items) {
    if (!el.isConnected) continue;
    const by = (before.get(el) ?? 0) - el.getBoundingClientRect().top;
    if (Math.abs(by) > 1) el.animate([{ transform: `translateY(${by}px)` }, { transform: "none" }], { duration, easing: EASE });
  }
}
