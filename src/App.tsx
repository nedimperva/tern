import { batch, createEffect, createMemo, createSignal, on, onCleanup, onMount, Show } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import {
  api,
  type Account,
  type Action,
  type Folder,
  type MessageRow,
  type OutboxProblem,
  type SyncState,
  type Target,
  type ThreadMessage,
  type ThreadRow,
} from "./api";
import { AccountSetup } from "./components/AccountSetup";
import { CommandBar, type Command } from "./components/CommandBar";
import { Compose, type ComposeInit } from "./components/Compose";
import { ConversationRow } from "./components/ConversationRow";
import { ConversationView } from "./components/ConversationView";
import { ProblemsDialog } from "./components/Problems";
import { Rail, ROLE_NAMES } from "./components/Rail";
import { VirtualList } from "./components/VirtualList";
import { keyHandler, keyLabel, type Binding, type Context } from "./keys";

const PAGE = 100;
const ROW_HEIGHT = 36;
const UNDO_MS = 5000;
/** How long a conversation has to stay open before it counts as read. */
const READ_AFTER_MS = 1000;
/** From this width an open conversation sits beside the list; narrower, it covers it. */
const SPLIT_WIDTH = 1200;

/** A conversation's identity across reloads: its newest message, and so the row's id, changes as mail arrives. */
const keyOf = (r: MessageRow) => `${r.accountId}:${r.threadId}`;

/** A search hit shown like a conversation row. */
const asRow = (m: MessageRow): ThreadRow => ({
  ...m,
  count: 1,
  unread: m.seen ? 0 : 1,
  participants: [m.fromName || m.fromAddr],
});

const DONE: Record<Action, string> = {
  archive: "Archived",
  trash: "Moved to Trash",
  markRead: "Marked read",
  markUnread: "Marked unread",
  star: "Starred",
  unstar: "Unstarred",
};

export default function App() {
  const [accounts, setAccounts] = createSignal<Account[]>([]);
  const [syncStates, setSyncStates] = createSignal<Record<number, SyncState>>({});
  const [folders, setFolders] = createSignal<Folder[]>([]);
  const [target, setTarget] = createSignal<Target>({ role: "inbox" });
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
  const [wide, setWide] = createSignal(window.innerWidth >= SPLIT_WIDTH);
  const [rail, setRail] = createSignal(false);
  const [toast, setToast] = createSignal<{ text: string; token: number[] } | null>(null);
  const [compose, setCompose] = createSignal<ComposeInit | null>(null);
  const [palette, setPalette] = createSignal(false);
  const [setup, setSetup] = createSignal(false);
  const [ready, setReady] = createSignal(false);
  const [problems, setProblems] = createSignal<OutboxProblem[]>([]);
  const [reviewing, setReviewing] = createSignal(false);
  let searchInput!: HTMLInputElement;
  let exhausted = false;
  let generation = 0;

  const current = () => rows()[focus()];
  const context = (): Context => (openRow() ? "conversation" : "list");
  const dialog = () => reviewing() || palette() || compose() !== null || setup() || rail();
  const searching = () => query().trim() !== "";

  // MARK: Loading

  /** Reloads the list. Keeps as many rows as are loaded, so a change from sync never makes the list jump. */
  async function load() {
    const ticket = ++generation;
    const q = query().trim();
    const page = q
      ? (await api.search(q, 500)).map(asRow)
      : await api.listThreads(target(), null, Math.max(PAGE, rows().length));
    if (ticket !== generation) return;
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
    const [a, f, p] = await Promise.all([api.accounts(), api.folders(), api.problems()]);
    batch(() => {
      setAccounts(a);
      setFolders(f);
      setProblems(p);
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
    api.onSyncState((id, state) => setSyncStates({ ...syncStates(), [id]: state }));
    void api.syncStates().then((s) => setSyncStates({ ...s, ...syncStates() }));
    api.onChange(onChange);
    const onResize = () => setWide(window.innerWidth >= SPLIT_WIDTH);
    window.addEventListener("resize", onResize);
    onCleanup(() => window.removeEventListener("resize", onResize));
    void refresh();
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
    setOpenRow(row);
    const found = await api.thread(row.id);
    if (openRow() !== row) return;
    batch(() => {
      setMessages(found);
      // The newest message and anything unread start open, as they are what there is to read.
      setExpanded(new Set(found.filter((m, i) => !m.seen || i === found.length - 1).map((m) => m.id)));
      setMessageFocus(Math.max(0, found.length - 1));
    });
    if (row.unread > 0) {
      readTimer = window.setTimeout(() => {
        if (openRow() === row) void act("markRead", [row], false);
      }, READ_AFTER_MS);
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

  /** Shows the change at once, then tells the engine. Every action can be undone for five seconds. */
  async function act(action: Action, hit = targets(), announce = true) {
    if (!hit.length) return;
    const keys = new Set(hit.map(keyOf));
    if (action === "archive" || action === "trash") {
      // Focus moves to the next row, which takes the place of the first one removed.
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
      if (announce) showToast(hit.length === 1 ? DONE[action] : `${DONE[action]} ${hit.length} conversations`, token);
    } catch (e) {
      showToast(String(e), []);
      void load();
    }
  }

  /** Star when any of the targets lacks one, else take the stars off. */
  const toggleStar = () => act(targets().every((r) => r.flagged) ? "unstar" : "star");
  /** Mark read when anything is unread, else mark unread. */
  const toggleRead = () => act(targets().some((r) => r.unread > 0) ? "markRead" : "markUnread");

  let toastTimer: number | undefined;
  function showToast(text: string, token: number[]) {
    clearTimeout(toastTimer);
    setToast({ text, token });
    toastTimer = window.setTimeout(() => setToast(null), UNDO_MS);
  }

  async function undo() {
    const t = toast();
    if (!t?.token.length) return;
    setToast(null);
    const undone = await api.undo(t.token);
    if (!undone) showToast("Too late to undo", []);
    void load();
  }

  function reply(m: ThreadMessage | undefined) {
    if (!m) return;
    const quoted = (m.bodyText ?? "").split("\n").map((l) => `> ${l}`).join("\n");
    setCompose({
      accountId: m.accountId,
      to: m.fromAddr,
      subject: /^re:/i.test(m.subject) ? m.subject : `Re: ${m.subject}`,
      body: `\n\nOn ${new Date(m.date * 1000).toLocaleString()}, ${m.fromName || m.fromAddr} wrote:\n${quoted}`,
      inReplyTo: m.messageId,
    });
  }

  async function send(accountId: number, draft: Parameters<typeof api.send>[1]) {
    setCompose(null);
    try {
      showToast("Sending…", await api.send(accountId, draft));
    } catch (e) {
      showToast(String(e), []);
    }
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
    { keys: "Enter", name: "Expand or collapse message", context: "conversation", run: () => toggleMessage(messageFocus()), hidden: true },
    { keys: "O", name: "Expand all messages", context: "conversation", run: () => setExpanded(new Set(messages.map((m) => m.id))) },
    { keys: "r", name: "Reply", context: "conversation", run: () => reply(messages[messageFocus()]) },
    { keys: "z", name: "Undo", run: undo },
    { keys: "c", name: "Compose", run: () => setCompose({}) },
    { keys: "/", name: "Search", run: () => searchInput.focus() },
    { keys: "g i", name: "Go to All Inboxes", run: () => go({ role: "inbox" }) },
    { keys: "Ctrl+\\", name: "Accounts and folders", run: () => setRail(!rail()) },
    { keys: "Ctrl+k", name: "Command palette", run: () => setPalette(!palette()), hidden: true },
  ]);

  const commands = createMemo<Command[]>(() => [
    ...bindings()
      .filter((b) => !b.hidden && (!b.context || b.context === context()))
      .map((b) => ({ name: b.name, keys: keyLabel(b.keys), run: () => void b.run() })),
    { name: "Add account", run: () => setSetup(true) },
    ...(problems().length ? [{ name: "Review changes that didn't go through", run: () => setReviewing(true) }] : []),
    ...folders().map((f) => ({
      name: `Go to ${ROLE_NAMES[f.role] ?? f.name} — ${accounts().find((a) => a.id === f.accountId)?.email ?? ""}`,
      run: () => go({ folder: f.id }),
    })),
  ]);

  const onKeyDown = keyHandler(bindings, context, dialog);
  onMount(() => window.addEventListener("keydown", onKeyDown));
  onCleanup(() => window.removeEventListener("keydown", onKeyDown));

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
    if ("role" in t) return t.role === "inbox" ? "All Inboxes" : ROLE_NAMES[t.role] ?? t.role;
    const f = folders().find((f) => f.id === t.folder);
    return f ? ROLE_NAMES[f.role] ?? f.name : "";
  };
  const split = () => openRow() !== null && wide();
  const inboxZero = () => ready() && !searching() && rows().length === 0 && "role" in target() && (target() as { role: string }).role === "inbox";

  /** One sentence for every account together; the rail names the account in trouble. */
  const syncSentence = () => {
    const states = Object.values(syncStates());
    if (states.includes("auth-failed")) return { text: "Sign-in failed. Open accounts with Ctrl+\\.", tone: "danger" };
    if (states.includes("offline")) return { text: "Offline. Changes wait and go out when back.", tone: "warn" };
    if (states.includes("connecting")) return { text: "Connecting…", tone: "warn" };
    return { text: states.length ? "Up to date" : "", tone: "ok" };
  };

  return (
    <div class="app" classList={{ split: split(), full: openRow() !== null && !wide() }}>
      <main class="list-pane">
        <header class="list-header">
          <button class="link rail-button" onClick={() => setRail(true)} title="Accounts and folders (Ctrl+\)">
            ☰
          </button>
          <h2>{title()}</h2>
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
        <Show
          when={rows().length}
          fallback={
            <Show when={inboxZero()} fallback={<div class="empty">{ready() ? "Nothing here." : ""}</div>}>
              <div class="zero">
                <div class="zero-time">{new Date().toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}</div>
                <div>You're done.</div>
              </div>
            </Show>
          }
        >
          <VirtualList items={rows()} rowHeight={ROW_HEIGHT} selected={focus()} onEnd={loadMore}>
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
          <Show when={problems().length}>
            <button class="link problems-link" onClick={() => setReviewing(true)}>
              {problems().length === 1 ? "1 change didn't go through" : `${problems().length} changes didn't go through`}
            </button>
          </Show>
          <Show when={selection().size}>
            <span class="selected-count">{selection().size} selected</span>
          </Show>
          <span class="spacer" />
          <Show when={toast()}>
            {(t) => (
              <span class="toast" role="status">
                <span>{t().text}</span>
                <Show when={t().token.length}>
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
            onReply={reply}
            onDone={() => act("archive")}
            onClose={close}
          />
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
          onRetry={(id) => void api.retryProblem(id).then(refresh)}
          onDiscard={(id) => void api.discardProblem(id).then(refresh)}
          onClose={() => setReviewing(false)}
        />
      </Show>
      <Show when={palette()}>
        <CommandBar commands={commands()} onClose={() => setPalette(false)} />
      </Show>
      <Show when={compose()}>
        {(init) => <Compose accounts={accounts()} init={init()} onSend={send} onClose={() => setCompose(null)} />}
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
