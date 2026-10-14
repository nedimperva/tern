import { batch, createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { api, type Account, type Action, type Folder, type MessageRow as Row, type OutboxProblem, type SyncState, type Target, type ThreadMessage } from "./api";
import { AccountSetup } from "./components/AccountSetup";
import { ProblemsDialog, ProblemsStrip } from "./components/Problems";
import { CommandBar, type Command } from "./components/CommandBar";
import { Compose, type ComposeInit } from "./components/Compose";
import { MessageRow } from "./components/MessageRow";
import { ThreadView } from "./components/ThreadView";
import { VirtualList } from "./components/VirtualList";

const PAGE = 100;
const ROW_HEIGHT = 64;
const UNDO_MS = 5000;
/// How long a message has to stay open before it counts as read.
const READ_AFTER_MS = 800;

const ROLE_NAMES: Record<string, string> = {
  inbox: "Inbox",
  archive: "Archive",
  all: "All Mail",
  sent: "Sent",
  drafts: "Drafts",
  junk: "Junk",
  trash: "Trash",
};

/** Said next to the account only when it is not simply working: up to date or syncing shows nothing. */
const SYNC_LABELS: Partial<Record<SyncState, string>> = {
  connecting: "Connecting…",
  offline: "Offline",
  "auth-failed": "Sign-in failed",
};

export default function App() {
  const [accounts, setAccounts] = createSignal<Account[]>([]);
  const [syncStates, setSyncStates] = createSignal<Record<number, SyncState>>({});
  const [folders, setFolders] = createSignal<Folder[]>([]);
  const [target, setTarget] = createSignal<Target>({ role: "inbox" });
  const [rows, setRows] = createSignal<Row[]>([]);
  const [selected, setSelected] = createSignal(0);
  const [query, setQuery] = createSignal("");
  // Sync reloads the open thread on every change. Reconciling by id keeps unchanged messages as they are, so their
  // HTML frames are not rebuilt (which flickered, most visibly on Windows).
  const [thread, setThreadStore] = createStore<ThreadMessage[]>([]);
  const setThread = (t: ThreadMessage[]) => setThreadStore(reconcile(t, { key: "id" }));
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

  const current = () => rows()[selected()];
  const overlay = () => reviewing() || palette() || compose() !== null || setup();

  // MARK: Loading

  /// Reloads the list. Keeps as many rows as are loaded, so a change from sync never makes the list jump.
  async function load() {
    const ticket = ++generation;
    const q = query().trim();
    const page = q ? await api.search(q, 500) : await api.list(target(), null, Math.max(PAGE, rows().length));
    if (ticket !== generation) return;
    exhausted = q !== "" || page.length < PAGE;
    batch(() => {
      setRows(page);
      setSelected(Math.min(selected(), Math.max(0, page.length - 1)));
    });
  }

  async function loadMore() {
    const last = rows()[rows().length - 1];
    if (exhausted || !last || query().trim()) return;
    exhausted = true;
    const ticket = generation;
    const page = await api.list(target(), { date: last.date, id: last.id }, PAGE);
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

  // Sync can report many changes a second; draw once per frame at most.
  let pending = false;
  const onChange = () => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      void refresh();
      const open = current();
      if (open) void api.thread(open.id).then(setThread);
    });
  };

  onMount(() => {
    api.onSyncState((id, state) => setSyncStates({ ...syncStates(), [id]: state }));
    void api.syncStates().then((s) => setSyncStates({ ...s, ...syncStates() }));
    api.onChange(onChange);
    void refresh();
  });

  createEffect(on([target, query], () => {
    setSelected(0);
    void load();
  }, { defer: true }));

  // The reading pane follows the selection; a message that stays open is marked read.
  let readTimer: number | undefined;
  createEffect(on(() => current()?.id, (id) => {
    clearTimeout(readTimer);
    if (id == null) return setThread([]);
    void api.thread(id).then((t) => current()?.id === id && setThread(t));
    if (!current()!.seen) readTimer = window.setTimeout(() => act("markRead", false), READ_AFTER_MS);
  }));

  // MARK: Actions

  const LABELS: Record<Action, string> = {
    archive: "Archived",
    trash: "Moved to Trash",
    markRead: "Marked read",
    markUnread: "Marked unread",
    star: "Starred",
    unstar: "Unstarred",
  };

  /// Shows the change at once, then tells the engine. Every action can be undone for five seconds.
  async function act(action: Action, announce = true) {
    const row = current();
    if (!row) return;
    if (action === "archive" || action === "trash") {
      setRows(rows().filter((r) => r.id !== row.id));
      setSelected(Math.min(selected(), Math.max(0, rows().length - 1)));
    } else {
      const patch: Partial<Row> =
        action === "markRead" ? { seen: true } : action === "markUnread" ? { seen: false } : { flagged: action === "star" };
      setRows(rows().map((r) => (r.id === row.id ? { ...r, ...patch } : r)));
    }
    try {
      const applied = await api.apply([row.id], action);
      if (announce) showToast(LABELS[action], applied.token);
    } catch (e) {
      showToast(String(e), []);
      void load();
    }
  }

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

  function reply(m: ThreadMessage) {
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
  const move = (by: number) => setSelected(Math.max(0, Math.min(rows().length - 1, selected() + by)));

  // MARK: Keyboard (Gmail's keys)

  const commands = createMemo<Command[]>(() => [
    { name: "Compose", keys: "c", run: () => setCompose({}) },
    { name: "Search", keys: "/", run: () => searchInput.focus() },
    { name: "Reply", keys: "r", run: () => thread.length && reply(thread[thread.length - 1]) },
    { name: "Archive", keys: "e", run: () => act("archive") },
    { name: "Move to Trash", keys: "#", run: () => act("trash") },
    { name: "Mark as read", keys: "Shift I", run: () => act("markRead") },
    { name: "Mark as unread", keys: "Shift U", run: () => act("markUnread") },
    { name: "Star / unstar", keys: "s", run: () => act(current()?.flagged ? "unstar" : "star") },
    { name: "Undo", keys: "z", run: undo },
    { name: "Go to All Inboxes", keys: "g i", run: () => go({ role: "inbox" }) },
    { name: "Add account", run: () => setSetup(true) },
    ...(problems().length ? [{ name: "Review changes that didn't go through", run: () => setReviewing(true) }] : []),
    ...folders().map((f) => ({
      name: `Go to ${ROLE_NAMES[f.role] ?? f.name} — ${accounts().find((a) => a.id === f.accountId)?.email ?? ""}`,
      run: () => go({ folder: f.id }),
    })),
  ]);

  let lastKey = "";
  const onKeyDown = (e: KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      setPalette(!palette());
      return;
    }
    const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement;
    if (typing || overlay() || e.ctrlKey || e.metaKey || e.altKey) return;
    const chord = lastKey === "g" ? `g ${e.key}` : e.key;
    lastKey = e.key;
    const handlers: Record<string, () => unknown> = {
      j: () => move(1),
      ArrowDown: () => move(1),
      k: () => move(-1),
      ArrowUp: () => move(-1),
      PageDown: () => move(10),
      PageUp: () => move(-10),
      Home: () => setSelected(0),
      End: () => setSelected(rows().length - 1),
      e: () => act("archive"),
      "#": () => act("trash"),
      Delete: () => act("trash"),
      s: () => act(current()?.flagged ? "unstar" : "star"),
      I: () => act("markRead"),
      U: () => act("markUnread"),
      z: undo,
      c: () => setCompose({}),
      r: () => thread.length && reply(thread[thread.length - 1]),
      "/": () => searchInput.focus(),
      Escape: () => query() && setQuery(""),
      "g i": () => go({ role: "inbox" }),
    };
    const handler = handlers[chord] ?? handlers[e.key];
    if (handler) {
      e.preventDefault();
      handler();
    }
  };
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
  const inboxUnread = () => folders().filter((f) => f.role === "inbox").reduce((n, f) => n + f.unread, 0);
  const title = () => {
    if (query()) return `Search: ${query()}`;
    const t = target();
    if ("role" in t) return t.role === "inbox" ? "All Inboxes" : ROLE_NAMES[t.role] ?? t.role;
    const f = folders().find((f) => f.id === t.folder);
    return f ? ROLE_NAMES[f.role] ?? f.name : "";
  };

  return (
    <div class="app">
      <nav class="sidebar">
        <button class="compose-button" onClick={() => setCompose({})}>
          Compose <kbd>c</kbd>
        </button>
        <a classList={{ active: isTarget({ role: "inbox" }) }} onClick={() => go({ role: "inbox" })}>
          <span>All Inboxes</span>
          <Show when={inboxUnread()}>
            <span class="count">{inboxUnread()}</span>
          </Show>
        </a>
        <For each={accounts()}>
          {(account) => (
            <section>
              <h3>
                <span>{account.email}</span>
                <Show when={SYNC_LABELS[syncStates()[account.id]]}>
                  {(label) => <span class={`sync-state ${syncStates()[account.id]}`}>{label()}</span>}
                </Show>
              </h3>
              <For each={folders().filter((f) => f.accountId === account.id)}>
                {(f) => (
                  <a classList={{ active: isTarget({ folder: f.id }) }} onClick={() => go({ folder: f.id })}>
                    <span>{ROLE_NAMES[f.role] ?? f.name}</span>
                    <Show when={f.unread && f.role !== "trash" && f.role !== "junk"}>
                      <span class="count">{f.unread}</span>
                    </Show>
                  </a>
                )}
              </For>
            </section>
          )}
        </For>
        <button class="link add-account" onClick={() => setSetup(true)}>
          + Add account
        </button>
      </nav>

      <main class="list-pane">
        <header class="list-header">
          <input
            ref={searchInput}
            class="search"
            placeholder="Search mail   /"
            value={query()}
            onInput={(e) => setQuery(e.currentTarget.value)}
            onKeyDown={onSearchKey}
          />
          <div class="list-title">
            <span>{title()}</span>
            <button class="link" title="Command bar" onClick={() => setPalette(true)}>
              <kbd>Ctrl K</kbd>
            </button>
          </div>
        </header>
        <Show when={rows().length} fallback={<div class="empty">{ready() ? "Nothing here." : ""}</div>}>
          <VirtualList items={rows()} rowHeight={ROW_HEIGHT} selected={selected()} onEnd={loadMore}>
            {(row, index) => <MessageRow row={row} selected={index() === selected()} onClick={() => setSelected(index())} />}
          </VirtualList>
        </Show>
        <Show when={problems().length}>
          <ProblemsStrip count={problems().length} onOpen={() => setReviewing(true)} />
        </Show>
      </main>

      <section class="reading-pane">
        <Show when={thread.length} fallback={<div class="empty">No message selected</div>}>
          <ThreadView messages={thread} onReply={reply} />
        </Show>
      </section>

      <Show when={toast()}>
        {(t) => (
          <div class="toast">
            <span>{t().text}</span>
            <Show when={t().token.length}>
              <button onClick={undo}>
                Undo <kbd>z</kbd>
              </button>
            </Show>
          </div>
        )}
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
