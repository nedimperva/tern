// The conversation list: loading it, reading it again as sync changes mail, moving around and selecting in it,
// and which list is on show.

import { batch, createEffect, createSignal, on } from "solid-js";
import { api, type Target, type ThreadRow } from "../api";
import { refreshStart } from "../day";
import { timeQuery } from "../perf";
import { wingBeat } from "../sound";
import { quietNow, setSetting, settings } from "../settings";
import { ROLE_NAMES } from "../components/Rail";
import { asRow, keepRows, keyOf, people } from "./rows";
import { close, open } from "./conversation";
import {
  current,
  docked,
  focus,
  folders,
  home,
  listKey,
  messages,
  newPeople,
  openRow,
  query,
  role,
  rows,
  searchBox,
  searching,
  selection,
  setAccounts,
  setFocus,
  setFolders,
  setListed,
  setMessages,
  setNewPeople,
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

/** "Search the server" for the search on show: idle, asking, or what it found (package 17 E). */
export const [serverFound, setServerFound] = createSignal<{ query: string; state: "busy" | "done" | "error"; rows: ThreadRow[]; error?: string }>({
  query: "",
  state: "done",
  rows: [],
});

/** Asks each account's server for the words of the search on show, where mail isn't all here; what it finds goes
 * under the local results. */
export async function searchServer() {
  const q = query().trim();
  if (!q || serverFound().state === "busy") return;
  setServerFound({ query: q, state: "busy", rows: [] });
  try {
    const rows = (await api.searchServer(q)).map((m) => ({ ...asRow(m), fromServer: true }));
    if (query().trim() !== q) return;
    setServerFound({ query: q, state: "done", rows });
    await load();
  } catch (e) {
    if (query().trim() === q) setServerFound({ query: q, state: "error", rows: [], error: String(e) });
  }
}

/** Reloads the list. Keeps as many rows as are loaded, so a change from sync never makes the list jump. */
export async function load() {
  const ticket = ++generation;
  const key = listKey();
  const q = query().trim();
  const found = q ? await api.search(q, 500) : null;
  // New people is read whole (it is short) and shown a row per person.
  const screening = !found && role() === "new_people";
  const read = found
    ? found.rows.map(asRow)
    : await timeQuery(() => api.listThreads(target(), null, screening ? 1000 : Math.max(PAGE, rows().length)));
  if (ticket !== generation) return;
  // What the server found for this search stays under the local results, until its text is here and they are
  // found locally too.
  const local = new Set(read.map(keyOf));
  const fromServer = found && serverFound().query === q ? serverFound().rows.filter((r) => !local.has(keyOf(r))) : [];
  const page = screening ? people(read) : [...read, ...fromServer];
  setPartial(found?.partial ?? false);
  exhausted = q !== "" || screening || page.length < PAGE;
  // Focus stays on the same conversation if it is still there, else on the same place in the list.
  const focusedKey = current() && keyOf(current()!);
  batch(() => {
    setRows(keepRows(rows(), page));
    setListed(key);
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
  await refreshAround(signatures);
  await load();
}

/** What sits around the list (accounts, folders and their counts, waiting work), read again. */
async function refreshAround(signatures: boolean) {
  if (signatures) loadSignatures();
  const [a, f, p, w, s, n] = await Promise.all([
    api.accounts(),
    api.folders(),
    api.problems(),
    api.waiting(),
    api.splitUnread(),
    api.newPeople(),
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
    setNewPeople(n);
    setProblems(p);
    setWaiting(w);
    setReady(true);
  });
}

/** Lists whose rows are more than a conversation's newest message: a person's grouped mail, marks, search. */
const patchable = () => !searching() && !["new_people", "marked"].includes(role()) && !rows().some((r) => r.followUp);

/** Replaces the rows of these conversations with what the store has now (package 17 B), instead of reading the
 * page again. Anything that moves a row (a new conversation, a newer message) reads the page again after all. */
async function patch(keys: string[]) {
  if (!patchable()) return load();
  const ticket = generation;
  const fresh = await api.threadsIn(target(), keys);
  if (ticket !== generation) return;
  const now = new Map(fresh.map((r) => [keyOf(r), r]));
  const shown = new Map(rows().map((r) => [keyOf(r), r]));
  for (const k of keys) {
    const was = shown.get(k);
    const is = now.get(k);
    // A conversation new to the list, or one whose newest message changed, goes somewhere else in the order.
    if (is && (!was || was.date !== is.date || was.id !== is.id)) return load();
  }
  const focusedKey = current() && keyOf(current()!);
  batch(() => {
    // Gone from the list (moved, read in Other's unread view…) drops out; the rest take the store's word.
    const next = rows().flatMap((r) => (keys.includes(keyOf(r)) ? (now.has(keyOf(r)) ? [now.get(keyOf(r))!] : []) : [r]));
    setRows(next);
    const at = focusedKey ? next.findIndex((r) => keyOf(r) === focusedKey) : -1;
    setFocus(at >= 0 ? at : Math.min(focus(), Math.max(0, next.length - 1)));
    const left = new Set(next.map(keyOf));
    setSelection(new Set([...selection()].filter((k) => left.has(k))));
  });
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

// Sync can report many changes a second (a backfill reports each batch): act on them at most every 150 ms. The
// first change in a quiet spell shows at once; the rest gather until the end of the window. Each names the
// conversations it wrote, or none for "read it all".
const CHANGE_MS = 150;
let changeTimer: number | undefined;
let changeAgain = false;
let pending: Set<string> | null = new Set();
export const onChange = (threads: string[] | null) => {
  void refreshStart();
  readProgress();
  if (threads && pending) for (const t of threads) pending.add(t);
  else pending = null;
  if (changeTimer !== undefined) {
    changeAgain = true;
    return;
  }
  const run = () => {
    const keys = pending;
    pending = new Set();
    const open = openRow();
    void refreshAround(false).then(() => (keys ? patch([...keys]) : load()));
    if (!keys || (open && keys.has(keyOf(open)))) void reloadConversation();
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

/** The inbox splits, shown as tabs over the unified inbox. New people joins them as a quiet tab (its icon and count)
 * while someone waits there and the sidebar, which lists it, is closed; and while it is the list on show (canvas
 * "Tern title bar ideas", 4). */
export const SPLITS = (): { name: string; target: Target }[] => {
  const showing = "role" in target() && (target() as { role: string }).role === "new_people";
  const screening =
    settings.screener && (showing || (newPeople() > 0 && !docked()))
      ? [{ name: "New people", target: { role: "new_people" } }]
      : [];
  return settings.splitInbox
    ? [
        { name: "Important", target: { role: "important" } },
        { name: "Other", target: { role: "bulk" } },
        { name: "Starred", target: { role: "starred" } },
        ...screening,
      ]
    : [{ name: "Inbox", target: { role: "inbox" } }, { name: "Starred", target: { role: "starred" } }, ...screening];
};
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
  // Turning the splits (or the screener) on or off moves the list to where `g i` now goes.
  createEffect(
    on(
      () => [settings.splitInbox, settings.screener],
      () => {
        const t = target();
        if ("role" in t && ["inbox", "important", "bulk", "new_people"].includes(t.role)) go(home());
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

/** Esc goes one level up, never two: conversation → list → selection → the search box (with its words, to change
 * them; Esc there clears the search). */
export function escape() {
  if (openRow()) close();
  else if (selection().size) setSelection(new Set<string>());
  else if (query()) searchBox.input?.select();
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
/** The unread count a split's tab shows (New people: how many wait); Starred shows none. */
export const tabUnread = (t: Target) => {
  const role = "role" in t ? t.role : "";
  if (role === "new_people") return newPeople();
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
