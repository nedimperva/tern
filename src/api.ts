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
  /** "google": signed in with Google in the browser, no password. Missing means a password. */
  auth?: "password" | "google";
};
export type Account = AccountConfig & { id: number };
/** What a `mailto:` link fills in. */
export type Mailto = { to: string[]; cc: string[]; bcc: string[]; subject: string; body: string };
/** Mail a notification was about. */
/** Saved text that compose inserts after `;shortcut`; `{first_name}` and the like are filled in there. It can be
 * kept to one account, and can also set the subject (when compose has none) and add people to Cc. `used` and
 * `lastUsed` (Unix seconds) are counted by the engine. */
export type Snippet = {
  id: number;
  shortcut: string;
  name: string;
  body: string;
  accountId: number | null;
  subject: string | null;
  cc: string[];
  used: number;
  lastUsed: number | null;
};
/** One of an account's signatures: plain text, with `html` when it has formatting. An account has at most one for
 * new mail and one for replies and forwards. */
export type Signature = {
  id: number;
  accountId: number;
  name: string;
  body: string;
  html: string | null;
  /** `html` is the person's own, pasted from another mail app: it goes out as it is, under the text. */
  custom?: boolean;
  forNew: boolean;
  forReply: boolean;
};

/** How far one account's download has come: messages here against the server's counts, and how many have their
 * text (what search reads in full). */
export type SyncProgress = {
  accountId: number;
  have: number;
  total: number;
  /** Folders not checked yet, whose size is unknown. */
  unchecked: number;
  withText: number;
  messages: number;
};

export type NewMail = { id: number; accountId: number; threadId: string; subject: string };
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

export type ContactCard = { email: string; name: string; sent: number; received: number; recent: MessageRow[] };
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
  /** The List-Unsubscribe header, raw: `<mailto:…>, <https://…>`. */
  listUnsubscribe: string | null;
};
/** One conversation in a list: its newest message in the listed folder(s), and the whole conversation's totals. */
export type ThreadRow = MessageRow & {
  count: number;
  unread: number;
  flagged: boolean;
  /** Who wrote in it, first to last, each once; "me" for the account itself. At most four. */
  participants: string[];
  /** When a snoozed conversation comes back (Unix seconds). */
  snoozedUntil: number | null;
  /** A follow-up on a sent message came due with no reply: pinned at the top of the inbox until done. */
  followUp?: boolean;
  /** Gmail labels on any of its messages. */
  labels?: string[];
};
/** Where an account's sync stands. */
export type SyncState = "connecting" | "syncing" | "idle" | "offline" | "auth-failed" | "paused";
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
/** A folder, every folder with a role (the unified inbox), or a Gmail label (its folder's id). */
export type Target = { folder: number } | { role: string } | { label: number };
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
  /** The HTML signature (Signature.custom) shown under the text, and what goes out with it in place. */
  htmlSignature?: number | null;
  outBody?: string | null;
  outHtml?: string | null;
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
export type Applied = { token: number[]; accounts: number[]; drafts: number[] };
/** Settings → About. */
export type About = { version: string; logFile: string; details: string };
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
  /** Sent later on purpose: `notBefore` is the time picked. */
  scheduled: boolean;
  /** A scheduled send whose time passed while Tern was closed; it waits for Send now or Edit. */
  held: boolean;
};

/** Send later and a follow-up reminder, both Unix seconds. */
export type SendOptions = { at?: number | null; followUp?: number | null };

export interface Api {
  accounts(): Promise<Account[]>;
  /** The name on mail sent from the account; empty sends the address alone. */
  setAccountName(id: number, name: string): Promise<void>;
  folders(): Promise<Folder[]>;
  preset(email: string): Promise<Preset | null>;
  addAccount(config: AccountConfig, password: string): Promise<Account>;
  /** Whether this build has a Google client for "Continue with Google". */
  googleAvailable(): Promise<boolean>;
  /** Signs in with Google in the browser: adds the account, or switches an existing one (`hint`) to it. */
  googleSignIn(name: string, hint?: string): Promise<Account>;
  list(target: Target, before: Cursor | null, limit: number): Promise<MessageRow[]>;
  /** Conversations with a message in `target`, newest first; `before` is the last row's (date, id). */
  listThreads(target: Target, before: Cursor | null, limit: number): Promise<ThreadRow[]>;
  /** An action on whole conversations, each named by its row's message id. */
  applyConversations(ids: number[], action: Action, target: Target): Promise<Applied>;
  /** Puts a Gmail label (its folder's id) on these conversations, or takes it off; undo like any action. */
  labelConversations(ids: number[], label: number, add: boolean): Promise<Applied>;
  thread(id: number): Promise<ThreadMessage[]>;
  /** Search with filters (see crates/tern-core/src/query.rs). `partial`: words were not looked for in mail without its text. */
  search(query: string, limit: number): Promise<{ rows: MessageRow[]; partial: boolean }>;
  apply(ids: number[], action: Action): Promise<Applied>;
  undo(token: number[]): Promise<boolean>;
  /** Queues a send; `delay` is the undo window in seconds; `draftId` when it was a saved draft. */
  send(accountId: number, draft: Draft, delay?: number, draftId?: number | null, options?: SendOptions): Promise<number[]>;
  /** A scheduled send goes now (also one held after Tern was closed). */
  sendNow(id: number): Promise<void>;
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
  /** A person's card: counts, and your latest conversations with them. */
  contactCard(email: string): Promise<ContactCard>;
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
  /** A sender's logo (data: URI) when cached; the first ask fetches it in the background and `onLogo` follows. */
  senderLogo(addr: string): Promise<string | null>;
  onLogo(f: () => void): void;
  /** An attachment's bytes for the viewer; the first time, the message is downloaded as for opening it. */
  attachmentBytes(id: number, index: number): Promise<ArrayBuffer>;
  /** A picture attachment as a data: URI for its card, if it is already on this computer; never downloads. */
  attachmentPreview(id: number, index: number): Promise<string | null>;
  /** Files dropped on the window from the file manager; returns the way to stop listening. */
  /** Files dropped on the window; `hover` hears files being dragged over it (true) and leaving (false). */
  onFilesDropped(f: (paths: string[]) => void, hover?: (over: boolean) => void): () => void;
  /** A picture being attached, as a data: URI for its card; null for other files. */
  outgoingPreview(path: string): Promise<string | null>;
  /** Runs `f` (and waits for it) before the window closes or Tern quits; returns the way to stop. */
  onCloseRequested(f: () => Promise<void>): () => void;
  /** Moves the senders of these messages to the inbox's Other split, or back to Important. */
  setSplit(ids: number[], other: boolean): Promise<void>;
  /** Unread messages in [Important, Other]. */
  splitUnread(): Promise<[number, number]>;
  /** Snoozes these conversations until `due` (Unix seconds); they come back unread. */
  snooze(ids: number[], due: number): Promise<void>;
  unsnooze(ids: number[]): Promise<void>;
  /** What a typed snooze time means ("tomorrow 9am", "3h", "mon"), in Unix seconds; null if unreadable or past. */
  parseWhen(text: string): Promise<number | null>;
  /** Saved snippets, the most used first. */
  snippets(): Promise<Snippet[]>;
  /** Adds (id 0) or changes a snippet; returns its id. Fails when the shortcut is taken or not one word. */
  saveSnippet(snippet: Snippet): Promise<number>;
  deleteSnippet(id: number): Promise<void>;
  /** Counts a use, so the most used come first. */
  snippetUsed(id: number): Promise<void>;
  /** Every account's signatures. */
  signatures(): Promise<Signature[]>;
  /** Adds (id 0) or changes a signature's name and text; returns its id. An account's first goes on all its mail. */
  saveSignature(signature: Signature): Promise<number>;
  /** The account's signature for new mail, or with `reply` for replies and forwards; null for none. */
  setSignatureDefault(accountId: number, reply: boolean, id: number | null): Promise<void>;
  deleteSignature(id: number): Promise<void>;
  /** Closing the window hides it while this says so: Tern keeps running in the tray. */
  keepRunningWhen(f: () => boolean): void;
  /** Saves what is being written, then quits Tern for good. */
  quit(): Promise<void>;
  /** The version of Tern downloaded and waiting for a restart, if any; `onUpdateReady` has it when it arrives. */
  updateReady(): Promise<string | null>;
  onUpdateReady(f: (version: string) => void): void;
  /** Saves what is being written, installs the waiting update and starts the new version. */
  restartToUpdate(): Promise<void>;
  /** The tray and the system: Compose from the tray menu, a `mailto:` link, a clicked notification, Quit. */
  onDesktop(handlers: {
    compose: () => void;
    mailto: (m: Mailto) => void;
    openMail: (m: NewMail) => void;
    /** A notification's Reply: open the conversation and reply to it. */
    reply: (m: NewMail) => void;
  }): void;
  /** Pauses or resumes sync for every account (also in the tray); `onSyncState` reports "paused" per account. */
  setSyncPaused(on: boolean): Promise<void>;
  /** The `mailto:` link Tern was started with, if any (once). */
  takeMailto(): Promise<Mailto | null>;
  autostart(): Promise<boolean>;
  setAutostart(on: boolean): Promise<void>;
  /** Whether `mailto:` links open in Tern. */
  defaultMailApp(): Promise<boolean>;
  makeDefaultMailApp(): Promise<void>;
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
  syncProgress(): Promise<SyncProgress[]>;
  /** The person opened this folder: check it on the server now. */
  checkFolder(id: number): Promise<void>;
  onSyncState(f: (accountId: number, state: SyncState) => void): void;
  openUrl(url: string): void;
  /** The version, the log file, and the details a bug report needs (no addresses). */
  about(): Promise<About>;
  /** Opens the folder with the log file. */
  openLogs(): Promise<void>;
}

// Everything that must be saved before the window goes (an open compose), and whether closing only hides it. One
// close listener for all of them: each Tauri listener would close the window by itself once its own part was done.
const flushers = new Set<() => Promise<void>>();
let keepRunning = () => false;
let closeInstalled = false;
const flush = () => Promise.all([...flushers].map((f) => f().catch(() => {})));
function installClose() {
  if (closeInstalled) return;
  closeInstalled = true;
  void import("@tauri-apps/api/window").then(({ getCurrentWindow }) =>
    getCurrentWindow().onCloseRequested(async (event) => {
      // A failed save must not keep the window open.
      await flush();
      if (keepRunning()) {
        event.preventDefault();
        await getCurrentWindow().hide();
      }
    }),
  );
}

const tauri: Api = {
  accounts: () => invoke("accounts"),
  setAccountName: (id, name) => invoke("set_account_name", { id, name }),
  folders: () => invoke("folders"),
  preset: (email) => invoke("preset", { email }),
  addAccount: (config, password) => invoke("add_account", { config, password }),
  googleAvailable: () => invoke("google_available"),
  googleSignIn: (name, hint) => invoke("google_sign_in", { name, hint: hint ?? null }),
  list: (target, before, limit) => invoke("list_messages", { target, before, limit }),
  listThreads: (target, before, limit) => invoke("list_threads", { target, before, limit }),
  applyConversations: (ids, action, target) => invoke("apply_conversations", { ids, action, target }),
  labelConversations: (ids, label, add) => invoke("label_conversations", { ids, label, add }),
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
  send: (accountId, draft, delay, draftId, options) =>
    invoke("send", { accountId, draft, delay, draftId, at: options?.at ?? null, followUp: options?.followUp ?? null }),
  sendNow: (id) => invoke("send_now", { id }),
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
  senderLogo: (addr) => invoke("sender_logo", { addr }),
  onLogo: (f) => void listen("logo", f),
  attachmentPreview: (id, index) => invoke("attachment_preview", { id, index }),
  outgoingPreview: (path) => invoke("outgoing_preview", { path }),
  attachmentBytes: (id, index) => invoke("attachment_bytes", { id, index }),
  saveAttachment: async (id, index, name) => {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const path = await save({ title: "Save attachment", defaultPath: name });
    if (path == null) return false;
    await invoke("save_attachment", { id, index, path });
    return true;
  },
  contacts: (query) => invoke("contacts", { query }),
  contactCard: (email) => invoke("contact_card", { email }),
  onFilesDropped: (f, hover) => {
    let stop: (() => void) | undefined;
    let stopped = false;
    void import("@tauri-apps/api/webview").then(({ getCurrentWebview }) =>
      getCurrentWebview()
        .onDragDropEvent((e) => {
          if (e.payload.type === "drop") (hover?.(false), f(e.payload.paths));
          else if (e.payload.type === "enter") hover?.(true);
          else if (e.payload.type === "leave") hover?.(false);
        })
        .then((unlisten) => (stopped ? unlisten() : (stop = unlisten))),
    );
    return () => ((stopped = true), stop?.());
  },
  onCloseRequested: (f) => {
    flushers.add(f);
    installClose();
    return () => void flushers.delete(f);
  },
  keepRunningWhen: (f) => {
    keepRunning = f;
    installClose();
  },
  quit: async () => {
    await flush();
    await invoke("quit");
  },
  updateReady: () => invoke("update_ready"),
  onUpdateReady: (f) => void listen<string>("update-ready", (e) => f(e.payload)),
  restartToUpdate: async () => {
    await flush();
    await invoke("restart_to_update");
  },
  onDesktop: (h) => {
    void listen("compose", () => h.compose());
    void listen<Mailto>("mailto", (e) => h.mailto(e.payload));
    void listen<NewMail>("open-mail", (e) => h.openMail(e.payload));
    void listen<NewMail>("reply-mail", (e) => h.reply(e.payload));
    void listen("quit", () => void tauri.quit());
  },
  takeMailto: () => invoke("take_mailto"),
  setSyncPaused: (on) => invoke("set_sync_paused", { on }),
  setSplit: (ids, other) => invoke("set_split", { ids, other }),
  splitUnread: () => invoke("split_unread"),
  snooze: (ids, due) => invoke("snooze", { ids, due }),
  unsnooze: (ids) => invoke("unsnooze", { ids }),
  parseWhen: (text) => invoke("parse_when", { text, offset: -new Date().getTimezoneOffset() }),
  snippets: () => invoke("snippets"),
  saveSnippet: (snippet) => invoke("save_snippet", { snippet }),
  deleteSnippet: (id) => invoke("delete_snippet", { id }),
  snippetUsed: (id) => invoke("snippet_used", { id }),
  signatures: () => invoke("signatures"),
  saveSignature: (signature) => invoke("save_signature", { signature }),
  setSignatureDefault: (accountId, reply, id) => invoke("set_signature_default", { accountId, reply, id }),
  deleteSignature: (id) => invoke("delete_signature", { id }),
  autostart: () => invoke("autostart"),
  setAutostart: (on) => invoke("set_autostart", { on }),
  defaultMailApp: () => invoke("default_mail_app"),
  makeDefaultMailApp: () => invoke("make_default_mail_app"),
  replyInit: (id, kind) => invoke("reply_init", { id, kind }),
  onChange: (f) => void listen("mail-changed", f),
  syncStates: () => invoke("sync_states"),
  syncProgress: () => invoke("sync_progress"),
  mute: (ids, mute) => invoke("mute", { ids, mute }),
  muted: (id) => invoke("muted", { id }),
  settings: () => invoke("settings"),
  setSetting: (key, value) => invoke("set_setting", { key, value }),
  checkFolder: (id) => invoke("check_folder", { id }),
  onSyncState: (f) =>
    void listen<{ accountId: number; state: SyncState }>("sync-state", (e) => f(e.payload.accountId, e.payload.state)),
  openUrl: (url) => void import("@tauri-apps/plugin-opener").then((m) => m.openUrl(url)),
  about: () => invoke("about"),
  openLogs: () => invoke("open_logs"),
};

// MARK: A fake mailbox for the browser

/** A sender-designed newsletter for the fake mailbox: layout tables, its own colours, a wide picture. */
function newsletter(subject: string): string {
  return `<table width="100%" bgcolor="#eeeae2" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 0">
<table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;font-family:Georgia,serif;color:#222">
<tr><td style="background:#0f4c3a;color:#f4efe2;padding:22px 28px"><div style="font:bold 12px Arial;letter-spacing:2px">THE FIELD NOTES</div>
<h1 style="font-size:24px;margin:10px 0 0">${subject}</h1></td></tr>
<tr><td><img width="600" alt="Mountains" src="data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="160"><defs><linearGradient id="g" x2="1"><stop offset="0" stop-color="#d7b58a"/><stop offset=".6" stop-color="#a8c3a0"/><stop offset="1" stop-color="#6f9c8a"/></linearGradient></defs><rect width="600" height="160" fill="url(#g)"/></svg>')}"></td></tr>
<tr><td style="padding:20px 28px;font-size:16px;line-height:1.6"><p>This week we walked the old railway line from Mostar toward Konjic, now a gravel trail along the Neretva.</p>
<p>Below: three day trips, where to sleep, and what the <b>October weather</b> really does up there.</p>
<p><a href="https://example.com/guide" style="display:inline-block;background:#0f4c3a;color:#ffffff;padding:10px 18px;text-decoration:none;font-family:Arial">Read the full guide</a></p></td></tr>
<tr><td style="background:#f2efe7;color:#777777;font:12px Arial;padding:14px 28px">You get this because you signed up at fieldnotes.example. <a href="https://example.com/u" style="color:#777777">Unsubscribe</a></td></tr>
</table></td></tr></table>`;
}

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
  const plain = { accountId: null, subject: null, cc: [], used: 0, lastUsed: null };
  let snippets: Snippet[] = [
    { ...plain, id: 1, shortcut: "thanks", name: "Thanks", body: "Thanks {first_name}!\n\n{cursor}" },
    { ...plain, id: 2, shortcut: "call", name: "Call me", body: "Hi {first_name},\n\nCould we talk about {subject} on a call this week?{cursor}" },
  ];
  let signatures: Signature[] = [
    { id: 1, accountId: 1, name: "Full", body: "Ada Lovelace\nAnalytical Engines Ltd", html: null, forNew: true, forReply: false },
    { id: 2, accountId: 1, name: "Short", body: "Ada", html: null, forNew: false, forReply: true },
  ];
  const folders: Folder[] = [
    { id: 1, accountId: 1, name: "INBOX", role: "inbox", unread: 0 },
    { id: 2, accountId: 1, name: "Archive", role: "archive", unread: 0 },
    { id: 3, accountId: 1, name: "Sent", role: "sent", unread: 0 },
    { id: 4, accountId: 1, name: "Trash", role: "trash", unread: 0 },
    { id: 5, accountId: 1, name: "Junk", role: "junk", unread: 0 },
    { id: 6, accountId: 1, name: "Receipts", role: "other", unread: 0 },
    // Gmail-style labels: a third of the conversations are Work, a quarter Invoices.
    { id: 7, accountId: 1, name: "Work", role: "label", unread: 0 },
    { id: 8, accountId: 1, name: "Invoices", role: "label", unread: 0 },
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
        i % 7 === 1
          ? newsletter(subject)
          : i % 3 === 0
          ? `<div style="font-family:sans-serif"><h2>${subject}</h2><p>${body.split("\n-- ")[0].replace(/\n/g, "<br>")}</p>` +
            (quote ? `<div class="gmail_quote">On Mon, someone wrote:<blockquote>Earlier message about ${subject}.</blockquote></div>` : "") +
            `</div>`
          : null,
      bodyLoaded: true,
      draftId: null,
      listUnsubscribe: i % 7 === 1 ? "<mailto:leave@fieldnotes.example?subject=unsubscribe>, <https://example.com/u>" : null,
      attachments:
        i % 11 === 0
          ? [
              { name: `${words[i % words.length]}-notes.pdf`, mime: "application/pdf", size: 48_213 + i },
              { name: `${words[(i + 1) % words.length]}-figures.xlsx`, mime: "application/vnd.ms-excel", size: 21_400 },
              { name: "photo.jpg", mime: "image/jpeg", size: 1_204_000 },
              { name: "orders.csv", mime: "text/csv", size: 812 },
            ]
          : [],
    };
  });
  const listeners: (() => void)[] = [];
  const stateListeners: ((accountId: number, state: SyncState) => void)[] = [];
  let waiting: OutboxWaiting[] =
    location.hash === "#offline"
      ? [
          { id: 3, accountId: 1, what: "Move 2 messages to Archive", notBefore: now - 60, attempts: 0, lastError: "", sending: false, canDiscard: false, scheduled: false, held: false },
          { id: 4, accountId: 1, what: "Star 2 messages", notBefore: now - 50, attempts: 0, lastError: "", sending: false, canDiscard: true, scheduled: false, held: false },
          { id: 5, accountId: 1, what: "Send “Notes from today”", notBefore: now + 40, attempts: 2, lastError: "Could not connect to smtp.example.com: timed out", sending: false, canDiscard: true, scheduled: false, held: false },
        ]
      : // Open the page with #scheduled to see a send later, and one held after Tern was closed.
        location.hash === "#scheduled"
        ? [
            { id: 6, accountId: 1, what: "Send “Plan for Monday”", notBefore: now + 86_400, attempts: 0, lastError: "", sending: false, canDiscard: true, scheduled: true, held: false },
            { id: 7, accountId: 1, what: "Send “Happy birthday!”", notBefore: now - 7_200, attempts: 0, lastError: "", sending: false, canDiscard: true, scheduled: true, held: true },
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
  const row = ({ messageId, toAddrs, bodyText, bodyHtml, bodyLoaded, attachments, draftId, listUnsubscribe, ...r }: ThreadMessage): MessageRow => r;
  // Every seventh conversation is a newsletter, for the Other split.
  const otherSenders = new Map<string, boolean>();
  const isOther = (m: ThreadMessage) => otherSenders.get(m.fromAddr) ?? Number(m.threadId.slice(1)) % 7 === 3;
  const snoozed = new Map<string, number>();
  const inInbox = (m: ThreadMessage) => folders.find((f) => f.id === m.folderId)?.role === "inbox";
  const labelsOf = (m: ThreadMessage) => {
    const n = Number(m.threadId.slice(1));
    return [...(n % 4 === 0 ? ["Invoices"] : []), ...(n % 3 === 0 ? ["Work"] : [])];
  };
  const inTarget = (m: ThreadMessage, t: Target): boolean => {
    if ("folder" in t) return m.folderId === t.folder;
    if ("label" in t) return labelsOf(m).length > 0;
    const asleep = snoozed.has(m.threadId);
    switch (t.role) {
      case "inbox":
        return inInbox(m) && !asleep;
      case "starred":
        return m.flagged && inInbox(m) && !asleep;
      case "important":
        return inInbox(m) && !asleep && !isOther(m);
      case "bulk":
        return inInbox(m) && !asleep && isOther(m);
      case "snoozed":
        return inInbox(m) && asleep;
      default:
        return folders.find((f) => f.id === m.folderId)?.role === t.role;
    }
  };

  return {
    accounts: async () => [account],
    setAccountName: async (_, name) => void (account.displayName = name.trim()),
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
    googleAvailable: async () => true,
    googleSignIn: async (name, hint) => ({
      email: hint ?? "ada@gmail.com",
      displayName: name,
      username: hint ?? "ada@gmail.com",
      imapHost: "imap.gmail.com",
      imapPort: 993,
      imapSecurity: "tls",
      smtpHost: "smtp.gmail.com",
      smtpPort: 465,
      smtpSecurity: "tls",
      auth: "google",
      id: 1,
    }),
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
        out.push({
          ...row(m),
          count: all.length,
          unread: all.filter((o) => !o.seen).length,
          flagged: all.some((o) => o.flagged),
          participants,
          snoozedUntil: snoozed.get(m.threadId) ?? null,
          // Open the page with #followup to see a follow-up that came due, pinned at the top.
          followUp: location.hash === "#followup" && out.length === 0 && !before,
          labels: labelsOf(m),
        });
      }
      return out;
    },
    labelConversations: async () => ({ token: [nextToken++], accounts: [1], drafts: [] }),
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
      return { token: [token], accounts: [1], drafts: [] };
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
    sendNow: async (id) => {
      waiting = waiting.filter((w) => w.id !== id);
      changed();
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
    outgoingPreview: async () => null,
    contacts: async (query) => {
      const q = query.toLowerCase();
      const people = names.map((n) => ({ name: n, email: n.toLowerCase().replace(/\s/g, ".") + "@example.com" }));
      return q ? people.filter((p) => p.email.startsWith(q) || p.name.toLowerCase().split(" ").some((w) => w.startsWith(q))).slice(0, 5) : [];
    },
    contactCard: async (email) => {
      const e = email.toLowerCase();
      const theirs = messages.filter((m) => m.fromAddr.toLowerCase() === e).sort((a, b) => b.date - a.date);
      const recent = theirs.filter((m, i) => theirs.findIndex((o) => o.threadId === m.threadId) === i).slice(0, 5);
      return { email, name: theirs[0]?.fromName ?? "", sent: 3, received: theirs.length, recent };
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
    // #offline, #paused and #backfill show those states; #backfill also a download in progress.
    syncStates: async () => ({
      1: ({ "#offline": "offline", "#paused": "paused", "#backfill": "syncing" } as const)[location.hash] ?? "idle",
    }),
    syncProgress: async () => [
      location.hash === "#backfill"
        ? { accountId: 1, have: 12_400, total: 48_210, unchecked: 0, withText: 9_800, messages: 12_400 }
        : { accountId: 1, have: messages.length, total: messages.length, unchecked: 0, withText: messages.length, messages: messages.length },
    ],
    onSyncState: (f) => void stateListeners.push(f),
    setSyncPaused: async (on) => stateListeners.forEach((f) => f(1, on ? "paused" : "idle")),
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
    keepRunningWhen: () => {},
    quit: async () => {},
    // Open the page with #update to see a downloaded update waiting.
    updateReady: async () => (location.hash === "#update" ? "0.4.0" : null),
    onUpdateReady: () => {},
    restartToUpdate: async () => location.reload(),
    onDesktop: () => {},
    takeMailto: async () => null,
    setSplit: async (ids, other) => {
      for (const m of messages.filter((m) => ids.includes(m.id))) otherSenders.set(m.fromAddr, other);
    },
    splitUnread: async () => {
      const unread = messages.filter((m) => !m.seen && inInbox(m) && !snoozed.has(m.threadId));
      const other = unread.filter(isOther).length;
      return [unread.length - other, other];
    },
    snooze: async (ids, due) => {
      for (const m of messages.filter((m) => ids.includes(m.id))) snoozed.set(m.threadId, due);
    },
    unsnooze: async (ids) => {
      for (const m of messages.filter((m) => ids.includes(m.id))) snoozed.delete(m.threadId);
    },
    // Enough to try the picker: a number of hours, or tomorrow at 8.
    parseWhen: async (text) => {
      const t = text.trim();
      if (!t) return null;
      const h = /^(\d+)\s*h/.exec(t);
      if (h) return Math.floor(Date.now() / 1000) + Number(h[1]) * 3600;
      const d = new Date();
      d.setDate(d.getDate() + 1);
      d.setHours(8, 0, 0, 0);
      return Math.floor(d.getTime() / 1000);
    },
    snippets: async () => [...snippets].sort((a, b) => b.used - a.used),
    saveSnippet: async (snippet) => {
      const shortcut = snippet.shortcut.trim().replace(/^;/, "");
      if (!shortcut || /\s/.test(shortcut)) throw "A shortcut is one word, such as thanks.";
      if (snippets.some((s) => s.id !== snippet.id && s.shortcut.toLowerCase() === shortcut.toLowerCase()))
        throw `Another snippet already uses ;${shortcut}.`;
      const id = snippet.id || Math.max(0, ...snippets.map((s) => s.id)) + 1;
      const was = snippets.find((s) => s.id === id);
      const kept = { ...snippet, id, shortcut, used: was?.used ?? 0, lastUsed: was?.lastUsed ?? null };
      snippets = [...snippets.filter((s) => s.id !== id), kept];
      return id;
    },
    deleteSnippet: async (id) => void (snippets = snippets.filter((s) => s.id !== id)),
    snippetUsed: async (id) =>
      void (snippets = snippets.map((s) => (s.id === id ? { ...s, used: s.used + 1, lastUsed: Math.floor(Date.now() / 1000) } : s))),
    signatures: async () => signatures.map((s) => ({ ...s })),
    saveSignature: async (signature) => {
      if (signature.id) {
        signatures = signatures.map((s) => (s.id === signature.id ? { ...s, name: signature.name, body: signature.body, html: signature.html, custom: signature.custom } : s));
        return signature.id;
      }
      const first = !signatures.some((s) => s.accountId === signature.accountId);
      const id = Math.max(0, ...signatures.map((s) => s.id)) + 1;
      signatures = [...signatures, { ...signature, id, forNew: first, forReply: first }];
      return id;
    },
    setSignatureDefault: async (accountId, reply, id) =>
      void (signatures = signatures.map((s) =>
        s.accountId !== accountId ? s : reply ? { ...s, forReply: s.id === id } : { ...s, forNew: s.id === id },
      )),
    deleteSignature: async (id) => void (signatures = signatures.filter((s) => s.id !== id)),
    autostart: async () => false,
    setAutostart: async () => {},
    defaultMailApp: async () => false,
    makeDefaultMailApp: async () => {},
    inlineImages: async () => ({}),
    senderLogo: async () => null,
    onLogo: () => {},
    // Stand-ins by type, enough to try the viewer: a picture, a page of text, or bytes nothing can show.
    attachmentBytes: async (id, index) => {
      const file = messages.find((m) => m.id === id)?.attachments[index];
      await new Promise((r) => setTimeout(r, 300));
      if (file?.mime.startsWith("image/")) {
        const canvas = Object.assign(document.createElement("canvas"), { width: 1200, height: 800 });
        const g = canvas.getContext("2d")!;
        const fill = g.createLinearGradient(0, 0, 1200, 800);
        fill.addColorStop(0, "#7aa6c2");
        fill.addColorStop(0.55, "#b9d4a8");
        fill.addColorStop(1, "#e7cf8a");
        g.fillStyle = fill;
        g.fillRect(0, 0, 1200, 800);
        const blob = await new Promise<Blob>((done) => canvas.toBlob((b) => done(b!), "image/jpeg"));
        return blob.arrayBuffer();
      }
      const text = file?.name.endsWith(".csv")
        ? "month,orders,freight\nOctober,412,3980\nNovember,455,4120\n"
        : "%PDF-1.4 stand-in";
      return new TextEncoder().encode(text).buffer as ArrayBuffer;
    },
    attachmentPreview: async (id, index) =>
      messages.find((m) => m.id === id)?.attachments[index]?.mime.startsWith("image/")
        ? "data:image/svg+xml," +
          encodeURIComponent(
            `<svg xmlns="http://www.w3.org/2000/svg" width="80" height="60"><defs><linearGradient id="g" x2="1" y2="1"><stop offset="0" stop-color="#7aa6c2"/><stop offset=".55" stop-color="#b9d4a8"/><stop offset="1" stop-color="#e7cf8a"/></linearGradient></defs><rect width="80" height="60" fill="url(#g)"/></svg>`,
          )
        : null,
    saveAttachment: async () => true,
    openUrl: (url) => void window.open(url, "_blank", "noopener"),
    about: async () => ({
      version: "0.3.6",
      logFile: "/home/you/.local/share/app.tern.mail/logs/tern.log",
      details: "Tern 0.3.6 (release build, AppImage)\nSystem: linux x86_64, Arch Linux, Hyprland, Wayland\nAccount 1: Gmail, password sign-in, up to date\nMail here: 5000 messages, 5000 with their text",
    }),
    openLogs: async () => {},
  };
}

export const api: Api = "__TAURI_INTERNALS__" in window ? tauri : fake();
