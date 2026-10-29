// The conversation list: loading it, reading it again as sync changes mail, moving around and selecting in it,
// and which list is on show.

import { batch, createEffect, on } from "solid-js";
import { api, type Target } from "../api";
import { refreshStart } from "../day";
import { timeQuery } from "../perf";
import { wingBeat } from "../sound";
import { quietNow, setSetting, settings } from "../settings";
import { ROLE_NAMES } from "../components/Rail";
import { asRow, keepRows, keyOf } from "./rows";
import { close, open } from "./conversation";
import {
  current,
  focus,
  folders,
  home,
  messages,
  openRow,
  query,
  rows,
  searching,
  selection,
  setAccounts,
  setFocus,
  setFolders,
  setMessages,
  setOpenRow,
  setPartial,
  setProblems,
  setProgress,
  setQuery,
  setReady,
  setRows,
  setSelection,
  setSignatures,
  setSplitUnread,
  setTarget,
  setWaiting,
  waiting,
  splitUnread,
  target,
} from "./state";

const PAGE = 100;

let exhausted = false;
let generation = 0;

export const loadSignatures = () => void api.signatures().then(setSignatures, () => {});

// Counting is cheap but not free at 100k messages; a backfill changes mail many times a second.
let progressTimer: number | undefined;
export const readProgress = () => {
  if (progressTimer !== undefined) return;
  progressTimer = window.setTimeout(() => {
    progressTimer = undefined;
    void api.syncProgress().then(setProgress, () => {});
  }, 1000);
};

/** Reloads the list. Keeps as many rows as are loaded, so a change from sync never makes the list jump. */
export async function load() {
  const ticket = ++generation;
  const q = query().trim();
  const found = q ? await api.search(q, 500) : null;
  const page = found
    ? found.rows.map(asRow)
    : await timeQuery(() => api.listThreads(target(), null, Math.max(PAGE, rows().length)));
  if (ticket !== generation) return;
  setPartial(found?.partial ?? false);
  exhausted = q !== "" || page.length < PAGE;
  // Focus stays on the same conversation if it is still there, else on the same place in the list.
  const focusedKey = current() && keyOf(current()!);
  batch(() => {
    setRows(keepRows(rows(), page));
    const at = focusedKey ? page.findIndex((r) => keyOf(r) === focusedKey) : -1;
    setFocus(at >= 0 ? at : Math.min(focus(), Math.max(0, page.length - 1)));
    const keys = new Set(page.map(keyOf));
    setSelection(new Set([...selection()].filter((k) => keys.has(k))));
  });
}

export async function loadMore() {
  const last = rows()[rows().length - 1];
  if (exhausted || !last || searching()) return;
  exhausted = true;
  const ticket = generation;
  const page = await api.listThreads(target(), { date: last.date, id: last.id }, PAGE);
  if (ticket !== generation) return;
  exhausted = page.length < PAGE;
  setRows([...rows(), ...page]);
}

/** Everything the window shows, read again. Sync never changes signatures, so its changes leave them out. */
export async function refresh(signatures = true) {
  if (signatures) loadSignatures();
  const [a, f, p, w, s] = await Promise.all([
    api.accounts(),
    api.folders(),
    api.problems(),
    api.waiting(),
    api.splitUnread(),
  ]);
  if (settings.wingBeat && !quietNow()) {
    // A send that was past its undo window and is gone now, not to the problems: it went out.
    const now = Date.now() / 1000;
    const left = waiting().filter(
      (b) => b.what.startsWith("Send") && b.notBefore <= now && !w.some((x) => x.id === b.id) && !p.some((x) => x.id === b.id),
    );
    if (left.length) wingBeat();
  }
  batch(() => {
    setAccounts(a);
    setFolders(f);
    setSplitUnread(s);
    setProblems(p);
    setWaiting(w);
    setReady(true);
  });
  await load();
}

/** Reloads the open conversation from any of its messages that still exists. */
async function reloadConversation() {
  const open = openRow();
  if (!open) return;
  const ids = [open.id, ...messages.map((m) => m.id)];
  for (const id of ids) {
    const found = await api.thread(id);
    if (found.length) return void setMessages(found);
  }
}

// Sync can report many changes a second (a backfill reports each batch): read everything again at most every
// 150 ms. The first change in a quiet spell shows at once; the rest wait for the end of the window.
const CHANGE_MS = 150;
let changeTimer: number | undefined;
let changeAgain = false;
export const onChange = () => {
  void refreshStart();
  readProgress();
  if (changeTimer !== undefined) {
    changeAgain = true;
    return;
  }
  const run = () => {
    void refresh(false);
    void reloadConversation();
  };
  run();
  const settle = () => {
    if (!changeAgain) return void (changeTimer = undefined);
    changeAgain = false;
    run();
    changeTimer = window.setTimeout(settle, CHANGE_MS);
  };
  changeTimer = window.setTimeout(settle, CHANGE_MS);
};

export const go = (t: Target) => {
  batch(() => (setQuery(""), setTarget(t)));
  if ("folder" in t) void api.checkFolder(t.folder);
  else if ("label" in t) void api.checkFolder(t.label);
};

/** The inbox splits, shown as tabs over the unified inbox. */
export const SPLITS = (): { name: string; target: Target }[] =>
  settings.splitInbox
    ? [
        { name: "Important", target: { role: "important" } },
        { name: "Other", target: { role: "bulk" } },
        { name: "Starred", target: { role: "starred" } },
      ]
    : [
        { name: "Inbox", target: { role: "inbox" } },
        { name: "Starred", target: { role: "starred" } },
      ];
export const splitIndex = () => SPLITS().findIndex((s) => JSON.stringify(s.target) === JSON.stringify(target()));
export const nextSplit = (by: number) => {
  const all = SPLITS();
  const at = splitIndex();
  if (at < 0) return go(all[0].target);
  go(all[(at + by + all.length) % all.length].target);
};

/** The list's own effects; App runs this once. */
export function watchList() {
  createEffect(
    on(
      [target, query],
      () => {
        batch(() => (setFocus(0), setSelection(new Set<string>()), setOpenRow(null)));
        void load();
      },
      { defer: true },
    ),
  );
  // Turning the splits on or off moves the list to where `g i` now goes.
  createEffect(
    on(
      () => settings.splitInbox,
      () => {
        const t = target();
        if ("role" in t && ["inbox", "important", "bulk"].includes(t.role)) go(home());
      },
      { defer: true },
    ),
  );
}

// MARK: Focus and selection

/** Moves the focus; with a conversation open, the next one opens in its place. */
export function move(by: number) {
  const next = Math.max(0, Math.min(rows().length - 1, focus() + by));
  if (next === focus()) return;
  setFocus(next);
  if (openRow()) void open(rows()[next]);
}

export function toggleSelected(row = current()) {
  if (!row) return;
  const next = new Set(selection());
  if (next.has(keyOf(row))) next.delete(keyOf(row));
  else next.add(keyOf(row));
  setSelection(next);
}

/** Shift+J / Shift+K: select the focused row and the one it moves to. */
export function extend(by: number) {
  const from = current();
  if (!from) return;
  const next = new Set(selection()).add(keyOf(from));
  const to = rows()[focus() + by];
  if (to) {
    next.add(keyOf(to));
    setFocus(focus() + by);
  }
  setSelection(next);
}

/** Esc goes one level up, never two: conversation → list → selection → search. */
export function escape() {
  if (openRow()) close();
  else if (selection().size) setSelection(new Set<string>());
  else if (query()) setQuery("");
}

// MARK: What the header shows

export const isTarget = (t: Target) => JSON.stringify(t) === JSON.stringify(target()) && !query();

export const title = () => {
  if (searching()) return `Search: ${query()}`;
  const t = target();
  if ("role" in t) return t.role === "inbox" ? "Inbox" : t.role === "starred" ? "Starred" : ROLE_NAMES[t.role] ?? t.role;
  const id = "folder" in t ? t.folder : t.label;
  const f = folders().find((f) => f.id === id);
  return f ? ROLE_NAMES[f.role] ?? f.name : "";
};

const inboxUnread = () => folders().filter((f) => f.role === "inbox").reduce((n, f) => n + f.unread, 0);
/** The unread count a split's tab shows; Starred shows none. */
export const tabUnread = (t: Target) => {
  const role = "role" in t ? t.role : "";
  return role === "important" ? splitUnread()[0] : role === "bulk" ? splitUnread()[1] : role === "inbox" ? inboxUnread() : 0;
};

// MARK: Saved searches

/** The search typed now is one of the saved ones. */
export const isSaved = () => settings.savedSearches.includes(query().trim());

/** Keeps the search typed now in the rail and the palette, or forgets it. */
export function toggleSaved() {
  const q = query().trim();
  if (!q) return;
  setSetting("savedSearches", isSaved() ? settings.savedSearches.filter((s) => s !== q) : [...settings.savedSearches, q]);
}

/** Runs a saved search over the list on show. */
export const runSearch = (q: string) => batch(() => (close(), setQuery(q)));

export const forgetSearch = (q: string) => setSetting("savedSearches", settings.savedSearches.filter((s) => s !== q));
