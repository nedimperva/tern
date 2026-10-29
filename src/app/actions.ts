// What the keys do to conversations: done, trash, star, read, snooze, the shelf, splits, labels and mute. Each
// shows at once, then goes to the engine, and can be undone.

import { batch } from "solid-js";
import { api, moves, type Action, type Applied, type Folder, type ThreadRow } from "../api";
import { leave, pop, type Way } from "../motion";
import { ROLE_NAMES } from "../components/Rail";
import { until } from "../components/ConversationRow";
import { countCleared } from "../zero";
import { keyOf } from "./rows";
import { open } from "./conversation";
import { go, load, refresh } from "./list";
import {
  accounts,
  current,
  focus,
  folders,
  openRow,
  role,
  rows,
  searching,
  selection,
  setFocus,
  setLabeling,
  setRows,
  setSelection,
  setSnoozing,
  snoozing,
  target,
} from "./state";
import { showToast } from "./toast";

const DONE: Record<Exclude<Action, object>, string> = {
  archive: "Archived",
  trash: "Moved to Trash",
  junk: "Marked as spam",
  inbox: "Moved to Inbox",
  markRead: "Marked read",
  markUnread: "Marked unread",
  star: "Starred",
  unstar: "Unstarred",
};

export const folderName = (f: Folder | undefined) => (f ? ROLE_NAMES[f.role] ?? f.name : "folder");
export const accountOf = (id: number) => accounts().find((a) => a.id === id)?.email ?? "";

/** What an action applies to: the selection if there is one, else the open conversation or the focused row. */
export function targets(): ThreadRow[] {
  const chosen = selection();
  if (chosen.size) return rows().filter((r) => chosen.has(keyOf(r)));
  const one = openRow() ?? current();
  return one ? [one] : [];
}

/** Takes conversations off the list at once (they moved away); focus goes to the row that takes their place. They
 * leave the way they went (motion.ts). */
function dropRows(hit: ThreadRow[], way: Way = "fade") {
  leave(hit, way);
  const keys = new Set(hit.map(keyOf));
  const first = rows().findIndex((r) => keys.has(keyOf(r)));
  const left = rows().filter((r) => !keys.has(keyOf(r)));
  const wasOpen = openRow() && keys.has(keyOf(openRow()!));
  const next = Math.min(first < 0 ? focus() : first, Math.max(0, left.length - 1));
  batch(() => {
    setRows(left);
    setFocus(next);
    setSelection(new Set<string>());
  });
  if (wasOpen) void open(left[next]);
}

// What snoozing from the one-at-a-time run does once a time is picked: that card leaves the run.
let afterSnooze: (() => void) | null = null;
export const snoozeThen = (then: (() => void) | null) => (afterSnooze = then);

/** Snoozes the conversations the picker was opened for. Snoozing is Tern's alone, so Undo is immediate. */
export async function snoozeUntil(due: number) {
  const hit = snoozing() ?? [];
  setSnoozing(null);
  if (!hit.length) return;
  afterSnooze?.();
  afterSnooze = null;
  const ids = hit.map((r) => r.id);
  const snoozedView = role() === "snoozed";
  if (!snoozedView) dropRows(hit, "up");
  try {
    await api.snooze(ids, due);
  } catch (e) {
    showToast(String(e), []);
  }
  if (snoozedView) void load();
  const what = hit.length === 1 ? "Snoozed" : `Snoozed ${hit.length} conversations`;
  showToast(`${what} until ${until(due)}`, [], undefined, async () => {
    await api.unsnooze(ids);
    void load();
  });
}

export const onShelf = () => role() === "later";
/** Puts the target conversations on the Read later shelf (Shift+L), or, on the shelf, back in the inbox. */
export async function shelve(hit = targets()) {
  if (!hit.length) return;
  const ids = hit.map((r) => r.id);
  const on = !onShelf();
  dropRows(hit, "up");
  try {
    await api.readLater(ids, on);
  } catch (e) {
    return showToast(String(e), []);
  }
  const said = hit.length === 1 ? (on ? "On the Read later shelf" : "Back in the inbox") : `${hit.length} conversations ${on ? "on the Read later shelf" : "back in the inbox"}`;
  showToast(said, [], undefined, async () => {
    await api.readLater(ids, !on);
    void load();
  });
}

/** Brings snoozed conversations back now (Shift+H). */
export async function wake() {
  const hit = targets().filter((r) => r.snoozedUntil != null);
  if (!hit.length) return;
  if (role() === "snoozed") dropRows(hit);
  await api.unsnooze(hit.map((r) => r.id));
  showToast(hit.length === 1 ? "Back in the inbox" : `${hit.length} conversations back in the inbox`, []);
  void load();
}

/** Moves the senders of the target conversations to Other (or Important); their later mail follows. */
export async function moveToSplit(other: boolean) {
  const hit = targets();
  if (!hit.length) return;
  const ids = hit.map((r) => r.id);
  const shown = role();
  if ((other && shown === "important") || (!other && shown === "bulk")) dropRows(hit);
  await api.setSplit(ids, other);
  const senders = [...new Set(hit.map((r) => r.fromName || r.fromAddr))];
  const who = senders.length === 1 ? senders[0] : `${senders.length} senders`;
  showToast(`${who}: ${other ? "Other" : "Important"} from now on`, [], undefined, async () => {
    await api.setSplit(ids, !other);
    void load();
  });
}

/** Shows the change at once, then tells the engine. Every action can be undone for five seconds. */
/** Returns the undo token, empty if nothing was done. */
export async function act(action: Action, hit = targets(), announce = true): Promise<number[]> {
  if (!hit.length) return [];
  const keys = new Set(hit.map(keyOf));
  if (moves(action)) {
    dropRows(hit, action === "archive" ? "right" : action === "trash" || action === "junk" ? "left" : "fade");
    // Done or moved away from the shelf: off it, so it does not hide again if it comes back to the inbox.
    if (onShelf()) void api.readLater(hit.map((r) => r.id), false);
  } else {
    const patch = (r: ThreadRow): ThreadRow =>
      action === "markRead"
        ? { ...r, unread: 0, seen: true }
        : action === "markUnread"
          ? { ...r, unread: Math.max(1, r.unread), seen: false }
          : { ...r, flagged: action === "star" };
    setRows(rows().map((r) => (keys.has(keyOf(r)) ? patch(r) : r)));
    if (action === "star") pop(hit);
  }
  try {
    let token: number[] = [];
    let drafts: number[] = [];
    const take = (applied: Applied) => ((token = token.concat(applied.token)), (drafts = drafts.concat(applied.drafts)));
    if (searching()) {
      // Search spans folders: each hit is acted on where it is.
      for (const r of hit) take(await api.applyConversations([r.id], action, { folder: r.folderId }));
    } else {
      take(await api.applyConversations(hit.map((r) => r.id), action, target()));
    }
    const done =
      typeof action === "object"
        ? `Moved to ${folderName(folders().find((f) => f.id === action.moveTo))}`
        : DONE[action];
    // Deleted drafts were discarded, not queued: undo brings them back alongside the queued work.
    const undoDrafts = drafts.length
      ? async () => {
          if (token.length) await api.undo(token);
          for (const id of drafts) await api.undoDiscard(id);
          void load();
        }
      : undefined;
    // What leaves the inbox counts for Inbox Zero's Flock and Your migration; an undo takes it off again.
    const cleared = !searching() && moves(action) && action !== "inbox" && ["inbox", "important", "bulk"].includes(role()) ? hit.length : 0;
    countCleared(cleared);
    const uncount = cleared ? () => countCleared(-cleared) : undefined;
    if (announce) showToast(hit.length === 1 ? done : `${done} (${hit.length} conversations)`, token, uncount, undoDrafts);
    return token;
  } catch (e) {
    showToast(String(e), []);
    void load();
    return [];
  }
}

/** Every unread conversation in the list read, the pages not loaded yet too. Search results are left as they are:
 * there, "all" would be a guess. */
export async function markAllRead() {
  if (searching()) return;
  setRows(rows().map((r) => (r.unread ? { ...r, unread: 0, seen: true } : r)));
  try {
    const applied = await api.markAllRead(target());
    showToast(applied.token.length ? "Marked all read" : "Nothing unread here", applied.token);
  } catch (e) {
    showToast(String(e), []);
    void load();
  }
}

/** Star when any of the targets lacks one, else take the stars off. */
export const toggleStar = () => act(targets().every((r) => r.flagged) ? "unstar" : "star");
/** Mark read when anything is unread, else mark unread. */
export const toggleRead = () => act(targets().some((r) => r.unread > 0) ? "markRead" : "markUnread");

/** The labels of a Gmail account (their folders); other accounts have none. */
export const labelsOf = (accountId: number) => folders().filter((f) => f.accountId === accountId && f.role === "label");

export function startLabel() {
  const hit = targets();
  if (!hit.length) return;
  if (!labelsOf(hit[0].accountId).length) return showToast("Labels are for Gmail accounts", []);
  setLabeling(hit);
}

export async function label(hit: ThreadRow[], f: Folder, add: boolean) {
  setLabeling(null);
  // Only the conversations of the label's account; the picker shows one account's labels.
  const mine = hit.filter((r) => r.accountId === f.accountId);
  const keys = new Set(mine.map(keyOf));
  const patch = (r: ThreadRow) => {
    const now = (r.labels ?? []).filter((l) => l !== f.name);
    return { ...r, labels: add ? [...now, f.name].sort() : now };
  };
  setRows(rows().map((r) => (keys.has(keyOf(r)) ? patch(r) : r)));
  try {
    const applied = await api.labelConversations(mine.map((r) => r.id), f.id, add);
    const what = mine.length === 1 ? "" : ` (${mine.length} conversations)`;
    showToast(add ? `Labelled ${f.name}${what}` : `Removed ${f.name}${what}`, applied.token, () => void refresh());
  } catch (e) {
    showToast(String(e), []);
    void refresh();
  }
}

/** Mutes the target conversations: out of the inbox now, and later replies skip it. */
export async function mute() {
  const hit = targets();
  if (!hit.length) return;
  const ids = hit.map((r) => r.id);
  await api.mute(ids, true);
  const token = await act("archive", hit, false);
  showToast(hit.length === 1 ? "Muted" : `Muted ${hit.length} conversations`, token, () => api.mute(ids, false));
}

/** The inbox of the account at this place in the account list (Ctrl+1 … Ctrl+9). */
export function switchAccount(index: number) {
  const account = accounts()[index];
  const inbox = account && folders().find((f) => f.accountId === account.id && f.role === "inbox");
  if (inbox) go({ folder: inbox.id });
}

export async function restartToUpdate() {
  try {
    await api.restartToUpdate();
  } catch (e) {
    showToast(`The update didn't install: ${e}`, []);
  }
}
