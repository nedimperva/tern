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
  attachments: { name: string; mime: string; size: number }[];
  /** Set when this is a draft being written in Tern. */
  draftId: number | null;
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
/** "junk" marks spam; "inbox" is Mark Not Done; `moveTo` takes a folder id (folders of other accounts are skipped). */
export type Action =
  | "archive"
  | "trash"
  | "junk"
  | "inbox"
  | { moveTo: number }
  | "markRead"
  | "markUnread"
  | "star"
  | "unstar";
/** Whether the action moves mail to another folder, so the list it is in loses it. */
export const moves = (a: Action) => typeof a === "object" || a === "archive" || a === "trash" || a === "junk" || a === "inbox";
export type Target = { folder: number } | { role: string };
export type Cursor = { date: number; id: number };
/** A file attached to a draft (Tern's own copy). */
export type OutgoingAttachment = { path: string; name: string; mime: string; size: number };
/** Where a forwarded message is on the server; its attachments go along when the forward is sent. */
export type ForwardOf = { folder: string; uid: number; validity: number | null; messageId: string | null };
export type Draft = {
  attachments?: OutgoingAttachment[];
  forwardOf?: ForwardOf | null;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  /** The same message as rich text; `body` is its plain-text version. */
  html?: string | null;
  inReplyTo?: string | null;
  references?: string[];
};
export type ReplyKind = "reply" | "replyAll" | "forward";
/** A draft as compose last saved it. */
export type DraftRecord = { id: number; accountId: number; draft: Draft & { messageId?: string | null }; updatedAt: number };
/** How a reply or forward starts; the UI writes the quote header in the person's language. */
export type ReplyInit = {
  accountId: number;
  to: string[];
  cc: string[];
  subject: string;
  inReplyTo: string | null;
  references: string[];
  quoteFrom: string;
  quoteDate: number;
  quoteText: string;
  quoteTo: string;
  quoteCc: string;
  forwardOf: ForwardOf | null;
};
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
/** Work on its way to the server: in the undo window, waiting for the connection, or between tries. */
export type OutboxWaiting = {
  id: number;
  accountId: number;
  what: string;
  /** Unix seconds of the next try. */
  notBefore: number;
  attempts: number;
  /** Why the last try failed; empty if none did. */
  lastError: string;
  /** The sync worker has it in hand right now. */
  sending: boolean;
  /** False while it is being sent, or when later changes depend on it. */
  canDiscard: boolean;
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
  /** Search with filters (see crates/tern-core/src/query.rs). `partial`: words were not looked for in mail without its text. */
  search(query: string, limit: number): Promise<{ rows: MessageRow[]; partial: boolean }>;
  apply(ids: number[], action: Action): Promise<Applied>;
  undo(token: number[]): Promise<boolean>;
  /** Queues a send; `delay` is the undo window in seconds; `draftId` when it was a saved draft. */
  send(accountId: number, draft: Draft, delay?: number, draftId?: number | null): Promise<number[]>;
  /** Saves compose's contents; returns the draft id. `uploadNow` when compose closes. */
  saveDraft(id: number | null, accountId: number, draft: Draft, uploadNow: boolean): Promise<number>;
  draft(id: number): Promise<DraftRecord | null>;
  /** The draft a message row stands for, if it is one being written in Tern. */
  draftForMessage(id: number): Promise<DraftRecord | null>;
  discardDraft(id: number): Promise<void>;
  undoDiscard(id: number): Promise<boolean>;
  /** A refused send, back as a draft to fix. */
  problemToDraft(id: number): Promise<DraftRecord>;
  /** People to suggest for what is typed in a recipient field, best first. */
  contacts(query: string): Promise<{ email: string; name: string }[]>;
  /** The system file picker; paths chosen (none if cancelled). */
  pickFiles(): Promise<string[]>;
  /** Copies files into Tern's attachment folder, for a draft. */
  addAttachments(paths: string[]): Promise<OutgoingAttachment[]>;
  /** Opens a received attachment with the system's program for it (it comes from the server the first time). */
  openAttachment(id: number, index: number): Promise<void>;
  /** Asks where to save a received attachment and saves it there; false if the person cancelled. */
  saveAttachment(id: number, index: number, name: string): Promise<boolean>;
  /** Images the message's HTML shows from its own parts, by Content-ID, as data: URIs (fetched the first time). */
  inlineImages(id: number): Promise<Record<string, string>>;
  /** Files dropped on the window from the file manager; returns the way to stop listening. */
  onFilesDropped(f: (paths: string[]) => void): () => void;
  /** Runs `f` (and waits for it) before the window closes; returns the way to stop. */
  onCloseRequested(f: () => Promise<void>): () => void;
  replyInit(id: number, kind: ReplyKind): Promise<ReplyInit>;
  problems(): Promise<OutboxProblem[]>;
  retryProblem(id: number): Promise<void>;
  /** Drops the work and puts the mailbox back as it was before it, as undo would. */
  discardProblem(id: number): Promise<void>;
  waiting(): Promise<OutboxWaiting[]>;
  /** Takes waiting work back, as undo would; false if it was sent meanwhile or later work depends on it. */
  discardWaiting(id: number): Promise<boolean>;
  /** The system says the network is back: reconnect now instead of after the retry wait. */
  networkBack(): void;
  onChange(f: () => void): void;
  /** Mutes (or unmutes) the conversations of these messages: later replies skip the inbox. */
  mute(ids: number[], mute: boolean): Promise<void>;
  muted(id: number): Promise<boolean>;
  /** Settings the person changed, by name; the UI holds the defaults. */
  settings(): Promise<Record<string, unknown>>;
  setSetting(key: string, value: unknown): Promise<void>;
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
  waiting: () => invoke("waiting"),
  discardWaiting: (id) => invoke("discard_waiting", { id }),
  networkBack: () => void invoke("network_back"),
  undo: (token) => invoke("undo", { token }),
  send: (accountId, draft, delay, draftId) => invoke("send", { accountId, draft, delay, draftId }),
  saveDraft: (id, accountId, draft, uploadNow) => invoke("save_draft", { id, accountId, draft, uploadNow }),
  draft: (id) => invoke("draft", { id }),
  draftForMessage: (id) => invoke("draft_for_message", { id }),
  discardDraft: (id) => invoke("discard_draft", { id }),
  undoDiscard: (id) => invoke("undo_discard", { id }),
  problemToDraft: (id) => invoke("problem_to_draft", { id }),
  pickFiles: async () => {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const chosen = await open({ multiple: true, title: "Attach files" });
    return chosen == null ? [] : Array.isArray(chosen) ? chosen : [chosen];
  },
  addAttachments: (paths) => invoke("add_attachments", { paths }),
  openAttachment: (id, index) => invoke("open_attachment", { id, index }),
  inlineImages: (id) => invoke("inline_images", { id }),
  saveAttachment: async (id, index, name) => {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const path = await save({ title: "Save attachment", defaultPath: name });
    if (path == null) return false;
    await invoke("save_attachment", { id, index, path });
    return true;
  },
  contacts: (query) => invoke("contacts", { query }),
  onFilesDropped: (f) => {
    let stop: (() => void) | undefined;
    let stopped = false;
    void import("@tauri-apps/api/webview").then(({ getCurrentWebview }) =>
      getCurrentWebview()
        .onDragDropEvent((e) => {
          if (e.payload.type === "drop") f(e.payload.paths);
        })
        .then((unlisten) => (stopped ? unlisten() : (stop = unlisten))),
    );
    return () => ((stopped = true), stop?.());
  },
  onCloseRequested: (f) => {
    let stop: (() => void) | undefined;
    let stopped = false;
    void import("@tauri-apps/api/window").then(({ getCurrentWindow }) =>
      getCurrentWindow()
        // The window closes once this resolves; a failed save must not keep it open.
        .onCloseRequested(() => f().catch(() => {}))
        .then((unlisten) => (stopped ? unlisten() : (stop = unlisten))),
    );
    return () => ((stopped = true), stop?.());
  },
  replyInit: (id, kind) => invoke("reply_init", { id, kind }),
  onChange: (f) => void listen("mail-changed", f),
  syncStates: () => invoke("sync_states"),
  mute: (ids, mute) => invoke("mute", { ids, mute }),
  muted: (id) => invoke("muted", { id }),
  settings: () => invoke("settings"),
  setSetting: (key, value) => invoke("set_setting", { key, value }),
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
    { id: 5, accountId: 1, name: "Junk", role: "junk", unread: 0 },
    { id: 6, accountId: 1, name: "Receipts", role: "other", unread: 0 },
  ];
  const mutedThreads = new Set<string>();
  const drafts = new Map<number, DraftRecord>();
  let nextDraft = 1;
  // Open the page with #big for a mailbox the size the performance targets are set for (about 10,000 conversations).
  const size = location.hash === "#big" ? 25_000 : 5000;
  let messages: ThreadMessage[] = Array.from({ length: size }, (_, i) => {
    const name = names[i % names.length];
    const subject = `${words[i % words.length]} ${words[(i * 7) % words.length]} #${size - i}`;
    // Replies quote what they answer, as mail does, so folding can be worked on.
    const quote = i % 5 > 0 && i % 5 < 3 ? `\n\nOn Mon, ${names[(i + 1) % names.length]} wrote:\n> Earlier message about ${subject}.\n> ${words.join(" ")}.` : "";
    const body = `Hi,\n\nThis is about the ${subject}. ${words.join(" ")}.\n\nThanks,\n${name.split(" ")[0]}\n-- \n${name}, Example Corp${quote}`;
    return {
      id: i + 1,
      accountId: 1,
      // #empty: everything archived, to see Inbox Zero.
      folderId: i % 9 === 0 || location.hash === "#empty" ? 2 : 1,
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
      bodyHtml:
        i % 3 === 0
          ? `<div style="font-family:sans-serif"><h2>${subject}</h2><p>${body.split("\n-- ")[0].replace(/\n/g, "<br>")}</p>` +
            (quote ? `<div class="gmail_quote">On Mon, someone wrote:<blockquote>Earlier message about ${subject}.</blockquote></div>` : "") +
            `</div>`
          : null,
      bodyLoaded: true,
      draftId: null,
      attachments: i % 11 === 0 ? [{ name: `${words[i % words.length]}-notes.pdf`, mime: "application/pdf", size: 48_213 + i }] : [],
    };
  });
  const listeners: (() => void)[] = [];
  let waiting: OutboxWaiting[] =
    location.hash === "#offline"
      ? [
          { id: 3, accountId: 1, what: "Move 2 messages to Archive", notBefore: now - 60, attempts: 0, lastError: "", sending: false, canDiscard: false },
          { id: 4, accountId: 1, what: "Star 2 messages", notBefore: now - 50, attempts: 0, lastError: "", sending: false, canDiscard: true },
          { id: 5, accountId: 1, what: "Send “Notes from today”", notBefore: now + 40, attempts: 2, lastError: "Could not connect to smtp.example.com: timed out", sending: false, canDiscard: true },
        ]
      : [];
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
  const row = ({ messageId, toAddrs, bodyText, bodyHtml, bodyLoaded, attachments, draftId, ...r }: ThreadMessage): MessageRow => r;
  const inTarget = (m: ThreadMessage, t: Target): boolean =>
    "folder" in t
      ? m.folderId === t.folder
      : t.role === "starred"
        ? m.flagged && inTarget(m, { role: "inbox" })
        : folders.find((f) => f.id === m.folderId)?.role === t.role;

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
        moves(action)
          ? members((m) => inTarget(m, "role" in target && target.role === "starred" ? { role: "inbox" } : target))
          : action === "unstar"
            ? members((m) => m.flagged)
            : action === "star"
              ? ids
              : members(() => true);
      return api.apply(chosen, action);
    },
    search: async (query, limit) => {
      // Words only; the filters live in the engine. Shown as partial so the note can be worked on here.
      const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
      const rows = messages
        .filter((m) => terms.every((t) => `${m.subject} ${m.fromName} ${m.bodyText}`.toLowerCase().includes(t)))
        .slice(0, limit)
        .map(row);
      return { rows, partial: terms.length > 0 };
    },
    apply: async (ids, action) => {
      const before = messages.map((m) => ({ ...m }));
      const dest =
        typeof action === "object"
          ? action.moveTo
          : ({ archive: 2, trash: 4, junk: 5, inbox: 1 } as Record<string, number>)[action] ?? null;
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
    send: async (_a, _d, _delay, draftId) => {
      if (draftId != null) drafts.delete(draftId);
      return [nextToken++];
    },
    saveDraft: async (id, accountId, draft) => {
      const key = id ?? nextDraft++;
      drafts.set(key, { id: key, accountId, draft, updatedAt: Math.floor(Date.now() / 1000) });
      return key;
    },
    draft: async (id) => drafts.get(id) ?? null,
    draftForMessage: async () => null,
    discardDraft: async (id) => void drafts.delete(id),
    undoDiscard: async () => false,
    // The browser has no file paths; a picked "file" is made up so the strip can be worked on.
    pickFiles: async () => ["/home/you/Documents/report.pdf"],
    addAttachments: async (paths) =>
      paths.map((p) => ({ path: p, name: p.split("/").pop()!, mime: "application/pdf", size: 1_234_567 })),
    onFilesDropped: () => () => {},
    contacts: async (query) => {
      const q = query.toLowerCase();
      const people = names.map((n) => ({ name: n, email: n.toLowerCase().replace(/\s/g, ".") + "@example.com" }));
      return q ? people.filter((p) => p.email.startsWith(q) || p.name.toLowerCase().split(" ").some((w) => w.startsWith(q))).slice(0, 5) : [];
    },
    problemToDraft: async (id) => {
      problems = problems.filter((p) => p.id !== id);
      const record = { id: nextDraft++, accountId: 1, draft: { to: ["typo@exmaple.com"], subject: "Re: Quarterly numbers", body: "Numbers attached." }, updatedAt: now };
      drafts.set(record.id, record);
      return record;
    },
    replyInit: async (id, kind) => {
      const m = messages.find((m) => m.id === id)!;
      const forward = kind === "forward";
      return {
        accountId: m.accountId,
        to: forward ? [] : [m.fromAddr],
        cc: kind === "replyAll" ? ["bob@example.com"] : [],
        subject: `${forward ? "Fwd" : "Re"}: ${m.subject}`,
        inReplyTo: forward ? null : m.messageId,
        references: forward || !m.messageId ? [] : [m.messageId],
        quoteFrom: `${m.fromName} <${m.fromAddr}>`,
        quoteDate: m.date,
        quoteText: m.bodyText ?? "",
        quoteTo: m.toAddrs,
        quoteCc: "",
        forwardOf: forward && m.attachments.length ? { folder: "INBOX", uid: m.id, validity: 1, messageId: m.messageId } : null,
      };
    },
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
    // Open the page with #offline to see changes waiting for the connection.
    waiting: async () => waiting,
    discardWaiting: async (id) => {
      waiting = waiting.filter((w) => w.id !== id);
      changed();
      return true;
    },
    networkBack: () => {},
    onChange: (f) => void listeners.push(f),
    // Open the page with #offline to see how a lost connection looks.
    syncStates: async () => ({ 1: location.hash === "#offline" ? "offline" : "idle" }),
    onSyncState: () => {},
    checkFolder: async () => {},
    mute: async (ids, mute) => {
      for (const m of messages.filter((m) => ids.includes(m.id))) {
        if (mute) mutedThreads.add(m.threadId);
        else mutedThreads.delete(m.threadId);
      }
    },
    muted: async (id) => mutedThreads.has(messages.find((m) => m.id === id)?.threadId ?? ""),
    // The browser fake keeps settings in this window's storage.
    settings: async () => {
      try {
        return JSON.parse(localStorage.getItem("tern.fake.settings") ?? "{}");
      } catch {
        return {};
      }
    },
    setSetting: async (key, value) => {
      try {
        const all = JSON.parse(localStorage.getItem("tern.fake.settings") ?? "{}");
        localStorage.setItem("tern.fake.settings", JSON.stringify({ ...all, [key]: value }));
      } catch {
        // No storage: the change lasts until the page reloads.
      }
    },
    openAttachment: async () => {},
    onCloseRequested: () => () => {},
    inlineImages: async () => ({}),
    saveAttachment: async () => true,
    openUrl: (url) => void window.open(url, "_blank", "noopener"),
  };
}

export const api: Api = "__TAURI_INTERNALS__" in window ? tauri : fake();
