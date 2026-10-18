import { createSignal, For, lazy, onCleanup, onMount, Show, Suspense } from "solid-js";
import { api, type Account, type Draft, type ForwardOf, type OutgoingAttachment, type SendOptions, type Snippet } from "../api";
import { until } from "./ConversationRow";
import { SnoozePicker } from "./SnoozePicker";
import type { SnippetSource } from "./Editor";
import { Icon } from "./Icon";
// The editor is a chunk of its own (ProseMirror is most of its weight); App loads it once the list is up.
const Editor = lazy(() => import("./Editor").then((m) => ({ default: m.Editor })));
import { RecipientField, splitAddresses, validAddress } from "./RecipientField";

export type ComposeInit = {
  accountId?: number;
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  body?: string;
  /** A saved draft's rich text; `body` is its plain text. */
  html?: string | null;
  inReplyTo?: string | null;
  references?: string[];
  /** Where the cursor starts: To for new mail and forwards, the body for replies. */
  focus?: "to" | "body";
  /** The quote shows unfolded (a quick quote). */
  quoteOpen?: boolean;
  /** What it opens with is not saved anywhere yet (a send taken back before its draft was saved). */
  unsaved?: boolean;
  /** Shown at the bottom of the open conversation rather than as a dialog. */
  inline?: boolean;
  /** Continues this saved draft. */
  draftId?: number | null;
  attachments?: OutgoingAttachment[];
  /** A forward: the original's attachments go along (the server has them), unless taken off. */
  forwardOf?: ForwardOf | null;
  /** Names and sizes of those, to show. */
  forwardFiles?: { name: string; size: number }[];
};

/** A snippet's text with its places filled: `{first_name}`, `{name}` and `{email}` of the first person it goes to,
 * `{subject}`, `{my_name}` and `{date}`. `{cursor}` stays for the editor; unknown places stay as typed. */
export function fillSnippet(
  body: string,
  to: { email: string; name: string } | null,
  subject: string,
  myName: string,
  now = new Date(),
): string {
  const name = to?.name.trim() ?? "";
  // Without a name, a local part such as "ada" or "ada.lovelace" still gives a first name.
  const local = to?.email.split("@")[0].split(/[._-]/)[0] ?? "";
  const first = name.split(/\s+/)[0] || (/^\p{L}+$/u.test(local) ? local[0].toUpperCase() + local.slice(1) : "");
  const values: Record<string, string> = {
    first_name: first,
    name: name || to?.email || "",
    email: to?.email ?? "",
    subject: subject.replace(/^((re|fwd?|aw|sv):\s*)+/i, ""),
    my_name: myName,
    date: now.toLocaleDateString(undefined, { dateStyle: "long" }),
  };
  return body.replace(/\{(\w+)\}/g, (place, key: string) => values[key] ?? place);
}

/** Above this a message may bounce: many servers take 25 MB at most. */
const LARGE_BYTES = 25_000_000;

function size(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${Math.round(bytes / 1000)} KB`;
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

/** How long typing has to pause before the draft is saved here (the server copy waits longer, see save_draft). */
const SAVE_AFTER_MS = 800;

/** New mail, reply or forward (docs/design/ui.md §4.4). Ctrl+Enter sends, Ctrl+Shift+Enter sends and marks the
 * conversation done; Ctrl+Shift+C / B add Cc / Bcc; Esc closes. */
export function Compose(props: {
  accounts: Account[];
  init: ComposeInit;
  onSend: (accountId: number, draft: Draft, done: boolean, draftId: number | null, options: SendOptions) => void;
  /** Closed; `saved` is the draft id when what was written was kept as a draft. */
  onClose: (saved: number | null) => void;
  /** Discarded; the draft id when one had been saved (so it can be undone). */
  onDiscard: (draftId: number | null) => void;
}) {
  const [from, setFrom] = createSignal(props.init.accountId ?? props.accounts[0]?.id);
  const [to, setTo] = createSignal(props.init.to ?? []);
  const [cc, setCc] = createSignal(props.init.cc ?? []);
  const [bcc, setBcc] = createSignal(props.init.bcc ?? []);
  const [showCc, setShowCc] = createSignal((props.init.cc ?? []).length > 0);
  const [showBcc, setShowBcc] = createSignal((props.init.bcc ?? []).length > 0);
  const [subject, setSubject] = createSignal(props.init.subject ?? "");
  const [body, setBody] = createSignal(props.init.body ?? "");
  const [html, setHtml] = createSignal<string | null>(props.init.html ?? null);
  const [problem, setProblem] = createSignal("");
  // Remind me if no reply (Ctrl+Shift+H): when, if set. Send later (Ctrl+Shift+L) sends as soon as a time is picked.
  const [followUp, setFollowUp] = createSignal<number | null>(null);
  const [picking, setPicking] = createSignal<"later" | "followUp" | null>(null);
  const [files, setFiles] = createSignal<OutgoingAttachment[]>(props.init.attachments ?? []);
  const [forwardOf, setForwardOf] = createSignal(props.init.forwardOf ?? null);
  const total = () =>
    files().reduce((n, f) => n + f.size, 0) +
    (forwardOf() ? (props.init.forwardFiles ?? []).reduce((n, f) => n + f.size, 0) : 0);
  const attach = async (paths: string[]) => {
    if (!paths.length) return;
    try {
      const added = await api.addAttachments(paths);
      setFiles([...files(), ...added]);
      changed();
    } catch (e) {
      setProblem(`Could not attach: ${e}`);
    }
  };
  const pick = async () => attach(await api.pickFiles());
  onMount(() => onCleanup(api.onFilesDropped((paths) => void attach(paths))));
  // The draft this compose saves to, once there is one, and whether anything changed since it opened.
  let draftId: number | null = props.init.draftId ?? null;
  // Reopened after undo-send, what is here may never have been saved.
  let dirty = props.init.unsaved ?? false;
  let saveTimer: number | undefined;
  const draft = (): Draft => ({
    to: to(),
    cc: cc(),
    bcc: bcc(),
    subject: subject(),
    body: body(),
    html: html(),
    inReplyTo: props.init.inReplyTo ?? null,
    references: props.init.references ?? [],
    attachments: files(),
    forwardOf: forwardOf(),
  });
  /** Saves the draft, if there is anything to keep. */
  const save = async (uploadNow: boolean) => {
    clearTimeout(saveTimer);
    if (!dirty || from() == null) return;
    draftId = await api.saveDraft(draftId, from()!, draft(), uploadNow);
  };
  /** Something changed: save once typing pauses. */
  const changed = () => {
    dirty = true;
    clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => void save(false), SAVE_AFTER_MS);
  };
  // A pending save is not lost if compose goes away some other way.
  onCleanup(() => {
    if (saveTimer !== undefined && dirty) void save(true);
  });
  // Nor when the window closes while typing: the save finishes before the window goes.
  onMount(() => onCleanup(api.onCloseRequested(() => (dirty ? save(true) : Promise.resolve()))));
  const close = async () => {
    await save(true);
    dirty = false;
    props.onClose(draftId);
  };
  const discard = () => {
    clearTimeout(saveTimer);
    dirty = false;
    if (draftId != null) void api.discardDraft(draftId);
    props.onDiscard(draftId);
  };
  let toInput!: HTMLInputElement;
  let ccInput: HTMLInputElement | undefined;
  let bccInput: HTMLInputElement | undefined;

  const [snippetList, setSnippetList] = createSignal<Snippet[]>([]);
  onMount(() => void api.snippets().then(setSnippetList, () => {}));
  const snippets: SnippetSource = {
    list: snippetList,
    fill: async (s) => {
      const email = to()[0];
      const known = email ? (await api.contacts(email).catch(() => [])).find((c) => c.email.toLowerCase() === email.toLowerCase()) : undefined;
      const account = props.accounts.find((a) => a.id === from());
      return fillSnippet(s.body, email ? { email, name: known?.name ?? "" } : null, subject(), account?.displayName ?? "");
    },
    used: (s) => void api.snippetUsed(s.id).catch(() => {}),
  };

  const bodyFirst = (props.init.focus ?? (props.init.to?.length ? "body" : "to")) === "body";
  onMount(() => {
    if (!bodyFirst) toInput.focus();
  });

  const send = (done: boolean, at: number | null = null) => {
    // Whatever is still typed in a field counts as entered.
    const all = (list: string[], input?: HTMLInputElement) => [...list, ...splitAddresses(input?.value ?? "")];
    const recipients = { to: all(to(), toInput), cc: all(cc(), ccInput), bcc: all(bcc(), bccInput) };
    const everyone = [...recipients.to, ...recipients.cc, ...recipients.bcc];
    if (!everyone.length) return setProblem("Add someone to send it to.");
    const bad = everyone.filter((a) => !validAddress(a));
    if (bad.length) return setProblem(`${bad.join(", ")} does not look like an address.`);
    if (from() == null) return;
    clearTimeout(saveTimer);
    dirty = false;
    props.onSend(from()!, { ...draft(), ...recipients }, done, draftId, { at, followUp: followUp() });
  };

  const onKeyDown = (e: KeyboardEvent) => {
    const ctrl = e.ctrlKey || e.metaKey;
    if (e.key === "Escape") void close();
    else if (ctrl && e.key === "Enter") send(e.shiftKey);
    else if (ctrl && e.shiftKey && e.key.toLowerCase() === "l") setPicking("later");
    else if (ctrl && e.shiftKey && e.key.toLowerCase() === "h") setPicking("followUp");
    else if (ctrl && e.shiftKey && (e.key === "," || e.key === "<")) discard();
    else if (ctrl && e.shiftKey && e.key.toLowerCase() === "a") void pick();
    else if (ctrl && e.shiftKey && e.key.toLowerCase() === "c") {
      setShowCc(true);
      queueMicrotask(() => ccInput?.focus());
    } else if (ctrl && e.shiftKey && e.key.toLowerCase() === "b") {
      setShowBcc(true);
      queueMicrotask(() => bccInput?.focus());
    } else return;
    e.preventDefault();
    e.stopPropagation();
  };

  const form = (
    <form class="compose" classList={{ inline: props.init.inline }} onKeyDown={onKeyDown} onSubmit={(e) => (e.preventDefault(), send(false))}>
      <Show when={props.accounts.length > 1}>
        <label class="field">
          <span class="label">From</span>
          <select value={from()} onChange={(e) => setFrom(Number(e.currentTarget.value))}>
            <For each={props.accounts}>
              {(a) => <option value={a.id}>{a.displayName ? `${a.displayName} <${a.email}>` : a.email}</option>}
            </For>
          </select>
        </label>
      </Show>
      <RecipientField label="To" value={to()} onChange={(v) => (setTo(v), changed())} ref={(el) => (toInput = el)} />
      <Show when={showCc()}>
        <RecipientField label="Cc" value={cc()} onChange={(v) => (setCc(v), changed())} ref={(el) => (ccInput = el)} />
      </Show>
      <Show when={showBcc()}>
        <RecipientField label="Bcc" value={bcc()} onChange={(v) => (setBcc(v), changed())} ref={(el) => (bccInput = el)} />
      </Show>
      <Show when={!props.init.inline || !props.init.inReplyTo}>
        <label class="field">
          <span class="label">Subject</span>
          <input value={subject()} onInput={(e) => (setSubject(e.currentTarget.value), changed())} />
        </label>
      </Show>
      <Suspense fallback={<div class="editor-body" />}>
      <Editor
        text={body()}
        html={props.init.html}
        autofocus={bodyFirst ? "start" : false}
        snippets={snippets}
        quoteOpen={props.init.quoteOpen}
        onChange={(text, rich) => (setBody(text), setHtml(rich), changed())}
      />
      </Suspense>
      <Show when={files().length || forwardOf()}>
        <div class="attachments outgoing" aria-label="Attachments">
          <Show when={forwardOf()}>
            <span class="file" title="Attached from the forwarded message when it is sent">
              <Icon name="paperclip" size={13} />
              <span class="name">
                {props.init.forwardFiles?.length
                  ? props.init.forwardFiles.map((f) => f.name).join(", ")
                  : "Attachments of the forwarded message"}
              </span>
              <button type="button" aria-label="Do not forward the attachments" onClick={() => (setForwardOf(null), changed())}>
                ×
              </button>
            </span>
          </Show>
          <For each={files()}>
            {(f, i) => (
              <span class="file" title={f.mime}>
                <Icon name="paperclip" size={13} />
                <span class="name">{f.name}</span>
                <span class="size">{size(f.size)}</span>
                <button
                  type="button"
                  aria-label={`Remove ${f.name}`}
                  onClick={() => (setFiles(files().filter((_, j) => j !== i())), changed())}
                >
                  ×
                </button>
              </span>
            )}
          </For>
          <span class="total" classList={{ large: total() > LARGE_BYTES }}>
            {total() > LARGE_BYTES ? `${size(total())}: many servers refuse mail over 25 MB` : size(total())}
          </span>
        </div>
      </Show>
      <Show when={problem()}>
        <p class="error">{problem()}</p>
      </Show>
      <footer>
        <button type="submit" class="primary">
          Send <kbd>Ctrl ↵</kbd>
        </button>
        <button type="button" onClick={() => send(true)}>
          Send & Done <kbd>Ctrl Shift ↵</kbd>
        </button>
        <span class="extras">
          <button type="button" class="link" onClick={() => setPicking("later")} title="Send later (Ctrl+Shift+L)">
            Later
          </button>
          <Show
            when={followUp()}
            fallback={
              <button type="button" class="link" onClick={() => setPicking("followUp")} title="Remind me if no reply (Ctrl+Shift+H)">
                Remind
              </button>
            }
          >
            {(due) => (
              <span
                class="follow-up"
                title="Remind me if no reply by then: the conversation comes back to the top of the inbox"
                aria-label={`Remind me if no reply by ${until(due())}`}
              >
                <Icon name="clock" size={12} />
                <span>{until(due())}</span>
                <button type="button" aria-label="No reminder" onClick={() => setFollowUp(null)}>
                  ×
                </button>
              </span>
            )}
          </Show>
          <button type="button" class="link" onClick={() => void pick()} title="Attach files (Ctrl+Shift+A), or drop them here">
            Attach
          </button>
          <Show when={!showCc()}>
            <button type="button" class="link" onClick={() => (setShowCc(true), queueMicrotask(() => ccInput?.focus()))}>
              Cc
            </button>
          </Show>
          <Show when={!showBcc()}>
            <button type="button" class="link" onClick={() => (setShowBcc(true), queueMicrotask(() => bccInput?.focus()))}>
              Bcc
            </button>
          </Show>
        </span>
        <button type="button" class="link discard" onClick={discard} title="Discard (Ctrl+Shift+,)">
          Discard
        </button>
        <button type="button" class="link" onClick={() => void close()} title="Close and keep the draft">
          Close <kbd>Esc</kbd>
        </button>
      </footer>
    </form>
  );

  const picker = (
    <Show when={picking()}>
      {(what) => (
        <SnoozePicker
          count={1}
          title={what() === "later" ? "Send later" : "Remind me if no reply"}
          presets={
            what() === "later"
              ? [
                  { name: "Later today", text: "later" },
                  { name: "Tomorrow morning", text: "tomorrow" },
                  { name: "Monday morning", text: "mon" },
                ]
              : [
                  { name: "Tomorrow", text: "tomorrow" },
                  { name: "In 3 days", text: "in 3 days" },
                  { name: "Next week", text: "next week" },
                  { name: "In 2 weeks", text: "in 2 weeks" },
                ]
          }
          placeholder={what() === "later" ? "Send when? tomorrow 9am, mon, 3h" : "No reply by when? 3 days, mon, next week"}
          note={
            what() === "later"
              ? "Tern sends it then if it's running. If it was closed, it asks before sending."
              : "If nobody answers by then, the conversation comes back to the top of the inbox. Tern has to be running."
          }
          onPick={(due) => {
            // Read before closing: the Show's value is gone once `picking` is null.
            const later = what() === "later";
            setPicking(null);
            if (later) send(false, due);
            else setFollowUp(due);
          }}
          onClose={() => setPicking(null)}
        />
      )}
    </Show>
  );

  return (
    <>
      <Show when={!props.init.inline} fallback={form}>
        <div class="overlay" onMouseDown={(e) => e.target === e.currentTarget && void close()}>
          {form}
        </div>
      </Show>
      {picker}
    </>
  );
}
