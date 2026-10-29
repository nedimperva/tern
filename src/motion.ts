// Motion that says where things went (ui.md §2, Motion). The list's rows close up on their own (`.vrow` eases its
// transform); these add the row that left, sliding the way it went, and a small pop for a star. Durations come from
// the tokens, so reduced motion (0 ms there) turns all of it off.

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
