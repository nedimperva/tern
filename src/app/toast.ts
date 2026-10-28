// The status strip's note and its Undo (z). Every change gets five seconds to be taken back.

import { createSignal } from "solid-js";
import { api } from "../api";
import { load } from "./list";

export const UNDO_MS = 5000;

/** The status strip's note. `after` runs when its change is undone (unmute after undoing a mute); `undo` takes
 * back something that is not queued work (a discarded draft). `until` is when its undo window ends. */
export type Toast = { text: string; token: number[]; after?: () => unknown; undo?: () => unknown; until: number };

export const [toast, setToast] = createSignal<Toast | null>(null);

let toastTimer: number | undefined;
// Every change still in its undo window, newest last: z takes back the newest, then the one before it, so a
// second action within five seconds no longer costs the first its undo.
let undoable: Toast[] = [];
const stillUndoable = () => (undoable = undoable.filter((t) => t.until > Date.now()));

export function showToast(text: string, token: number[], after?: () => unknown, undoAction?: () => unknown, ms = UNDO_MS) {
  const t = { text, token, after, undo: undoAction, until: Date.now() + ms };
  if (token.length || undoAction) undoable = [...stillUndoable(), t];
  putToast(t);
}

function putToast(t: Toast | null) {
  clearTimeout(toastTimer);
  setToast(t);
  if (t) toastTimer = window.setTimeout(() => setToast(null), Math.max(0, t.until - Date.now()));
}

export async function undo() {
  const t = stillUndoable().pop();
  // The one before it shows again, with what is left of its window.
  putToast(undoable.at(-1) ?? null);
  if (!t) return;
  if (t.undo) {
    await t.undo();
    return;
  }
  const undone = await api.undo(t.token);
  if (!undone) showToast("Too late to undo", []);
  else await t.after?.();
  void load();
}
