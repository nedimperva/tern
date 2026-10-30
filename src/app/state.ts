// What the main window shows, as signals the rest of src/app reads and writes. One window, so one copy, kept at
// module level like settings.ts and day.ts; App.tsx lays it out.

import { batch, createSignal } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import type {
  Account,
  Folder,
  OutboxProblem,
  OutboxWaiting,
  Signature,
  SyncProgress,
  SyncState,
  Target,
  ThreadMessage,
  ThreadRow,
} from "../api";
import type { ComposeInit } from "../components/Compose";
import type { Context } from "../keys";
import { deck, screen } from "../day";
import { setSetting, settings } from "../settings";

export const [accounts, setAccounts] = createSignal<Account[]>([]);
// Every account's signatures, for compose; read again when settings close.
export const [signatures, setSignatures] = createSignal<Signature[]>([]);
export const [syncStates, setSyncStates] = createSignal<Record<number, SyncState>>({});
export const [progress, setProgress] = createSignal<SyncProgress[]>([]);
export const [folders, setFolders] = createSignal<Folder[]>([]);
export const [splitUnread, setSplitUnread] = createSignal<[number, number]>([0, 0]);
export const [problems, setProblems] = createSignal<OutboxProblem[]>([]);
export const [waiting, setWaiting] = createSignal<OutboxWaiting[]>([]);
export const [ready, setReady] = createSignal(false);
export const [online, setOnline] = createSignal(navigator.onLine);
// A downloaded update waiting for "Restart to update" (AppImage and Windows builds only).
export const [update, setUpdate] = createSignal<string | null>(null);

// Where Tern opens and `g i` goes: the Important split, or the whole inbox with splits off.
export const home = (): Target => ({ role: settings.splitInbox ? "important" : "inbox" });
export const [target, setTarget] = createSignal<Target>(home());
export const [query, setQuery] = createSignal("");
export const [rows, setRows] = createSignal<ThreadRow[]>([]);
export const [focus, setFocus] = createSignal(0);
export const [selection, setSelection] = createSignal<ReadonlySet<string>>(new Set());
// Some mail has headers only, so words in its body were not searched.
export const [partial, setPartial] = createSignal(false);

// The open conversation, by key, and the row it was opened from (kept if the row leaves the list).
export const [openRow, setOpenRow] = createSignal<ThreadRow | null>(null);
// Sync reloads the open conversation on every change. Reconciling by id keeps unchanged messages as they are,
// so their HTML frames are not rebuilt (which flickered, most visibly on Windows).
const [messagesStore, setMessagesStore] = createStore<ThreadMessage[]>([]);
export const messages = messagesStore;
export const setMessages = (t: ThreadMessage[]) => setMessagesStore(reconcile(t, { key: "id" }));
export const [messageFocus, setMessageFocus] = createSignal(0);
export const [expanded, setExpanded] = createSignal<ReadonlySet<number>>(new Set());
// Whether the open conversation is muted, for "Unmute" in the palette.
export const [openMuted, setOpenMuted] = createSignal(false);

export const [width, setWidth] = createSignal(window.innerWidth);
// The rail sliding over the list: the sidebar's place in a narrow window, or with the sidebar turned off.
export const [rail, setRail] = createSignal(false);
/** From this width the sidebar can stay beside the list and an open conversation (§3). */
export const SIDEBAR_WIDTH = 1100;
// Focus mode: the open conversation over the whole window, list hidden, until F again. Kept for the session.
export const [focusMode, setFocusMode] = createSignal(false);
export const [compose, setCompose] = createSignal<ComposeInit | null>(null);
// New mail folded into a corner card while the person reads; a new compose always opens unfolded.
export const [composeMin, setComposeMin] = createSignal(false);
export const [palette, setPalette] = createSignal(false);
// Opens the palette straight in one command's choices (g l → "Go to folder …").
export const [paletteStart, setPaletteStart] = createSignal<string | undefined>();
export const choose = (command: string) => batch(() => (setPaletteStart(command), setPalette(true)));
export const [setup, setSetup] = createSignal(false);
export const [reviewing, setReviewing] = createSignal(false);
export const [sheet, setSheet] = createSignal(false);
// The file shown in the attachment viewer, if any.
export const [viewing, setViewing] = createSignal<{ message: ThreadMessage; index: number } | null>(null);
// Which settings section is open, if any.
export const [settingsOpen, setSettingsOpen] = createSignal<string | null>(null);
/** The conversations the snooze picker is choosing a time for. */
export const [snoozing, setSnoozing] = createSignal<ThreadRow[] | null>(null);
// `l`: the conversations a Gmail label goes on or comes off.
export const [labeling, setLabeling] = createSignal<ThreadRow[] | null>(null);
export const [perf, setPerf] = createSignal(false);
// A few useful keys in the status strip once the keyboard has been still for a moment.
export const [idle, setIdle] = createSignal(false);

/** Tern draws its own title bar on Windows only. On Linux the window manager handles the window (Hyprland draws no
 * frame and ignores minimize and maximize), so the bar's buttons would do nothing there. */
export const ownTitleBar = !navigator.userAgent.includes("Linux");

/** The sidebar sits beside the list now: turned on, room for it, and not in focus mode. */
export const docked = () => settings.sidebar && width() >= SIDEBAR_WIDTH && !focusMode();
/** The title bar's button and Ctrl+\: in a wide window they keep the sidebar open or closed for good; in a
 * narrow one they slide the rail over the list. */
export const toggleSidebar = () =>
  width() >= SIDEBAR_WIDTH && !focusMode() ? (setRail(false), setSetting("sidebar", !settings.sidebar)) : setRail(!rail());

/** The companion beside the open conversation (`i`, `Ctrl+.`). */
export const toggleCompanion = () => setSetting("companion", !settings.companion);
export const showCompanion = () => {
  if (!settings.companion) setSetting("companion", true);
};
/** Where the companion's Details are drawn: the open conversation fills it, as the facts, contents and marks are
 * its own (ConversationView portals them in). */
export const [detailsSlot, setDetailsSlot] = createSignal<HTMLElement | null>(null);

/** The search box, for `/`. */
export const searchBox: { input?: HTMLInputElement } = {};

export const current = () => rows()[focus()];
export const context = (): Context => (openRow() ? "conversation" : "list");
/** Something is over the list and takes the keys. */
export const dialog = () =>
  screen() || deck() !== null || reviewing() || palette() || sheet() || settingsOpen() !== null || (compose() !== null && !composeMin()) || setup() || rail() || snoozing() !== null || labeling() !== null ||
  viewing() !== null;
export const searching = () => query().trim() !== "";
/** The role of the list on show ("" for a folder or label). */
export const role = () => {
  const t = target();
  return "role" in t ? t.role : "";
};
