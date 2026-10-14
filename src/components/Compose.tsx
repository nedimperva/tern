import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { api, type Account, type Draft, type ForwardOf, type OutgoingAttachment } from "../api";
import { Icon } from "./Icon";
import { RecipientField, splitAddresses, validAddress } from "./RecipientField";

export type ComposeInit = {
  accountId?: number;
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  body?: string;
  inReplyTo?: string | null;
  references?: string[];
  /** Where the cursor starts: To for new mail and forwards, the body for replies. */
  focus?: "to" | "body";
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

/** Above this a message may bounce: many servers take 25 MB at most. */
const LARGE_BYTES = 25_000_000;

function size(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${Math.round(bytes / 1000)} KB`;
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

/** How long typing has to pause before the draft is saved. */
const SAVE_AFTER_MS = 2000;

/** New mail, reply or forward (docs/design/ui.md §4.4). Ctrl+Enter sends, Ctrl+Shift+Enter sends and marks the
 * conversation done; Ctrl+Shift+C / B add Cc / Bcc; Esc closes. */
export function Compose(props: {
  accounts: Account[];
  init: ComposeInit;
  onSend: (accountId: number, draft: Draft, done: boolean, draftId: number | null) => void;
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
  const [problem, setProblem] = createSignal("");
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
  let dirty = false;
  let saveTimer: number | undefined;
  const draft = (): Draft => ({
    to: to(),
    cc: cc(),
    bcc: bcc(),
    subject: subject(),
    body: body(),
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
  let text!: HTMLTextAreaElement;

  /** The body grows with what is in it (§4.4); the dialog or the conversation scrolls, not the field. */
  const grow = () => {
    text.style.height = "auto";
    text.style.height = `${text.scrollHeight}px`;
  };

  onMount(() => {
    grow();
    if ((props.init.focus ?? (props.init.to?.length ? "body" : "to")) === "body") {
      text.setSelectionRange(0, 0);
      text.focus({ preventScroll: true });
      text.scrollIntoView({ block: "nearest" });
    } else toInput.focus();
  });

  const send = (done: boolean) => {
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
    props.onSend(from()!, { ...draft(), ...recipients }, done, draftId);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    const ctrl = e.ctrlKey || e.metaKey;
    if (e.key === "Escape") void close();
    else if (ctrl && e.key === "Enter") send(e.shiftKey);
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
      <textarea ref={text} value={body()} onInput={(e) => (setBody(e.currentTarget.value), grow(), changed())} aria-label="Message" />
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

  return (
    <Show when={!props.init.inline} fallback={form}>
      <div class="overlay" onMouseDown={(e) => e.target === e.currentTarget && void close()}>
        {form}
      </div>
    </Show>
  );
}
