// The start of the day as the list sees it (src/day.ts holds the counts): the line above the inbox and the
// one-at-a-time run through what needs the person.

import { api } from "../api";
import { closeScreen, deck, lineShown, refreshStart, setDeck, start } from "../day";
import { act } from "./actions";
import { load } from "./list";
import { keyOf } from "./rows";
import { accounts, role, searching } from "./state";

/** The first name of the person, from the first account's name, for "Morning, Ada". */
export const firstName = () => (accounts()[0]?.displayName ?? "").trim().split(/\s+/)[0] ?? "";

/** The conversations a run goes through: one group from the line, or everything that waits, from the screen. */
export const deckRows = () => {
  const s = start();
  if (!s) return [];
  const which = deck();
  const all = which === "need" ? s.needYou : which === "back" ? s.back : which === "waiting" ? s.waiting : [...s.needYou, ...s.back, ...s.waiting];
  const seen = new Set<string>();
  return all.filter((r) => !seen.has(keyOf(r)) && !!seen.add(keyOf(r)));
};

export const runDeck = (which: "need" | "back" | "waiting" | "all") => {
  closeScreen();
  setDeck(which);
};

export const closeDeck = () => {
  setDeck(null);
  void refreshStart();
  void load();
};

/** The updates that came in since the person was last here, all done at once (undo brings them back). */
export async function doneUpdates() {
  const s = start();
  if (!s) return;
  const rows = (await api.listThreads({ role: "bulk" }, null, 500)).filter((r) => r.date > s.since);
  if (rows.length) await act("archive", rows);
  void refreshStart();
}

/** The line above the inbox shows on the inbox and its Important split, not while searching. */
export const lineHere = () => lineShown() && !searching() && ["inbox", "important"].includes(role());
