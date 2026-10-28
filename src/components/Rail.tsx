import { For, onCleanup, onMount, Show } from "solid-js";
import type { Account, Folder, SyncState, Target } from "../api";
import { labelColour } from "../colours";
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

/** Accounts and folders: the sidebar docked beside the list, or sliding over it from the left (Ctrl+\) when there
 * is no room for it or it is turned off. */
export function Rail(props: {
  /** Beside the list, open until hidden: going somewhere leaves it open and Esc is the list's. */
  docked: boolean;
  onCompose: () => void;
  onFind: () => void;
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

  const nav = (
    <nav class="rail" classList={{ docked: props.docked }} aria-label="Accounts and folders">
      <div class="rail-actions">
        <button type="button" onClick={() => (close(), props.onCompose())}>
          <Icon name="plus" />
          <span>New mail</span>
          <kbd>C</kbd>
        </button>
        <button type="button" onClick={() => (close(), props.onFind())}>
          <Icon name="search" />
          <span>Search</span>
          <kbd>/</kbd>
        </button>
      </div>
      <Show when={props.accounts.length > 1}>
        <div class="account-switch" role="group" aria-label="Accounts">
          <For each={props.accounts}>
            {(account, i) => {
              const inbox = () => props.folders.find((f) => f.accountId === account.id && f.role === "inbox");
              const unread = () => inbox()?.unread ?? 0;
              return (
                <button
                  type="button"
                  classList={{ active: !!inbox() && props.isTarget(targetOf(inbox()!)) }}
                  title={`${account.email}: its inbox${i() < 9 ? ` (Ctrl+${i() + 1})` : ""}${unread() ? `, ${unread()} unread` : ""}`}
                  aria-label={`${account.email} inbox`}
                  onClick={() => inbox() && go(targetOf(inbox()!))}
                >
                  <AccountAvatar account={account} accounts={props.accounts} size={30} />
                  <Show when={unread()}>
                    <span class="unread-dot" />
                  </Show>
                </button>
              );
            }}
          </For>
        </div>
      </Show>
      <a classList={{ active: props.isTarget({ role: "inbox" }) }} onClick={() => go({ role: "inbox" })}>
        <span>All Inboxes</span>
        <Show when={inboxUnread()}>
          <span class="count">{inboxUnread()}</span>
        </Show>
      </a>
      <a classList={{ active: props.isTarget({ role: "snoozed" }) }} onClick={() => go({ role: "snoozed" })}>
        <span>Snoozed</span>
      </a>
      <a classList={{ active: props.isTarget({ role: "later" }) }} onClick={() => go({ role: "later" })}>
        <span>Read later</span>
      </a>
      <a classList={{ active: props.isTarget({ role: "marked" }) }} onClick={() => go({ role: "marked" })}>
        <span>Marks</span>
      </a>
      <Show when={props.searches.length}>
        <h3>
          <span>Searches</span>
        </h3>
        <For each={props.searches}>
          {(q) => (
            <a class="saved-search" classList={{ active: props.searching === q }} onClick={() => (props.onSearch(q), close())}>
              <span class="query">{q}</span>
              <button
                type="button"
                class="forget"
                title="Forget this search"
                aria-label={`Forget the search ${q}`}
                onClick={(e) => (e.stopPropagation(), props.onForget(q))}
              >
                ×
              </button>
            </a>
          )}
        </For>
      </Show>
      <For each={props.accounts}>
        {(account) => (
          <section>
            <h3>
              <AccountAvatar account={account} accounts={props.accounts} size={16} />
              <span>{account.email}</span>
              <Show when={SYNC_LABELS[props.syncStates[account.id]]}>
                {(label) => <span class={`sync-state ${props.syncStates[account.id]}`}>{label()}</span>}
              </Show>
            </h3>
            <For each={props.folders.filter((f) => f.accountId === account.id && f.role !== "label")}>
              {(f) => (
                <a classList={{ active: props.isTarget(targetOf(f)) }} onClick={() => go(targetOf(f))}>
                  <span>{ROLE_NAMES[f.role] ?? f.name}</span>
                  <Show when={f.unread && f.role !== "trash" && f.role !== "junk"}>
                    <span class="count">{f.unread}</span>
                  </Show>
                </a>
              )}
            </For>
            <Show when={props.folders.some((f) => f.accountId === account.id && f.role === "label")}>
              <h4>Labels</h4>
              <For each={props.folders.filter((f) => f.accountId === account.id && f.role === "label")}>
                {(f) => (
                  <a classList={{ active: props.isTarget(targetOf(f)) }} onClick={() => go(targetOf(f))}>
                    <span class="label-name">
                      <span class="label-dot" style={{ "--label": labelColour(f.name) }} />
                      {f.name}
                    </span>
                    <Show when={f.unread}>
                      <span class="count">{f.unread}</span>
                    </Show>
                  </a>
                )}
              </For>
            </Show>
          </section>
        )}
      </For>
      <button class="link add-account" onClick={() => (props.onAddAccount(), close())}>
        + Add account
      </button>
      <div class="rail-foot">
        <button type="button" onClick={() => (close(), props.onSettings())} title="Settings (Ctrl+,)">
          <Icon name="settings" />
          <span>Settings</span>
        </button>
      </div>
    </nav>
  );

  return props.docked ? (
    nav
  ) : (
    <div class="scrim" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      {nav}
    </div>
  );
}
