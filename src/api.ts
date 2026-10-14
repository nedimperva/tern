// The UI's only door to the engine. Inside Tauri it calls the Rust commands; in a plain browser (`npm run dev`) it
// answers from a fake mailbox, so the UI can be worked on without an account.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/** "tls": encrypted from the first byte (IMAP 993, SMTP 465). "starttls": upgraded before sign-in (IMAP 143, SMTP 587). */
export type Security = "tls" | "starttls";
export type AccountConfig = {
  email: string;
  displayName: string;
  username: string;
  imapHost: string;
  imapPort: number;
  imapSecurity: Security;
  smtpHost: string;
  smtpPort: number;
  smtpSecurity: Security;
};
export type Account = AccountConfig & { id: number };
export type Folder = { id: number; accountId: number; name: string; role: string; unread: number };
export type MessageRow = {
  id: number;
  accountId: number;
  folderId: number;
  threadId: string;
  subject: string;
  fromName: string;
  fromAddr: string;
  date: number;
  snippet: string;
  seen: boolean;
  flagged: boolean;
  hasAttachments: boolean;
};
export type ThreadMessage = MessageRow & {
  messageId: string | null;
  toAddrs: string;
  bodyText: string | null;
  bodyHtml: string | null;
  /** False while only the headers are here; opening the message asks for the body, and "mail-changed" follows. */
  bodyLoaded: boolean;
};
/** One conversation in a list: its newest message in the listed folder(s), and the whole conversation's totals. */
export type ThreadRow = MessageRow & {
  count: number;
  unread: number;
  flagged: boolean;
  /** Who wrote in it, first to last, each once; "me" for the account itself. At most four. */
  participants: string[];
};
/** Where an account's sync stands. */
export type SyncState = "connecting" | "syncing" | "idle" | "offline" | "auth-failed";
export type Action = "archive" | "trash" | "markRead" | "markUnread" | "star" | "unstar";
export type Target = { folder: number } | { role: string };
export type Cursor = { date: number; id: number };
export type Draft = { to: string[]; cc?: string[]; subject: string; body: string; inReplyTo?: string | null };
export type Preset = {
  imapHost: string;
  imapPort: number;
  imapSecurity: Security;
  smtpHost: string;
  smtpPort: number;
  smtpSecurity: Security;
  note: string | null;
};
export type Applied = { token: number[]; accounts: number[] };
/** Queued work Tern stopped retrying: it waits for the person to retry or discard it. */
export type OutboxProblem = {
  id: number;
  accountId: number;
  what: string;
  attempts: number;
  lastError: string;
  gaveUpAt: number;
  /** A send that broke off after the server got the message: it may have gone out already. */
  maybeSent: boolean;
};

export interface Api {
  accounts(): Promise<Account[]>;
  folders(): Promise<Folder[]>;
  preset(email: string): Promise<Preset | null>;
  addAccount(config: AccountConfig, password: string): Promise<Account>;
  list(target: Target, before: Cursor | null, limit: number): Promise<MessageRow[]>;
  /** Conversations with a message in `target`, newest first; `before` is the last row's (date, id). */
  listThreads(target: Target, before: Cursor | null, limit: number): Promise<ThreadRow[]>;
  /** An action on whole conversations, each named by its row's message id. */
  applyConversations(ids: number[], action: Action, target: Target): Promise<Applied>;
  thread(id: number): Promise<ThreadMessage[]>;
  search(query: string, limit: number): Promise<MessageRow[]>;
  apply(ids: number[], action: Action): Promise<Applied>;
  undo(token: number[]): Promise<boolean>;
  send(accountId: number, draft: Draft): Promise<number[]>;
  problems(): Promise<OutboxProblem[]>;
  retryProblem(id: number): Promise<void>;
  /** Drops the work and puts the mailbox back as it was before it, as undo would. */
  discardProblem(id: number): Promise<void>;
  onChange(f: () => void): void;
  /** Each account's sync state as last reported; `onSyncState` has the changes after that. */
  syncStates(): Promise<Record<number, SyncState>>;
  /** The person opened this folder: check it on the server now. */
  checkFolder(id: number): Promise<void>;
  onSyncState(f: (accountId: number, state: SyncState) => void): void;
  openUrl(url: string): void;
}

const tauri: Api = {
  accounts: () => invoke("accounts"),
  folders: () => invoke("folders"),
  preset: (email) => invoke("preset", { email }),
  addAccount: (config, password) => invoke("add_account", { config, password }),
  list: (target, before, limit) => invoke("list_messages", { target, before, limit }),
  listThreads: (target, before, limit) => invoke("list_threads", { target, before, limit }),
  applyConversations: (ids, action, target) => invoke("apply_conversations", { ids, action, target }),
  thread: (id) => invoke("thread", { id }),
  search: (query, limit) => invoke("search", { query, limit }),
  apply: (ids, action) => invoke("apply", { ids, action }),
  problems: () => invoke("problems"),
  retryProblem: (id) => invoke("retry_problem", { id }),
  discardProblem: (id) => invoke("discard_problem", { id }),
  undo: (token) => invoke("undo", { token }),
  send: (accountId, draft) => invoke("send", { accountId, draft }),
  onChange: (f) => void listen("mail-changed", f),
  syncStates: () => invoke("sync_states"),
  checkFolder: (id) => invoke("check_folder", { id }),
  onSyncState: (f) =>
    void listen<{ accountId: number; state: SyncState }>("sync-state", (e) => f(e.payload.accountId, e.payload.state)),
  openUrl: (url) => void import("@tauri-apps/plugin-opener").then((m) => m.openUrl(url)),
};

// MARK: A fake mailbox for the browser

function fake(): Api {
  const words = "invoice meeting lunch release budget travel report design review contract launch offer update".split(" ");
  const names = ["Ada Lovelace", "Alan Turing", "Grace Hopper", "Linus Torvalds", "Margaret Hamilton", "GitHub", "Stripe"];
  const now = Math.floor(Date.now() / 1000);
  const account: Account = {
    id: 1,
    email: "you@example.com",
    displayName: "You",
    username: "you@example.com",
    imapHost: "imap.example.com",
    imapPort: 993,
    imapSecurity: "tls",
    smtpHost: "smtp.example.com",
    smtpPort: 465,
    smtpSecurity: "tls",
  };
  const folders: Folder[] = [
    { id: 1, accountId: 1, name: "INBOX", role: "inbox", unread: 0 },
    { id: 2, accountId: 1, name: "Archive", role: "archive", unread: 0 },
    { id: 3, accountId: 1, name: "Sent", role: "sent", unread: 0 },
    { id: 4, accountId: 1, name: "Trash", role: "trash", unread: 0 },
  ];
  let messages: ThreadMessage[] = Array.from({ length: 5000 }, (_, i) => {
    const name = names[i % names.length];
    const subject = `${words[i % words.length]} ${words[(i * 7) % words.length]} #${5000 - i}`;
    const body = `Hi,\n\nThis is about the ${subject}. ${words.join(" ")}.\n\nThanks,\n${name.split(" ")[0]}`;
    return {
      id: i + 1,
      accountId: 1,
      folderId: i % 9 === 0 ? 2 : 1,
      // Every fifth message starts a conversation that the next two answer.
      threadId: i % 5 < 3 ? `t${i - (i % 5)}` : `t${i}`,
      subject,
      fromName: name,
      fromAddr: name.toLowerCase().replace(/\s/g, ".") + "@example.com",
      date: now - i * 1700,
      snippet: body.replace(/\s+/g, " ").slice(4, 150),
      seen: i % 4 !== 0,
      flagged: i % 23 === 0,
      hasAttachments: i % 11 === 0,
      messageId: `${i}@example.com`,
      toAddrs: account.email,
      bodyText: body,
      bodyHtml: i % 3 === 0 ? `<div style="font-family:sans-serif"><h2>${subject}</h2><p>${body.replace(/\n/g, "<br>")}</p></div>` : null,
      bodyLoaded: true,
    };
  });
  const listeners: (() => void)[] = [];
  let problems: OutboxProblem[] = [
    {
      id: 1,
      accountId: 1,
      what: "Send “Re: Quarterly numbers”",
      attempts: 1,
      lastError: "permanent error (550): 5.1.1 Recipient address rejected: no such user",
      gaveUpAt: now,
      maybeSent: false,
    },
    {
      id: 2,
      accountId: 1,
      what: "Send “Lunch on Friday?”",
      attempts: 1,
      lastError: "The connection broke after the message was handed over, so it may have been sent",
      gaveUpAt: now,
      maybeSent: true,
    },
  ];
  const changed = () => listeners.forEach((f) => f());
  const pending = new Map<number, () => void>();
  let nextToken = 1;
  const row = ({ messageId, toAddrs, bodyText, bodyHtml, bodyLoaded, ...r }: ThreadMessage): MessageRow => r;
  const inTarget = (m: ThreadMessage, t: Target) =>
    "folder" in t ? m.folderId === t.folder : folders.find((f) => f.id === m.folderId)?.role === t.role;

  return {
    accounts: async () => [account],
    folders: async () =>
      folders.map((f) => ({ ...f, unread: messages.filter((m) => m.folderId === f.id && !m.seen).length })),
    preset: async () => ({
      imapHost: "imap.example.com",
      imapPort: 993,
      imapSecurity: "tls",
      smtpHost: "smtp.example.com",
      smtpPort: 465,
      smtpSecurity: "tls",
      note: null,
    }),
    addAccount: async (config) => ({ ...config, id: 1 }),
    list: async (target, before, limit) =>
      messages
        .filter((m) => inTarget(m, target) && (!before || m.date < before.date || (m.date === before.date && m.id < before.id)))
        .sort((a, b) => b.date - a.date || b.id - a.id)
        .slice(0, limit)
        .map(row),
    thread: async (id) => {
      const t = messages.find((m) => m.id === id)?.threadId;
      return messages.filter((m) => m.threadId === t).sort((a, b) => a.date - b.date);
    },
    listThreads: async (target, before, limit) => {
      const newer = (m: ThreadMessage) => !!before && (m.date > before.date || (m.date === before.date && m.id >= before.id));
      const shown = new Set(messages.filter((m) => inTarget(m, target) && newer(m)).map((m) => m.threadId));
      const out: ThreadRow[] = [];
      for (const m of messages.filter((m) => inTarget(m, target) && !newer(m)).sort((a, b) => b.date - a.date || b.id - a.id)) {
        if (out.length >= limit) break;
        if (shown.has(m.threadId)) continue;
        shown.add(m.threadId);
        const all = messages.filter((o) => o.threadId === m.threadId).sort((a, b) => a.date - b.date);
        const participants = [...new Set(all.map((o) => o.fromName))].slice(0, 4);
        out.push({ ...row(m), count: all.length, unread: all.filter((o) => !o.seen).length, flagged: all.some((o) => o.flagged), participants });
      }
      return out;
    },
    applyConversations: async (ids, action, target) => {
      const threads = new Set(messages.filter((m) => ids.includes(m.id)).map((m) => m.threadId));
      const members = (keep: (m: ThreadMessage) => boolean) =>
        messages.filter((m) => threads.has(m.threadId) && keep(m)).map((m) => m.id);
      const chosen =
        action === "archive" || action === "trash"
          ? members((m) => inTarget(m, target))
          : action === "unstar"
            ? members((m) => m.flagged)
            : action === "star"
              ? ids
              : members(() => true);
      return api.apply(chosen, action);
    },
    search: async (query, limit) => {
      const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
      return messages
        .filter((m) => terms.every((t) => `${m.subject} ${m.fromName} ${m.bodyText}`.toLowerCase().includes(t)))
        .slice(0, limit)
        .map(row);
    },
    apply: async (ids, action) => {
      const before = messages.map((m) => ({ ...m }));
      const dest = action === "archive" ? 2 : action === "trash" ? 4 : null;
      messages = messages.map((m) => {
        if (!ids.includes(m.id)) return m;
        if (dest) return { ...m, folderId: dest };
        if (action === "markRead" || action === "markUnread") return { ...m, seen: action === "markRead" };
        return { ...m, flagged: action === "star" };
      });
      const token = nextToken++;
      pending.set(token, () => (messages = before));
      setTimeout(() => pending.delete(token), 5000);
      changed();
      return { token: [token], accounts: [1] };
    },
    undo: async (token) => {
      const revert = pending.get(token[0]);
      if (!revert) return false;
      revert();
      pending.delete(token[0]);
      changed();
      return true;
    },
    send: async () => [nextToken++],
    // One sample, so the problems strip can be worked on in a plain browser.
    problems: async () => problems,
    retryProblem: async (id) => {
      problems = problems.filter((p) => p.id !== id);
      changed();
    },
    discardProblem: async (id) => {
      problems = problems.filter((p) => p.id !== id);
      changed();
    },
    onChange: (f) => void listeners.push(f),
    // Open the page with #offline to see how a lost connection looks.
    syncStates: async () => ({ 1: location.hash === "#offline" ? "offline" : "idle" }),
    onSyncState: () => {},
    checkFolder: async () => {},
    openUrl: (url) => void window.open(url, "_blank", "noopener"),
  };
}

export const api: Api = "__TAURI_INTERNALS__" in window ? tauri : fake();
