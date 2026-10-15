import { batch, createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import {
  api,
  moves,
  type Account,
  type Action,
  type Folder,
  type MessageRow,
  type OutboxProblem,
  type OutboxWaiting,
  type SyncState,
  type Target,
  type ThreadMessage,
  type ThreadRow,
  type Draft,
  type ReplyKind,
  type DraftRecord,
  type Mailto,
  type NewMail,
} from "./api";
import { AccountSetup } from "./components/AccountSetup";
import { CommandBar, type Command } from "./components/CommandBar";
import { Compose, type ComposeInit } from "./components/Compose";
import { ConversationRow } from "./components/ConversationRow";
import type { MenuItem } from "./components/ActionMenu";
import type { PersonActions } from "./components/PersonCard";
import { ConversationView, takeQuote } from "./components/ConversationView";
import { ProblemsDialog } from "./components/Problems";
import { Rail, ROLE_NAMES } from "./components/Rail";
import { ShortcutSheet } from "./components/ShortcutSheet";
import { SettingsPage } from "./components/SettingsPage";
import { SnoozePicker } from "./components/SnoozePicker";
import { AttachmentViewer } from "./components/AttachmentViewer";
import { until } from "./components/ConversationRow";
import { PerfOverlay } from "./components/PerfOverlay";
import { timeKey, timeQuery } from "./perf";
import { loadSettings, ROW_HEIGHTS, setSetting, settings } from "./settings";
import { Icon } from "./components/Icon";
import { VirtualList } from "./components/VirtualList";
import { keyHandler, keyLabel, type Binding, type Context } from "./keys";

const PAGE = 100;
const UNDO_MS = 5000;
/** With the "auto" open mode, from this width an open conversation sits beside the list; narrower, it covers it. */
const SPLIT_WIDTH = 1200;
/** Below this width there is no room for the list beside a conversation, whatever the setting (§3). */
const MIN_SPLIT_WIDTH = 960;

/** A conversation's identity across reloads: its newest message, and so the row's id, changes as mail arrives. */
const keyOf = (r: MessageRow) => `${r.accountId}:${r.threadId}`;

/** A search hit shown like a conversation row. */
const asRow = (m: MessageRow): ThreadRow => ({
  ...m,
  snoozedUntil: null,
  count: 1,
  unread: m.seen ? 0 : 1,
  participants: [m.fromName || m.fromAddr],
});

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

export default function App() {
  const [accounts, setAccounts] = createSignal<Account[]>([]);
  const [syncStates, setSyncStates] = createSignal<Record<number, SyncState>>({});
  const [folders, setFolders] = createSignal<Folder[]>([]);
  // Where Tern opens and `g i` goes: the Important split, or the whole inbox with splits off.
  const home = (): Target => ({ role: settings.splitInbox ? "important" : "inbox" });
  const [target, setTarget] = createSignal<Target>(home());
  const [query, setQuery] = createSignal("");
  const [rows, setRows] = createSignal<ThreadRow[]>([]);
  const [focus, setFocus] = createSignal(0);
  const [selection, setSelection] = createSignal<ReadonlySet<string>>(new Set());
  // The open conversation, by key, and the row it was opened from (kept if the row leaves the list).
  const [openRow, setOpenRow] = createSignal<ThreadRow | null>(null);
  // Sync reloads the open conversation on every change. Reconciling by id keeps unchanged messages as they are,
  // so their HTML frames are not rebuilt (which flickered, most visibly on Windows).
  const [messages, setMessagesStore] = createStore<ThreadMessage[]>([]);
  const setMessages = (t: ThreadMessage[]) => setMessagesStore(reconcile(t, { key: "id" }));
  const [messageFocus, setMessageFocus] = createSignal(0);
  const [expanded, setExpanded] = createSignal<ReadonlySet<number>>(new Set());
  const [width, setWidth] = createSignal(window.innerWidth);
  const [rail, setRail] = createSignal(false);
  // `after` runs when the toast's change is undone (unmute after undoing a mute).
  // `undo` takes back something that is not queued work (a discarded draft).
  const [toast, setToast] = createSignal<{
    text: string;
    token: number[];
    after?: () => unknown;
    undo?: () => unknown;
  } | null>(null);
  const [compose, setCompose] = createSignal<ComposeInit | null>(null);
  const [palette, setPalette] = createSignal(false);
  // Opens the palette straight in one command's choices (g l → "Go to folder …").
  const [paletteStart, setPaletteStart] = createSignal<string | undefined>();
  const choose = (command: string) => batch(() => (setPaletteStart(command), setPalette(true)));
  const [setup, setSetup] = createSignal(false);
  const [ready, setReady] = createSignal(false);
  const [problems, setProblems] = createSignal<OutboxProblem[]>([]);
  const [waiting, setWaiting] = createSignal<OutboxWaiting[]>([]);
  // Seconds, ticking only while work waits, so items leave their undo window without an event.
  const [clock, setClock] = createSignal(Date.now() / 1000);
  const [online, setOnline] = createSignal(navigator.onLine);
  createEffect(() => {
    if (!waiting().length) return;
    const timer = setInterval(() => setClock(Date.now() / 1000), 1000);
    onCleanup(() => clearInterval(timer));
  });
  /** Waiting work worth mentioning: past its undo window by a moment, tried before, or going out now. A change
   * still in its undo window is the toast's business. */
  const late = () => waiting().filter((w) => w.sending || w.attempts > 0 || w.notBefore + 2 <= clock());

  const [reviewing, setReviewing] = createSignal(false);
  const [sheet, setSheet] = createSignal(false);
  // The file shown in the attachment viewer, if any.
  const [viewing, setViewing] = createSignal<{ message: ThreadMessage; index: number } | null>(null);
  // Which settings section is open, if any.
  const [settingsOpen, setSettingsOpen] = createSignal<string | null>(null);
  /** The conversations the snooze picker is choosing a time for. */
  const [snoozing, setSnoozing] = createSignal<ThreadRow[] | null>(null);
  const [splitUnread, setSplitUnread] = createSignal<[number, number]>([0, 0]);
  const [perf, setPerf] = createSignal(false);
  // A few useful keys in the status strip once the keyboard has been still for a moment.
  const [idle, setIdle] = createSignal(false);
  let searchInput!: HTMLInputElement;
  let exhausted = false;
  let generation = 0;

  const current = () => rows()[focus()];
  const context = (): Context => (openRow() ? "conversation" : "list");
  const dialog = () =>
    reviewing() || palette() || sheet() || settingsOpen() !== null || compose() !== null || setup() || rail() || snoozing() !== null ||
    viewing() !== null;
  const searching = () => query().trim() !== "";
  // Some mail has headers only, so words in its body were not searched.
  const [partial, setPartial] = createSignal(false);

  // MARK: Loading

  /** Reloads the list. Keeps as many rows as are loaded, so a change from sync never makes the list jump. */
  async function load() {
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
      setRows(page);
      const at = focusedKey ? page.findIndex((r) => keyOf(r) === focusedKey) : -1;
      setFocus(at >= 0 ? at : Math.min(focus(), Math.max(0, page.length - 1)));
      const keys = new Set(page.map(keyOf));
      setSelection(new Set([...selection()].filter((k) => keys.has(k))));
    });
  }

  async function loadMore() {
    const last = rows()[rows().length - 1];
    if (exhausted || !last || searching()) return;
    exhausted = true;
    const ticket = generation;
    const page = await api.listThreads(target(), { date: last.date, id: last.id }, PAGE);
    if (ticket !== generation) return;
    exhausted = page.length < PAGE;
    setRows([...rows(), ...page]);
  }

  async function refresh() {
    const [a, f, p, w, s] = await Promise.all([
      api.accounts(),
      api.folders(),
      api.problems(),
      api.waiting(),
      api.splitUnread(),
    ]);
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

  // Sync can report many changes a second; draw once per frame at most.
  let pending = false;
  const onChange = () => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      void refresh();
      void reloadConversation();
    });
  };

  onMount(() => {
    api.onSyncState((id, state) => {
      setSyncStates({ ...syncStates(), [id]: state });
      // A lost connection can put work back in the queue without a mail change.
      void api.waiting().then(setWaiting);
    });
    void api.syncStates().then((s) => setSyncStates({ ...s, ...syncStates() }));
    api.onChange(onChange);
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    onCleanup(() => window.removeEventListener("resize", onResize));
    // The system knows before a dead connection times out; reconnect now rather than after the retry wait.
    const onOnline = () => (setOnline(true), api.networkBack());
    const onOffline = () => setOnline(false);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    onCleanup(() => (window.removeEventListener("online", onOnline), window.removeEventListener("offline", onOffline)));
    void loadSettings();
    void refresh();
    // The tray, the system's links and notifications. Closing the window leaves Tern in the tray unless turned off.
    api.keepRunningWhen(() => settings.background);
    api.onDesktop({ compose: newMessage, mailto: fromLink, openMail: (m) => void openMail(m) });
    void api.takeMailto().then((m) => m && fromLink(m));
    // Fetch the compose editor while the person reads, so the first "c" opens at once.
    const warm = () => void import("./components/Editor");
    if ("requestIdleCallback" in window) requestIdleCallback(warm);
    else setTimeout(warm, 1500);
  });

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

  // MARK: The open conversation

  let readTimer: number | undefined;
  async function open(row: ThreadRow | undefined) {
    clearTimeout(readTimer);
    if (!row) return close();
    // A draft being written in Tern opens in compose, not as a conversation.
    if (folders().find((f) => f.id === row.folderId)?.role === "drafts") {
      const record = await api.draftForMessage(row.id);
      if (record) return resume(record);
    }
    setOpenRow(row);
    const found = await api.thread(row.id);
    if (openRow() !== row) return;
    batch(() => {
      setMessages(found);
      // The newest message and anything unread start open, as they are what there is to read.
      setExpanded(new Set(found.filter((m, i) => !m.seen || i === found.length - 1).map((m) => m.id)));
      setMessageFocus(Math.max(0, found.length - 1));
    });
    if (row.unread > 0 && settings.readAfterMs >= 0) {
      readTimer = window.setTimeout(() => {
        if (openRow() === row) void act("markRead", [row], false);
      }, settings.readAfterMs);
    }
  }

  function close() {
    clearTimeout(readTimer);
    batch(() => (setOpenRow(null), setMessages([])));
  }

  const toggleMessage = (index: number) => {
    const m = messages[index];
    if (!m) return;
    const next = new Set(expanded());
    if (next.has(m.id)) next.delete(m.id);
    else next.add(m.id);
    batch(() => (setExpanded(next), setMessageFocus(index)));
  };
  const moveMessage = (by: number) => setMessageFocus(Math.max(0, Math.min(messages.length - 1, messageFocus() + by)));

  // MARK: Actions

  /** What an action applies to: the selection if there is one, else the open conversation or the focused row. */
  function targets(): ThreadRow[] {
    const chosen = selection();
    if (chosen.size) return rows().filter((r) => chosen.has(keyOf(r)));
    const one = openRow() ?? current();
    return one ? [one] : [];
  }

  /** Takes conversations off the list at once (they moved away); focus goes to the row that takes their place. */
  function dropRows(hit: ThreadRow[]) {
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

  /** Snoozes the conversations the picker was opened for. Snoozing is Tern's alone, so Undo is immediate. */
  async function snoozeUntil(due: number) {
    const hit = snoozing() ?? [];
    setSnoozing(null);
    if (!hit.length) return;
    const ids = hit.map((r) => r.id);
    const snoozedView = "role" in target() && (target() as { role: string }).role === "snoozed";
    if (!snoozedView) dropRows(hit);
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

  /** Brings snoozed conversations back now (Shift+H). */
  async function wake() {
    const hit = targets().filter((r) => r.snoozedUntil != null);
    if (!hit.length) return;
    if ("role" in target() && (target() as { role: string }).role === "snoozed") dropRows(hit);
    await api.unsnooze(hit.map((r) => r.id));
    showToast(hit.length === 1 ? "Back in the inbox" : `${hit.length} conversations back in the inbox`, []);
    void load();
  }

  /** Moves the senders of the target conversations to Other (or Important); their later mail follows. */
  async function moveToSplit(other: boolean) {
    const hit = targets();
    if (!hit.length) return;
    const ids = hit.map((r) => r.id);
    const t = target();
    const shown = "role" in t ? t.role : "";
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
  async function act(action: Action, hit = targets(), announce = true): Promise<number[]> {
    if (!hit.length) return [];
    const keys = new Set(hit.map(keyOf));
    if (moves(action)) {
      dropRows(hit);
    } else {
      const patch = (r: ThreadRow): ThreadRow =>
        action === "markRead"
          ? { ...r, unread: 0, seen: true }
          : action === "markUnread"
            ? { ...r, unread: Math.max(1, r.unread), seen: false }
            : { ...r, flagged: action === "star" };
      setRows(rows().map((r) => (keys.has(keyOf(r)) ? patch(r) : r)));
    }
    try {
      let token: number[] = [];
      if (searching()) {
        // Search spans folders: each hit is acted on where it is.
        for (const r of hit) token = token.concat((await api.applyConversations([r.id], action, { folder: r.folderId })).token);
      } else {
        token = (await api.applyConversations(hit.map((r) => r.id), action, target())).token;
      }
      const done =
        typeof action === "object"
          ? `Moved to ${folderName(folders().find((f) => f.id === action.moveTo))}`
          : DONE[action];
      if (announce) showToast(hit.length === 1 ? done : `${done} (${hit.length} conversations)`, token);
      return token;
    } catch (e) {
      showToast(String(e), []);
      void load();
      return [];
    }
  }

  /** Star when any of the targets lacks one, else take the stars off. */
  const toggleStar = () => act(targets().every((r) => r.flagged) ? "unstar" : "star");
  /** Mark read when anything is unread, else mark unread. */
  const toggleRead = () => act(targets().some((r) => r.unread > 0) ? "markRead" : "markUnread");

  let toastTimer: number | undefined;
  function showToast(text: string, token: number[], after?: () => unknown, undoAction?: () => unknown) {
    clearTimeout(toastTimer);
    setToast({ text, token, after, undo: undoAction });
    toastTimer = window.setTimeout(() => setToast(null), UNDO_MS);
  }

  async function undo() {
    const t = toast();
    if (t?.undo) {
      setToast(null);
      await t.undo();
      return;
    }
    if (!t?.token.length) return;
    setToast(null);
    const undone = await api.undo(t.token);
    if (!undone) showToast("Too late to undo", []);
    else await t.after?.();
    void load();
  }

  /** The account's signature with its "-- " line, or nothing. */
  const signature = (accountId = accounts()[0]?.id) => {
    const text = accountId == null ? "" : (settings.signatures[String(accountId)] ?? "").trim();
    return text ? `-- \n${text}` : "";
  };

  /** Opens a reply, reply-all or forward to `m`, set up by the engine from the message's headers. Replies sit
   * under the open conversation; a forward is a new message in its own dialog. */
  async function respond(m: ThreadMessage | undefined, kind: ReplyKind, only?: string) {
    if (!m) return;
    const init = await api.replyInit(m.id, kind);
    // Quick quote: with text selected in the message, the reply quotes just that.
    if (only) init.quoteText = only;
    const date = new Date(init.quoteDate * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
    const quote =
      kind === "forward"
        ? [
            "",
            "",
            "---------- Forwarded message ----------",
            `From: ${init.quoteFrom}`,
            `Date: ${date}`,
            `Subject: ${m.subject}`,
            `To: ${init.quoteTo}`,
            ...(init.quoteCc ? [`Cc: ${init.quoteCc}`] : []),
            "",
            init.quoteText,
          ].join("\n")
        : `\n\nOn ${date}, ${init.quoteFrom} wrote:\n${init.quoteText
            .split("\n")
            .map((l) => (l.startsWith(">") ? `>${l}` : `> ${l}`))
            .join("\n")}`;
    // The signature goes above what is quoted or forwarded, unless set to go below a quote.
    const sig = signature(init.accountId);
    const body = !sig ? quote : kind !== "forward" && settings.signatureBelow ? `${quote}\n\n${sig}` : `\n\n${sig}${quote}`;
    setCompose({
      accountId: init.accountId,
      to: init.to,
      cc: init.cc,
      subject: init.subject,
      body,
      inReplyTo: init.inReplyTo,
      references: init.references,
      focus: kind === "forward" ? "to" : "body",
      quoteOpen: only !== undefined,
      inline: kind !== "forward" && openRow() !== null,
      forwardOf: init.forwardOf,
      forwardFiles: init.forwardOf ? m.attachments : undefined,
    });
  }

  // Whether the open conversation is muted, for "Unmute" in the palette.
  const [openMuted, setOpenMuted] = createSignal(false);
  createEffect(on(openRow, (row) => (row ? void api.muted(row.id).then(setOpenMuted) : setOpenMuted(false))));
  async function unmute() {
    const row = openRow();
    if (!row) return;
    await api.mute([row.id], false);
    setOpenMuted(false);
    showToast("Unmuted", []);
  }

  /** Mutes the target conversations: out of the inbox now, and later replies skip it. */
  async function mute() {
    const hit = targets();
    if (!hit.length) return;
    const ids = hit.map((r) => r.id);
    await api.mute(ids, true);
    const token = await act("archive", hit, false);
    showToast(hit.length === 1 ? "Muted" : `Muted ${hit.length} conversations`, token, () => api.mute(ids, false));
  }

  const folderName = (f: Folder | undefined) => (f ? ROLE_NAMES[f.role] ?? f.name : "folder");
  const accountOf = (id: number) => accounts().find((a) => a.id === id)?.email ?? "";

  /** The inbox of the account at this place in the account list (Ctrl+1 … Ctrl+9). */
  function switchAccount(index: number) {
    const account = accounts()[index];
    const inbox = account && folders().find((f) => f.accountId === account.id && f.role === "inbox");
    if (inbox) go({ folder: inbox.id });
  }

  /** Queues the message (it leaves after the undo window); with `done`, the conversation it answers is marked done. */
  async function send(accountId: number, draft: Draft, done: boolean, draftId: number | null) {
    const sending = compose();
    const answering = sending?.inline ? openRow() : null;
    setCompose(null);
    try {
      const token = await api.send(accountId, draft, settings.sendDelay, draftId);
      const doneToken = done && answering ? await act("archive", [answering], false) : [];
      const text = settings.sendDelay > 0 ? "Sending…" : "Sent";
      // Undo brings the message back into compose, as it was.
      const reopen = () => setCompose({ ...sending, accountId, ...draft, draftId, focus: "body", unsaved: true });
      showToast(done && answering ? `${text} and marked done` : text, [...token, ...doneToken], reopen);
    } catch (e) {
      showToast(String(e), []);
    }
  }

  /** r: continues this conversation's draft if it has one, else replies to the focused message. */
  /** `v`: the focused message's files in the viewer, else the newest message's that has some. */
  function viewFiles() {
    const focused = messages[messageFocus()];
    const m = focused?.attachments.length ? focused : [...messages].reverse().find((x) => x.attachments.length);
    if (m) setViewing({ message: m, index: 0 });
  }

  async function reply() {
    const picked = takeQuote();
    const from = picked && messages.find((m) => m.id === picked.id);
    if (from) return void respond(from, "reply", picked!.text);
    const pending = messages.find((m) => m.draftId != null);
    const record = pending && (await api.draft(pending.draftId!));
    if (record) resume(record, true);
    else void respond(messages[messageFocus()], "reply");
  }

  /** Opens a saved draft in compose, under its conversation when one is open. */
  function resume(record: DraftRecord, inline = false) {
    const d = record.draft;
    setCompose({
      accountId: record.accountId,
      to: d.to,
      cc: d.cc ?? [],
      bcc: d.bcc ?? [],
      subject: d.subject,
      body: d.body,
      html: d.html ?? null,
      inReplyTo: d.inReplyTo ?? null,
      references: d.references ?? [],
      draftId: record.id,
      attachments: d.attachments ?? [],
      forwardOf: d.forwardOf ?? null,
      focus: d.to.length ? "body" : "to",
      inline,
    });
  }

  const composeClosed = (saved: number | null) => {
    setCompose(null);
    if (saved != null) showToast("Draft saved", []);
  };

  const composeDiscarded = (draftId: number | null) => {
    const was = compose();
    setCompose(null);
    if (draftId == null) return;
    showToast("Draft discarded", [], undefined, async () => {
      if (await api.undoDiscard(draftId)) {
        const record = await api.draft(draftId);
        if (record) resume(record, was?.inline ?? false);
      }
    });
  };

  /** The inbox splits, shown as tabs over the unified inbox. */
  const SPLITS = (): { name: string; target: Target }[] =>
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
  const splitIndex = () => SPLITS().findIndex((s) => JSON.stringify(s.target) === JSON.stringify(target()));
  const nextSplit = (by: number) => {
    const all = SPLITS();
    const at = splitIndex();
    if (at < 0) return go(all[0].target);
    go(all[(at + by + all.length) % all.length].target);
  };
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

  const newMessage = () => setCompose({ body: signature() ? `\n\n${signature()}` : "" });

  /** What a person's card in the conversation can do. */
  const person: PersonActions = {
    write: (email) => setCompose({ to: [email], body: signature() ? `\n\n${signature()}` : "", focus: "body" }),
    search: (email) => batch(() => (close(), setQuery(`from:${email}`))),
    open: (m) => void open(asRow(m)),
  };

  /** A `mailto:` link: compose, filled in from it. */
  function fromLink(m: Mailto) {
    const sig = signature();
    setCompose({
      to: m.to,
      cc: m.cc,
      bcc: m.bcc,
      subject: m.subject,
      body: sig ? `${m.body}\n\n${sig}` : m.body,
      focus: m.to.length ? "body" : "to",
    });
  }

  /** A clicked notification: the inbox, with that conversation open. */
  async function openMail(m: NewMail) {
    batch(() => (close(), setQuery(""), setTarget(home())));
    await load();
    const i = rows().findIndex((r) => r.accountId === m.accountId && r.threadId === m.threadId);
    if (i < 0) return;
    setFocus(i);
    void open(rows()[i]);
  }

  const go = (t: Target) => {
    batch(() => (setQuery(""), setTarget(t)));
    if ("folder" in t) void api.checkFolder(t.folder);
  };

  // MARK: Focus and selection

  /** Moves the focus; with a conversation open, the next one opens in its place. */
  function move(by: number) {
    const next = Math.max(0, Math.min(rows().length - 1, focus() + by));
    if (next === focus()) return;
    setFocus(next);
    if (openRow()) void open(rows()[next]);
  }

  function toggleSelected(row = current()) {
    if (!row) return;
    const next = new Set(selection());
    if (next.has(keyOf(row))) next.delete(keyOf(row));
    else next.add(keyOf(row));
    setSelection(next);
  }

  /** Shift+J / Shift+K: select the focused row and the one it moves to. */
  function extend(by: number) {
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
  function escape() {
    if (openRow()) close();
    else if (selection().size) setSelection(new Set<string>());
    else if (query()) setQuery("");
  }

  // MARK: Keys

  const bindings = createMemo<Binding[]>(() => [
    { keys: "j", name: "Next conversation", run: () => move(1) },
    { keys: "k", name: "Previous conversation", run: () => move(-1) },
    { keys: "ArrowDown", name: "Next conversation", run: () => move(1), hidden: true },
    { keys: "ArrowUp", name: "Previous conversation", run: () => move(-1), hidden: true },
    { keys: "PageDown", name: "Down a page", run: () => move(15), hidden: true },
    { keys: "PageUp", name: "Up a page", run: () => move(-15), hidden: true },
    { keys: "Home", name: "First conversation", run: () => move(-focus()), hidden: true },
    { keys: "End", name: "Last conversation", run: () => move(rows().length), hidden: true },
    { keys: "Enter", name: "Open conversation", context: "list", run: () => open(current()) },
    { keys: "o", name: "Open conversation", context: "list", run: () => open(current()), hidden: true },
    { keys: "Escape", name: "Back", run: escape },
    { keys: "e", name: "Done (archive)", run: () => act("archive") },
    { keys: "E", name: "Not done (back to Inbox)", run: () => act("inbox") },
    { keys: "!", name: "Mark as spam", run: () => act("junk") },
    { keys: "m", name: "Mute", run: mute },
    { keys: "#", name: "Move to Trash", run: () => act("trash") },
    { keys: "Delete", name: "Move to Trash", run: () => act("trash"), hidden: true },
    { keys: "s", name: "Star or unstar", run: toggleStar },
    { keys: "u", name: "Mark read or unread", run: toggleRead },
    { keys: "x", name: "Select conversation", context: "list", run: () => toggleSelected() },
    { keys: "J", name: "Select and move down", context: "list", run: () => extend(1) },
    { keys: "K", name: "Select and move up", context: "list", run: () => extend(-1) },
    { keys: "Ctrl+a", name: "Select all", context: "list", run: () => setSelection(new Set(rows().map(keyOf))) },
    { keys: "n", name: "Next message", context: "conversation", run: () => moveMessage(1) },
    { keys: "p", name: "Previous message", context: "conversation", run: () => moveMessage(-1) },
    { keys: "o", name: "Expand or collapse message", context: "conversation", run: () => toggleMessage(messageFocus()) },
    { keys: "Enter", name: "Reply all", context: "conversation", run: () => respond(messages[messageFocus()], "replyAll") },
    { keys: "f", name: "Forward", context: "conversation", run: () => respond(messages[messageFocus()], "forward") },
    { keys: "O", name: "Expand all messages", context: "conversation", run: () => setExpanded(new Set(messages.map((m) => m.id))) },
    { keys: "r", name: "Reply (or continue the draft)", context: "conversation", run: reply },
    { keys: "v", name: "View attachments", context: "conversation", run: viewFiles },
    { keys: "z", name: "Undo", run: undo },
    { keys: "h", name: "Snooze", run: () => targets().length > 0 && setSnoozing(targets()) },
    { keys: "H", name: "Back from snooze now", run: () => void wake() },
    { keys: "c", name: "Compose", run: newMessage },
    { keys: "/", name: "Search", run: () => searchInput.focus() },
    { keys: "Tab", name: "Next split", context: "list", run: () => nextSplit(1) },
    { keys: "Shift+Tab", name: "Previous split", context: "list", run: () => nextSplit(-1) },
    { keys: "g i", name: "Go to Inbox", run: () => go(home()) },
    { keys: "g h", name: "Go to Snoozed", run: () => go({ role: "snoozed" }) },
    { keys: "g s", name: "Go to Starred", run: () => go({ role: "starred" }) },
    { keys: "g e", name: "Go to Done (Archive)", run: () => go({ role: "archive" }) },
    { keys: "g t", name: "Go to Sent", run: () => go({ role: "sent" }) },
    { keys: "g d", name: "Go to Drafts", run: () => go({ role: "drafts" }) },
    { keys: "g a", name: "Go to All Mail", run: () => go({ role: "all" }) },
    { keys: "g !", name: "Go to Spam", run: () => go({ role: "junk" }) },
    { keys: "g l", name: "Go to folder …", run: () => choose("Go to folder …") },
    ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => ({
      keys: `Ctrl+${n}`,
      name: `Go to account ${n}`,
      run: () => switchAccount(n - 1),
      hidden: true,
    })),
    { keys: "g ;", name: "Edit snippets", run: () => setSettingsOpen("Snippets") },
    { keys: "?", name: "Keyboard shortcuts", run: () => setSheet(true) },
    { keys: "Ctrl+,", name: "Settings", run: () => setSettingsOpen("Appearance") },
    { keys: "Ctrl+q", name: "Quit Tern", run: () => void api.quit() },
    { keys: "Ctrl+P", name: "Performance overlay", run: () => setPerf(!perf()) },
    { keys: "Ctrl+\\", name: "Accounts and folders", run: () => setRail(!rail()) },
    { keys: "Ctrl+k", name: "Command palette", run: () => setPalette(!palette()), hidden: true },
  ]);

  /** The conversation's `…` menu: its actions in the order people reach for them, each with its key. */
  const MENU_KEYS = ["r", "Enter", "f", "v", "e", "h", "s", "u", "m", "!", "#", "O"];
  const menu = () => {
    const all = bindings();
    const items: MenuItem[] = MENU_KEYS.flatMap((k) => {
      const b = all.find((b) => b.keys === k && (!b.context || b.context === "conversation"));
      if (!b || (k === "v" && !messages.some((m) => m.attachments.length))) return [];
      return [{ name: b.name, keys: keyLabel(b.keys), run: () => void b.run() }];
    });
    items.splice(items.findIndex((i) => i.name === "Mark as spam"), 0, { name: "Move to …", run: () => void choose("Move to …") });
    return items;
  };

  const commands = createMemo<Command[]>(() => [
    ...bindings()
      .filter((b) => !b.hidden && !b.keys.startsWith("Ctrl+,") && b.keys !== "g l" && (!b.context || b.context === context()))
      .map((b) => ({
        name: b.name,
        keys: keyLabel(b.keys),
        group: b.keys.startsWith("g ") ? "Go to" : "Actions",
        run: () => void b.run(),
      })),
    ...(settings.splitInbox
      ? [
          { name: "Move sender to Other", group: "Actions", run: () => void moveToSplit(true) },
          { name: "Move sender to Important", group: "Actions", run: () => void moveToSplit(false) },
        ]
      : []),
    {
      name: "Move to …",
      group: "Actions",
      args: () => {
        // Folders of the accounts the conversations are in, except where they are now.
        const hit = targets();
        const accountIds = new Set(hit.map((r) => r.accountId));
        const here = new Set(hit.map((r) => r.folderId));
        return folders()
          .filter((f) => accountIds.has(f.accountId) && !here.has(f.id))
          .map((f) => ({
            name: accounts().length > 1 ? `${folderName(f)} — ${accountOf(f.accountId)}` : folderName(f),
            run: () => void act({ moveTo: f.id }),
          }));
      },
    },
    {
      name: "Go to folder …",
      keys: keyLabel("g l"),
      group: "Go to",
      args: () =>
        folders().map((f) => ({
          name: accounts().length > 1 ? `${folderName(f)} — ${accountOf(f.accountId)}` : folderName(f),
          run: () => go({ folder: f.id }),
        })),
    },
    {
      name: "Switch account …",
      keys: "Ctrl 1–9",
      group: "Accounts",
      args: () => accounts().map((a, i) => ({ name: a.email, keys: `Ctrl ${i + 1}`, run: () => switchAccount(i) })),
    },
    {
      name: "Theme …",
      group: "Settings",
      args: () =>
        (["system", "light", "dark"] as const).map((t) => ({
          name: t === "system" ? "Follow the system" : t === "light" ? "Light" : "Dark",
          run: () => setSetting("theme", t),
        })),
    },
    { name: "Settings", keys: keyLabel("Ctrl+,"), group: "Settings", run: () => setSettingsOpen("Appearance") },
    ...(openRow() && openMuted() ? [{ name: "Unmute conversation", group: "Actions", run: () => void unmute() }] : []),
    { name: "Add account", group: "Accounts", run: () => setSetup(true) },
    ...(problems().length || late().length
      ? [{ name: problems().length ? "Review changes that didn't go through" : "Review changes waiting to go out", run: () => setReviewing(true) }]
      : []),
    ...folders().map((f) => ({
      group: "Go to",
      name: `Go to ${ROLE_NAMES[f.role] ?? f.name} — ${accounts().find((a) => a.id === f.accountId)?.email ?? ""}`,
      run: () => go({ folder: f.id }),
    })),
  ]);

  const handleKey = keyHandler(bindings, context, dialog);
  let idleTimer: number | undefined;
  const onKeyDown = (e: KeyboardEvent) => {
    timeKey(e);
    setIdle(false);
    clearTimeout(idleTimer);
    idleTimer = window.setTimeout(() => setIdle(true), 2000);
    handleKey(e);
  };
  onMount(() => {
    window.addEventListener("keydown", onKeyDown);
    idleTimer = window.setTimeout(() => setIdle(true), 2000);
  });
  onCleanup(() => window.removeEventListener("keydown", onKeyDown));

  /** The three most useful keys where the keyboard is now. */
  const hints = () =>
    context() === "conversation"
      ? [["R", "reply"], ["E", "done"], ["Esc", "back"]]
      : rows().length
        ? [["Enter", "open"], ["E", "done"], ["Ctrl K", "commands"]]
        : [["C", "compose"], ["?", "shortcuts"], ["Ctrl K", "commands"]];

  const onSearchKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      setQuery("");
      searchInput.blur();
    } else if (e.key === "Enter" || e.key === "ArrowDown") {
      e.preventDefault();
      searchInput.blur();
    }
  };

  // MARK: Layout

  const isTarget = (t: Target) => JSON.stringify(t) === JSON.stringify(target()) && !query();
  const title = () => {
    if (searching()) return `Search: ${query()}`;
    const t = target();
    if ("role" in t) return t.role === "inbox" ? "Inbox" : t.role === "starred" ? "Starred" : ROLE_NAMES[t.role] ?? t.role;
    const f = folders().find((f) => f.id === t.folder);
    return f ? ROLE_NAMES[f.role] ?? f.name : "";
  };
  const roomForSplit = () =>
    settings.openMode === "full"
      ? false
      : width() >= (settings.openMode === "split" ? MIN_SPLIT_WIDTH : SPLIT_WIDTH);
  const split = () => openRow() !== null && roomForSplit();
  const inboxUnread = () => folders().filter((f) => f.role === "inbox").reduce((n, f) => n + f.unread, 0);
  /** The unread count a split's tab shows; Starred shows none. */
  const tabUnread = (t: Target) => {
    const role = "role" in t ? t.role : "";
    return role === "important" ? splitUnread()[0] : role === "bulk" ? splitUnread()[1] : role === "inbox" ? inboxUnread() : 0;
  };
  /** Inbox Zero's colour changes with the day, so it stays a small reward. */
  const zeroHue = () => {
    const now = new Date();
    const day = Math.floor((now.getTime() - new Date(now.getFullYear(), 0, 0).getTime()) / 86_400_000);
    return (day * 47) % 360;
  };
  const inboxZero = () => ready() && !searching() && rows().length === 0 && "role" in target() && (target() as { role: string }).role === "inbox";

  /** One sentence for every account together, naming the account when only some are in trouble. */
  const syncSentence = () => {
    const entries = Object.entries(syncStates());
    const several = entries.length > 1;
    const inState = (s: SyncState) =>
      entries.filter(([, state]) => state === s).map(([id]) => accounts().find((a) => a.id === Number(id)));
    const refused = inState("auth-failed");
    if (refused.length) {
      const who = several && refused.length === 1 && refused[0] ? refused[0].email : "The server";
      return { text: `${who} refused the password. Open accounts with Ctrl+\\.`, tone: "danger" };
    }
    const unreachable = inState("offline");
    if (unreachable.length) {
      if (!online() || (several && unreachable.length === entries.length))
        return { text: "Offline. Changes are kept and go out when you're back.", tone: "warn" };
      const host = unreachable.length === 1 && unreachable[0] ? unreachable[0].imapHost : "the mail server";
      return { text: `Can't reach ${host}. Trying again.`, tone: "warn" };
    }
    if (entries.some(([, s]) => s === "connecting")) return { text: "Connecting…", tone: "warn" };
    return { text: entries.length ? "Up to date" : "", tone: "ok" };
  };

  return (
    <div class="app" classList={{ split: split(), full: openRow() !== null && !roomForSplit() }}>
      <main class="list-pane">
        <header class="list-header">
          <button
            class="link rail-button"
            onClick={() => setRail(true)}
            title="Accounts and folders (Ctrl+\)"
            aria-label="Accounts and folders"
          >
            <Icon name="menu" size={18} />
          </button>
          <Show when={splitIndex() >= 0 && !searching()} fallback={<h2>{title()}</h2>}>
            <nav class="splits" role="tablist">
              <For each={SPLITS()}>
                {(s, i) => (
                  <button role="tab" aria-selected={i() === splitIndex()} classList={{ active: i() === splitIndex() }} onClick={() => go(s.target)}>
                    {s.name}
                    <Show when={tabUnread(s.target)}>
                      <span class="count">{tabUnread(s.target)}</span>
                    </Show>
                  </button>
                )}
              </For>
            </nav>
          </Show>
          <input
            ref={searchInput}
            class="search"
            placeholder="Search   /"
            value={query()}
            onInput={(e) => setQuery(e.currentTarget.value)}
            onKeyDown={onSearchKey}
          />
          <button class="link" title="Command palette" onClick={() => setPalette(true)}>
            <kbd>Ctrl K</kbd>
          </button>
        </header>
        <Show when={searching() && partial()}>
          <div class="search-note">Older mail without its text downloaded was searched by sender and subject only.</div>
        </Show>
        <Show
          when={rows().length}
          fallback={
            <Show
              when={inboxZero()}
              fallback={
                <Show when={searching()} fallback={<div class="empty">{ready() ? "Nothing here." : ""}</div>}>
                  <div class="empty search-help">
                    <p>Nothing found.</p>
                    <p>
                      Search also takes filters: <code>from:</code> <code>to:</code> <code>subject:</code> <code>is:unread</code>{" "}
                      <code>is:starred</code> <code>has:attachment</code> <code>in:sent</code>{" "}
                      <code>before:2026-01-31</code> <code>newer_than:7d</code> <code>larger:5m</code>. Quote a
                      phrase, put <code>-</code> before what to leave out, <code>OR</code> between words for either.
                    </p>
                  </div>
                </Show>
              }
            >
              <div class="zero" style={{ "--zero-hue": String(zeroHue()) }}>
                <div class="zero-time">{new Date().toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}</div>
                <div>You're done.</div>
              </div>
            </Show>
          }
        >
          <VirtualList items={rows()} rowHeight={ROW_HEIGHTS[settings.density]} selected={focus()} onEnd={loadMore}>
            {(row, index) => (
              <ConversationRow
                row={row}
                focused={index() === focus()}
                selected={selection().has(keyOf(row))}
                narrow={split()}
                onClick={(e) => {
                  setFocus(index());
                  if (e.shiftKey || e.ctrlKey || e.metaKey) toggleSelected(row);
                  else if (openRow()) void open(row);
                }}
                onOpen={() => open(row)}
              />
            )}
          </VirtualList>
        </Show>
        <footer class="status">
          <span class={`sync ${syncSentence().tone}`}>
            <span class="dot" />
            {syncSentence().text}
          </span>
          <Show when={late().length}>
            <button class="link waiting-link" onClick={() => setReviewing(true)}>
              {late().length === 1 ? "1 change waiting" : `${late().length} changes waiting`}
            </button>
          </Show>
          <Show when={problems().length}>
            <button class="link problems-link" onClick={() => setReviewing(true)}>
              {problems().length === 1 ? "1 change didn't go through" : `${problems().length} changes didn't go through`}
            </button>
          </Show>
          <Show when={selection().size}>
            <span class="selected-count">{selection().size} selected</span>
          </Show>
          <span class="spacer" />
          <Show when={!toast() && idle()}>
            <span class="hints">
              <For each={hints()}>
                {([k, what]) => (
                  <span>
                    <kbd>{k}</kbd> {what}
                  </span>
                )}
              </For>
            </span>
          </Show>
          <Show when={toast()}>
            {(t) => (
              <span class="toast" role="status">
                <span>{t().text}</span>
                <Show when={t().token.length || t().undo}>
                  <button class="link" onClick={undo}>
                    Undo <kbd>Z</kbd>
                  </button>
                </Show>
              </span>
            )}
          </Show>
        </footer>
      </main>

      <Show when={openRow()}>
        <section class="conversation-pane">
          <ConversationView
            messages={messages}
            focused={messageFocus()}
            expanded={(id) => expanded().has(id)}
            onToggle={toggleMessage}
            onReply={(m) => respond(m, "reply")}
            onView={(message, index) => setViewing({ message, index })}
            onDone={() => act("archive")}
            onClose={close}
            menu={menu}
            person={person}
          />
          <Show when={compose()?.inline ? compose() : null}>
            {(init) => (
              <div class="inline-reply">
                <Compose accounts={accounts()} init={init()} onSend={send} onClose={composeClosed} onDiscard={composeDiscarded} />
              </div>
            )}
          </Show>
        </section>
      </Show>

      <Show when={rail()}>
        <Rail
          accounts={accounts()}
          folders={folders()}
          syncStates={syncStates()}
          isTarget={isTarget}
          onGo={go}
          onAddAccount={() => setSetup(true)}
          onClose={() => setRail(false)}
        />
      </Show>
      <Show when={reviewing()}>
        <ProblemsDialog
          problems={problems()}
          waiting={late()}
          offline={!online() || Object.values(syncStates()).includes("offline")}
          now={clock()}
          onDiscardWaiting={(id) =>
            void api.discardWaiting(id).then((done) => {
              if (!done) showToast("It went out, or later changes depend on it, so it stays.", []);
              void refresh();
            })
          }
          onRetry={(id) => void api.retryProblem(id).then(refresh)}
          onDiscard={(id) => void api.discardProblem(id).then(refresh)}
          onEdit={(id) => void api.problemToDraft(id).then((record) => (setReviewing(false), resume(record), refresh()))}
          onClose={() => setReviewing(false)}
        />
      </Show>
      <Show when={settingsOpen()}>
        {(section) => <SettingsPage accounts={accounts()} section={section()} onClose={() => setSettingsOpen(null)} />}
      </Show>
      <Show when={perf()}>
        <PerfOverlay />
      </Show>
      <Show when={sheet()}>
        <ShortcutSheet bindings={bindings()} onClose={() => setSheet(false)} />
      </Show>
      <Show when={viewing()}>
        {(v) => <AttachmentViewer message={v().message} index={v().index} onClose={() => setViewing(null)} />}
      </Show>
      <Show when={snoozing()}>
        {(hit) => <SnoozePicker count={hit().length} onPick={(due) => void snoozeUntil(due)} onClose={() => setSnoozing(null)} />}
      </Show>
      <Show when={palette()}>
        <CommandBar
          commands={commands()}
          start={paletteStart()}
          onClose={() => batch(() => (setPalette(false), setPaletteStart(undefined)))}
        />
      </Show>
      <Show when={compose() && !compose()!.inline ? compose() : null}>
        {(init) => <Compose accounts={accounts()} init={init()} onSend={send} onClose={composeClosed} onDiscard={composeDiscarded} />}
      </Show>
      <Show when={setup() || (ready() && accounts().length === 0)}>
        <AccountSetup
          onAdded={() => (setSetup(false), void refresh())}
          onClose={accounts().length ? () => setSetup(false) : undefined}
        />
      </Show>
    </div>
  );
}
