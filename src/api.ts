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

export interface Api {
  accounts(): Promise<Account[]>;
  folders(): Promise<Folder[]>;
  preset(email: string): Promise<Preset | null>;
  addAccount(config: AccountConfig, password: string): Promise<Account>;
  list(target: Target, before: Cursor | null, limit: number): Promise<MessageRow[]>;
  thread(id: number): Promise<ThreadMessage[]>;
  search(query: string, limit: number): Promise<MessageRow[]>;
  apply(ids: number[], action: Action): Promise<Applied>;
  undo(token: number[]): Promise<boolean>;
  send(accountId: number, draft: Draft): Promise<number[]>;
  onChange(f: () => void): void;
  openUrl(url: string): void;
}

const tauri: Api = {
  accounts: () => invoke("accounts"),
  folders: () => invoke("folders"),
  preset: (email) => invoke("preset", { email }),
  addAccount: (config, password) => invoke("add_account", { config, password }),
  list: (target, before, limit) => invoke("list_messages", { target, before, limit }),
  thread: (id) => invoke("thread", { id }),
  search: (query, limit) => invoke("search", { query, limit }),
  apply: (ids, action) => invoke("apply", { ids, action }),
  undo: (token) => invoke("undo", { token }),
  send: (accountId, draft) => invoke("send", { accountId, draft }),
  onChange: (f) => void listen("mail-changed", f),
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
      threadId: `t${i}`,
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
    thread: async (id) => messages.filter((m) => m.id === id),
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
    onChange: (f) => void listeners.push(f),
    openUrl: (url) => void window.open(url, "_blank", "noopener"),
  };
}

export const api: Api = "__TAURI_INTERNALS__" in window ? tauri : fake();
