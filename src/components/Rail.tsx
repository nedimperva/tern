import { For, onCleanup, onMount, Show } from "solid-js";
import type { Account, Folder, SyncState, Target } from "../api";

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
  starred: "Starred",
};

/** Said next to the account only when it is not simply working: up to date or syncing shows nothing. */
const SYNC_LABELS: Partial<Record<SyncState, string>> = {
  connecting: "Connecting…",
  offline: "Offline",
  "auth-failed": "Sign-in failed",
};

/** Accounts and folders, sliding over the list from the left (Ctrl+\); never in the way otherwise. */
export function Rail(props: {
  accounts: Account[];
  folders: Folder[];
  syncStates: Record<number, SyncState>;
  isTarget: (t: Target) => boolean;
  onGo: (t: Target) => void;
  onAddAccount: () => void;
  onClose: () => void;
}) {
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      props.onClose();
    }
  };
  onMount(() => window.addEventListener("keydown", onKey, true));
  onCleanup(() => window.removeEventListener("keydown", onKey, true));
  const inboxUnread = () => props.folders.filter((f) => f.role === "inbox").reduce((n, f) => n + f.unread, 0);
  const go = (t: Target) => (props.onGo(t), props.onClose());

  return (
    <div class="scrim" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <nav class="rail" aria-label="Accounts and folders">
        <a classList={{ active: props.isTarget({ role: "inbox" }) }} onClick={() => go({ role: "inbox" })}>
          <span>All Inboxes</span>
          <Show when={inboxUnread()}>
            <span class="count">{inboxUnread()}</span>
          </Show>
        </a>
        <a classList={{ active: props.isTarget({ role: "snoozed" }) }} onClick={() => go({ role: "snoozed" })}>
          <span>Snoozed</span>
        </a>
        <For each={props.accounts}>
          {(account) => (
            <section>
              <h3>
                <span>{account.email}</span>
                <Show when={SYNC_LABELS[props.syncStates[account.id]]}>
                  {(label) => <span class={`sync-state ${props.syncStates[account.id]}`}>{label()}</span>}
                </Show>
              </h3>
              <For each={props.folders.filter((f) => f.accountId === account.id)}>
                {(f) => (
                  <a classList={{ active: props.isTarget({ folder: f.id }) }} onClick={() => go({ folder: f.id })}>
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
        <button class="link add-account" onClick={() => (props.onAddAccount(), props.onClose())}>
          + Add account
        </button>
      </nav>
    </div>
  );
}
