import { createSignal, For, type JSX, onCleanup, onMount, Show } from "solid-js";
import type { Account, Folder, SyncState, Target } from "../api";
import { labelColour } from "../colours";
import { folderTree, holds, type TreeNode, unreadUnder } from "../folderTree";
import { AccountAvatar } from "./AccountAvatar";
import { Icon } from "./Icon";

export const ROLE_NAMES: Record<string, string> = {
  inbox: "Inbox",
  archive: "Archive",
  all: "All Mail",
  sent: "Sent",
  drafts: "Drafts",
  junk: "Junk",
  trash: "Trash",
  important: "Important",
  bulk: "Other",
  snoozed: "Snoozed",
  later: "Read later",
  marked: "Marks",
  starred: "Starred",
};

/** Where a folder in the rail or the palette goes: a Gmail label lists All Mail's messages with it. */
export const targetOf = (f: Folder): Target => (f.role === "label" ? { label: f.id } : { folder: f.id });

/** Said next to the account only when it is not simply working: up to date or syncing shows nothing. */
const SYNC_LABELS: Partial<Record<SyncState, string>> = {
  connecting: "Connecting…",
  offline: "Offline",
  "auth-failed": "Sign-in failed",
};

/** The folders an account always shows, in this order; the rest wait under "More". */
const MAIN_ROLES = ["inbox", "drafts", "sent", "archive"];
/** Folders whose unread count says nothing worth a glance. */
const UNCOUNTED = new Set(["drafts", "sent", "archive", "all", "junk", "trash"]);

// Which groups are open, kept on this computer: accounts start open, "More" starts closed, labels start open while
// there are few of them.
const FOLDS_KEY = "tern.rail.folds";
const [folds, setFolds] = createSignal<Record<string, boolean>>(
  (() => {
    try {
      return JSON.parse(localStorage.getItem(FOLDS_KEY) ?? "{}");
    } catch {
      return {};
    }
  })(),
);
const isOpen = (key: string, byDefault: boolean) => folds()[key] ?? byDefault;
const toggle = (key: string, byDefault: boolean) => {
  const next = { ...folds(), [key]: !isOpen(key, byDefault) };
  setFolds(next);
  try {
    localStorage.setItem(FOLDS_KEY, JSON.stringify(next));
  } catch {
    // No storage: the groups fold until the window reloads.
  }
};

/** Accounts and folders: the sidebar docked beside the list, or sliding over it from the left (Ctrl+\) when there
 * is no room for it or it is turned off. */
export function Rail(props: {
  /** Beside the list, open until hidden: going somewhere leaves it open and Esc is the list's. */
  docked: boolean;
  onCompose: () => void;
  onSettings: () => void;
  accounts: Account[];
  folders: Folder[];
  syncStates: Record<number, SyncState>;
  isTarget: (t: Target) => boolean;
  onGo: (t: Target) => void;
  onAddAccount: () => void;
  onClose: () => void;
  /** Saved searches, the one running now, and what to do with one. */
  searches: string[];
  searching: string;
  onSearch: (query: string) => void;
  onForget: (query: string) => void;
}) {
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      props.onClose();
    }
  };
  onMount(() => !props.docked && window.addEventListener("keydown", onKey, true));
  onCleanup(() => window.removeEventListener("keydown", onKey, true));
  const inboxUnread = () => props.folders.filter((f) => f.role === "inbox").reduce((n, f) => n + f.unread, 0);
  const close = () => !props.docked && props.onClose();
  const go = (t: Target) => (props.onGo(t), close());
  // One account: its inbox is the top row, so its section leaves it out.
  const single = () => props.accounts.length <= 1;
  const count = (f: Folder) => (UNCOUNTED.has(f.role) ? 0 : f.unread);
  const row = (f: Folder) => (
    <Item active={props.isTarget(targetOf(f))} onClick={() => go(targetOf(f))}>
      <span class="name">{ROLE_NAMES[f.role] ?? f.name}</span>
      <Count n={count(f)} />
    </Item>
  );

  const nav = (
    <nav class="rail" classList={{ docked: props.docked }} aria-label="Accounts and folders">
      <button type="button" class="rail-compose" onClick={() => (close(), props.onCompose())}>
        <Icon name="pen-line" size={15} />
        <span>New mail</span>
        <kbd>C</kbd>
      </button>
      {/* Only the places scroll: New mail and the foot stay put however many labels there are. */}
      <div class="rail-scroll">
      <div class="rail-group">
        <Item active={props.isTarget({ role: "inbox" })} onClick={() => go({ role: "inbox" })} icon="inbox">
          <span class="name">{single() ? "Inbox" : "All Inboxes"}</span>
          <Count n={inboxUnread()} />
        </Item>
        <Item active={props.isTarget({ role: "snoozed" })} onClick={() => go({ role: "snoozed" })} icon="clock">
          <span class="name">Snoozed</span>
        </Item>
        <Item active={props.isTarget({ role: "later" })} onClick={() => go({ role: "later" })} icon="book-open">
          <span class="name">Read later</span>
        </Item>
        <Item active={props.isTarget({ role: "marked" })} onClick={() => go({ role: "marked" })} icon="highlighter">
          <span class="name">Marks</span>
        </Item>
      </div>
      <Show when={props.searches.length}>
        <Fold id="searches" title="Searches" byDefault>
          <For each={props.searches}>
            {(q) => (
              <div class="saved-search">
                <Item active={props.searching === q} onClick={() => (props.onSearch(q), close())}>
                  <span class="name">{q}</span>
                </Item>
                <button
                  type="button"
                  class="forget"
                  title="Forget this search"
                  aria-label={`Forget the search ${q}`}
                  onClick={(e) => (e.stopPropagation(), props.onForget(q))}
                >
                  <Icon name="x" size={12} />
                </button>
              </div>
            )}
          </For>
        </Fold>
      </Show>
      <For each={props.accounts}>
        {(account) => {
          const mine = () => props.folders.filter((f) => f.accountId === account.id);
          const main = () =>
            MAIN_ROLES.flatMap((r) => mine().filter((f) => f.role === r)).filter((f) => !(single() && f.role === "inbox"));
          // The server's other special folders (Junk, Trash, All Mail…) wait under More; the person's own folders and
          // labels nest by name under their own headings.
          const more = () => mine().filter((f) => f.role !== "label" && f.role !== "other" && !MAIN_ROLES.includes(f.role));
          const own = () => mine().filter((f) => f.role === "other");
          const labels = () => mine().filter((f) => f.role === "label");
          const ownKey = `folders:${account.id}`;
          const showsOwn = () => isOpen(ownKey, own().length <= 8);
          const moreKey = `more:${account.id}`;
          const labelsKey = `labels:${account.id}`;
          const showsMore = () => isOpen(moreKey, false);
          const showsLabels = () => isOpen(labelsKey, labels().length <= 6);
          // A folded folder that is open in the list still shows, so the rail always says where you are.
          const shown = (fs: Folder[], open: boolean) => (open ? fs : fs.filter((f) => props.isTarget(targetOf(f))));
          const accountUnread = () => mine().find((f) => f.role === "inbox")?.unread ?? 0;
          return (
            <Fold
              id={`account:${account.id}`}
              byDefault
              title={
                <>
                  <AccountAvatar account={account} accounts={props.accounts} size={16} />
                  <span class="name" title={account.email}>
                    {account.email}
                  </span>
                  <Show when={SYNC_LABELS[props.syncStates[account.id]]}>
                    {(label) => <span class={`sync-state ${props.syncStates[account.id]}`}>{label()}</span>}
                  </Show>
                </>
              }
              folded={<Count n={single() ? 0 : accountUnread()} />}
            >
              <For each={main()}>{row}</For>
              <Show when={own().length}>
                <button type="button" class="rail-sub" aria-expanded={showsOwn()} onClick={() => toggle(ownKey, own().length <= 8)}>
                  <span>Folders</span>
                  <Icon name={showsOwn() ? "chevron-down" : "chevron-right"} size={12} />
                </button>
                <Tree nodes={folderTree(own())} open={showsOwn()} depth={0} account={account.id} isTarget={props.isTarget} go={go} />
              </Show>
              <Show when={labels().length}>
                <button
                  type="button"
                  class="rail-sub"
                  aria-expanded={showsLabels()}
                  onClick={() => toggle(labelsKey, labels().length <= 6)}
                >
                  <span>Labels</span>
                  <Icon name={showsLabels() ? "chevron-down" : "chevron-right"} size={12} />
                </button>
                <Tree nodes={folderTree(labels())} open={showsLabels()} depth={0} account={account.id} isTarget={props.isTarget} go={go} dots />
              </Show>
              <Show when={more().length}>
                <button type="button" class="rail-sub" aria-expanded={showsMore()} onClick={() => toggle(moreKey, false)}>
                  <span>More</span>
                  <Show when={!showsMore()}>
                    <span class="rail-sub-count">{more().length}</span>
                  </Show>
                  <Icon name={showsMore() ? "chevron-down" : "chevron-right"} size={12} />
                </button>
                <For each={shown(more(), showsMore())}>{row}</For>
              </Show>
            </Fold>
          );
        }}
      </For>
      </div>
      <div class="rail-foot">
        <button type="button" onClick={() => (close(), props.onSettings())} title="Settings (Ctrl+,)">
          <Icon name="settings" size={15} />
          <span>Settings</span>
        </button>
        <button
          type="button"
          class="rail-add"
          onClick={() => (props.onAddAccount(), close())}
          title="Add account"
          aria-label="Add account"
        >
          <Icon name="plus" size={15} />
        </button>
      </div>
    </nav>
  );

  return props.docked ? (
    nav
  ) : (
    // biome-ignore lint/a11y/noStaticElementInteractions: a click beside the rail closes it, as Escape does
    <div class="scrim" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      {nav}
    </div>
  );
}

/** Folders or labels nested by name. A parent starts folded and shows the unread of everything under it; a
 * branch holding the folder open in the list stays open, so the rail always says where you are. With the group
 * itself folded, only that branch shows. */
function Tree(props: {
  nodes: TreeNode[];
  open: boolean;
  depth: number;
  account: number;
  isTarget: (t: Target) => boolean;
  go: (t: Target) => void;
  dots?: boolean;
}) {
  const here = (f: Folder) => props.isTarget(targetOf(f));
  return (
    <For each={props.nodes.filter((n) => props.open || holds(n, here))}>
      {(n) => {
        const key = `tree:${props.account}:${n.path}`;
        const kids = () => n.children.length > 0;
        const unfolded = () => isOpen(key, false) || n.children.some((c) => holds(c, here));
        return (
          <>
            <div class="rail-tree-row" style={{ "--depth": props.depth }}>
              <Show when={kids()} fallback={<span class="tree-toggle" />}>
                <button
                  type="button"
                  class="tree-toggle"
                  aria-expanded={unfolded()}
                  aria-label={`${unfolded() ? "Fold" : "Unfold"} ${n.name}`}
                  onClick={() => toggle(key, false)}
                >
                  <Icon name={unfolded() ? "chevron-down" : "chevron-right"} size={12} />
                </button>
              </Show>
              <Item
                active={!!n.folder && here(n.folder)}
                onClick={() => (n.folder ? props.go(targetOf(n.folder)) : toggle(key, false))}
                lead={props.dots && props.depth === 0 ? <span class="label-dot" style={{ "--label": labelColour(n.path) }} /> : undefined}
              >
                <span class="name" title={n.path}>
                  {n.name}
                </span>
                <Count n={kids() && !unfolded() ? unreadUnder(n) : (n.folder?.unread ?? 0)} />
              </Item>
            </div>
            <Show when={kids() && unfolded()}>
              <Tree {...props} nodes={n.children} open depth={props.depth + 1} />
            </Show>
          </>
        );
      }}
    </For>
  );
}

/** A group with a heading that folds it; `folded` shows beside the heading while it is folded. */
function Fold(props: { id: string; title: JSX.Element; byDefault: boolean; folded?: JSX.Element; children: JSX.Element }) {
  const open = () => isOpen(props.id, props.byDefault);
  return (
    <section class="rail-group">
      <button type="button" class="rail-head" aria-expanded={open()} onClick={() => toggle(props.id, props.byDefault)}>
        {props.title}
        <Show when={!open()}>{props.folded}</Show>
        <Icon name={open() ? "chevron-down" : "chevron-right"} size={12} />
      </button>
      <Show when={open()}>{props.children}</Show>
    </section>
  );
}

function Count(props: { n: number }) {
  return (
    <Show when={props.n}>
      <span class="count">
        {props.n}
        <span class="visually-hidden"> unread</span>
      </span>
    </Show>
  );
}

/** One place to go in the rail: a button, so Tab reaches it and Enter opens it; the open one is `aria-current`. */
function Item(props: {
  active: boolean;
  onClick: () => void;
  icon?: "inbox" | "clock" | "book-open" | "highlighter";
  /** Drawn where the icon goes (a label's dot). */
  lead?: JSX.Element;
  children: JSX.Element;
}) {
  return (
    <button type="button" class="rail-item" classList={{ active: props.active }} aria-current={props.active ? "page" : undefined} onClick={props.onClick}>
      {/* Rows without an icon keep its place, so every name starts in one column. */}
      <Show when={props.icon} fallback={<span class="slot">{props.lead}</span>}>
        {(name) => <Icon name={name()} size={15} />}
      </Show>
      {props.children}
    </button>
  );
}
