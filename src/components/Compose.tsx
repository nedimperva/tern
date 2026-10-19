import { createEffect, createResource, createSignal, For, lazy, onCleanup, onMount, Show, Suspense } from "solid-js";
import type { EditorView } from "prosemirror-view";
import {
  api,
  type Account,
  type Draft,
  type ForwardOf,
  type OutgoingAttachment,
  type SendOptions,
  type Signature,
  type Snippet,
} from "../api";
import { fillSnippet } from "../snippets";
import { attachmentWords, domainOf, mentionsAttachment, outside } from "../attachmentWords";
import { colourOf } from "../colours";
import { settings } from "../settings";
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
  /** New mail and replies: the signature goes in after `body` and above `quote` (below it when `below`). `kind`
   * says which of the account's signatures a change of From picks. A saved draft has none: its own text has it. */
  signature?: { id: number | null; kind: "new" | "reply"; quote: string; below: boolean };
};

/** The signature of `accountId` for new mail or for replies, if it has one. */
export function defaultSignature(all: Signature[], accountId: number | undefined, kind: "new" | "reply") {
  return all.find((s) => s.accountId === accountId && (kind === "new" ? s.forNew : s.forReply)) ?? null;
}

/** Signature work needs the editor's document model, so it loads with the editor, not with the app. */
const signatureTools = () => import("../signature");

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
  /** Every account's signatures. */
  signatures: Signature[];
  init: ComposeInit;
  onSend: (accountId: number, draft: Draft, done: boolean, draftId: number | null, options: SendOptions) => void;
  /** Closed; `saved` is the draft id when what was written was kept as a draft. */
  onClose: (saved: number | null) => void;
  /** Discarded; the draft id when one had been saved (so it can be undone). */
  onDiscard: (draftId: number | null) => void;
  /** Folded into a card in the corner while the person reads other mail (new mail only). */
  minimized?: boolean;
  onMinimize?: (on: boolean) => void;
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
  // What the editor opens with: the text, signature and quote put together. The editor waits for it.
  const [opening] = createResource(async () => {
    const s = props.init.signature;
    if (!s) return { body: body(), html: html() };
    const sig = props.signatures.find((x) => x.id === s.id) ?? null;
    const made = (await signatureTools()).withSignature(body(), s.quote, sig, s.below);
    setBody(made.body);
    setHtml(made.html);
    return made;
  });
  // The signature in the text now (null: none, or one Tern can't find as written), and the editor showing it.
  const [sigId, setSigId] = createSignal<number | null>(props.init.signature?.id ?? null);
  const sigKind = props.init.signature?.kind ?? (props.init.inReplyTo ? "reply" : "new");
  const accountSignatures = () => props.signatures.filter((s) => s.accountId === from());
  let view: EditorView | undefined;
  const editorReady = (v: EditorView) => {
    view = v;
    // A saved draft: find which of the account's signatures it holds, so switching replaces that one.
    if (props.init.signature) return;
    void signatureTools().then(({ findSignature }) => {
      const held = accountSignatures().find((s) => findSignature(v.state.doc, s));
      if (held) setSigId(held.id);
    });
  };
  /** Puts `next` (or no signature) in place of the current one, where the current one is; else where one goes. */
  const switchSignature = async (next: Signature | null) => {
    if (!view) return;
    const { findSignature, signatureDoc, signaturePlace } = await signatureTools();
    const state = view.state;
    const current = props.signatures.find((s) => s.id === sigId());
    const at = current ? findSignature(state.doc, current) : null;
    const blocks = next ? signatureDoc(next).content : null;
    if (at) view.dispatch(blocks ? state.tr.replaceWith(at.from, at.to, blocks) : state.tr.delete(at.from, at.to));
    else if (blocks) {
      const below = props.init.signature?.below ?? false;
      view.dispatch(state.tr.insert(signaturePlace(state.doc, below), blocks));
    }
    setSigId(next?.id ?? null);
  };
  /** Ctrl+Shift+S: the account's next signature, then none, then round again. */
  const cycleSignature = () => {
    const list = accountSignatures();
    if (!list.length) return;
    const i = list.findIndex((s) => s.id === sigId());
    void switchSignature(i + 1 < list.length ? list[i + 1] : null);
  };
  /** Writing from another account brings its signature, when the one in the text was the old account's. */
  const changeFrom = (accountId: number) => {
    const old = props.signatures.find((s) => s.id === sigId());
    setFrom(accountId);
    if (old && old.accountId !== accountId) void switchSignature(defaultSignature(props.signatures, accountId, sigKind));
    else if (!old && props.init.signature) void switchSignature(defaultSignature(props.signatures, accountId, sigKind));
  };
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
  // Files dragged over the window: the drop zone shows while they are.
  const [dragging, setDragging] = createSignal(false);
  onMount(() => onCleanup(api.onFilesDropped((paths) => void attach(paths), setDragging)));
  // Pictures being attached, shown on their cards.
  const [previews, setPreviews] = createSignal<Record<string, string>>({});
  createEffect(() => {
    for (const f of files()) {
      if (!f.mime.startsWith("image/") || f.path in previews()) continue;
      setPreviews({ ...previews(), [f.path]: "" });
      void api.outgoingPreview(f.path).then((uri) => uri && setPreviews({ ...previews(), [f.path]: uri }));
    }
  });
  const [saveState, setSaveState] = createSignal<"saving" | "saved" | null>(null);
  const [focusMode, setFocusMode] = createSignal(false);
  const [sendMenu, setSendMenu] = createSignal(false);
  // Checks before sending (attachment mentioned but missing, no subject). Shown on the first try; sending again
  // with them showing sends anyway. Any change takes them away, since it may have been the fix.
  const [checks, setChecks] = createSignal<{ attachment: string | null; subject: boolean } | null>(null);
  // An outside recipient among people from the sender's own organisation: said once, can be dismissed.
  const [outsideDismissed, setOutsideDismissed] = createSignal(false);
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
    setSaveState("saving");
    try {
      draftId = await api.saveDraft(draftId, from()!, draft(), uploadNow);
      setSaveState("saved");
    } catch {
      setSaveState(null);
    }
  };
  /** Something changed: save once typing pauses. */
  const changed = () => {
    dirty = true;
    setChecks(null);
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
  /** Fills a snippet's places for the first person it goes to. */
  const fillFor = async (text: string) => {
    const email = to()[0];
    const known = email ? (await api.contacts(email).catch(() => [])).find((c) => c.email.toLowerCase() === email.toLowerCase()) : undefined;
    const account = props.accounts.find((a) => a.id === from());
    return fillSnippet(text, email ? { email, name: known?.name ?? "" } : null, subject(), account?.displayName ?? "");
  };
  const snippets: SnippetSource = {
    // A snippet kept to one account is offered only when writing from it.
    list: () => snippetList().filter((s) => s.accountId == null || s.accountId === from()),
    fill: (s) => fillFor(s.body),
    used: (s) => {
      void api.snippetUsed(s.id).catch(() => {});
      // Its subject only where there is none yet; its Cc people join whoever is there.
      if (s.subject && !subject().trim()) void fillFor(s.subject).then((text) => (setSubject(text), changed()));
      const fresh = s.cc.filter((a) => ![...to(), ...cc()].some((b) => b.toLowerCase() === a.toLowerCase()));
      if (fresh.length) (setCc([...cc(), ...fresh]), setShowCc(true), changed());
    },
  };

  const bodyFirst = (props.init.focus ?? (props.init.to?.length ? "body" : "to")) === "body";
  onMount(() => {
    if (!bodyFirst) toInput.focus();
  });

  const sender = () => props.accounts.find((a) => a.id === from())?.email;
  const isOutside = (address: string) => outside(address, sender());
  /** Outside recipients, when they are mixed with people from the sender's own organisation. */
  const outsiders = () => {
    const everyone = [...to(), ...cc(), ...bcc()];
    const out = everyone.filter(isOutside);
    return out.length && out.length < everyone.length ? out : [];
  };
  /** What the person wrote themselves: not the quoted message, not the signature. */
  const ownText = () => {
    let text = body();
    if (view) {
      const parts: string[] = [];
      // Line breaks as text too, or the signature's lines run together and are not found below.
      view.state.doc.forEach(
        (node) => void (node.type.name !== "blockquote" && parts.push(node.textBetween(0, node.content.size, "\n", "\n"))),
      );
      text = parts.join("\n");
    }
    // Compared with spaces collapsed: the editor and the saved signature break lines differently.
    const flat = (t: string) => t.replace(/\s+/g, " ").trim();
    const sig = props.signatures.find((s) => s.id === sigId());
    return sig?.body.trim() ? flat(text).replace(flat(sig.body), "").trim() : flat(text);
  };

  const send = (done: boolean, at: number | null = null) => {
    // Whatever is still typed in a field counts as entered.
    const all = (list: string[], input?: HTMLInputElement) => [...list, ...splitAddresses(input?.value ?? "")];
    const recipients = { to: all(to(), toInput), cc: all(cc(), ccInput), bcc: all(bcc(), bccInput) };
    const everyone = [...recipients.to, ...recipients.cc, ...recipients.bcc];
    if (!everyone.length) return setProblem("Add someone to send it to.");
    const bad = everyone.filter((a) => !validAddress(a));
    if (bad.length) return setProblem(`${bad.join(", ")} does not look like an address.`);
    if (from() == null) return;
    if (!checks()) {
      const attached = files().length > 0 || forwardOf() != null;
      const said = settings.attachmentCheck && !attached ? mentionsAttachment(ownText(), attachmentWords(settings.attachmentWords)) : null;
      const noSubject = !subject().trim() && !props.init.inReplyTo;
      if (said || noSubject) return setChecks({ attachment: said, subject: noSubject });
    }
    clearTimeout(saveTimer);
    dirty = false;
    props.onSend(from()!, { ...draft(), ...recipients }, done, draftId, { at, followUp: followUp() });
  };

  const onKeyDown = (e: KeyboardEvent) => {
    const ctrl = e.ctrlKey || e.metaKey;
    if (e.key === "Escape" && sendMenu()) setSendMenu(false);
    else if (e.key === "Escape" && focusMode()) setFocusMode(false);
    else if (e.key === "Escape") void close();
    else if (ctrl && e.shiftKey && e.key.toLowerCase() === "f" && !props.init.inline) setFocusMode(!focusMode());
    else if (ctrl && e.shiftKey && e.key.toLowerCase() === "m" && !props.init.inline) (setFocusMode(false), props.onMinimize?.(true));
    else if (ctrl && e.key === "Enter") send(e.shiftKey);
    else if (ctrl && e.shiftKey && e.key.toLowerCase() === "l") setPicking("later");
    else if (ctrl && e.shiftKey && e.key.toLowerCase() === "h") setPicking("followUp");
    else if (ctrl && e.shiftKey && (e.key === "," || e.key === "<")) discard();
    else if (ctrl && e.shiftKey && e.key.toLowerCase() === "a") void pick();
    else if (ctrl && e.shiftKey && e.key.toLowerCase() === "s") cycleSignature();
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

  const words = () => (ownText().match(/\p{L}[\p{L}\p{N}'’-]*/gu) ?? []).length;
  const iconButton = (icon: Parameters<typeof Icon>[0]["name"], label: string, run: () => void, cls = "") => (
    <button type="button" class={`icon-button ${cls}`} title={label} aria-label={label} onClick={run}>
      <Icon name={icon} size={16} />
    </button>
  );
  /** The snippet picker, as if `;` was typed where the caret is. */
  const openSnippets = () => {
    if (!view) return;
    view.focus();
    view.dispatch(view.state.tr.insertText(";"));
  };

  const form = (
    <form
      class="compose"
      classList={{ inline: props.init.inline, focus: focusMode() }}
      onKeyDown={onKeyDown}
      onSubmit={(e) => (e.preventDefault(), send(false))}
    >
      <div class="compose-head">
        <Show when={props.accounts.length > 1}>
          <label class="from-pick" title="Send from">
            <span class="dot" style={{ background: from() != null ? colourOf(props.accounts, from()!) : undefined }} />
            <select aria-label="From" value={from()} onChange={(e) => changeFrom(Number(e.currentTarget.value))}>
              <For each={props.accounts}>
                {(a) => <option value={a.id}>{a.displayName ? `From ${a.displayName} · ${a.email}` : `From ${a.email}`}</option>}
              </For>
            </select>
            <Icon name="chevron-down" size={12} />
          </label>
        </Show>
        <Show when={focusMode()}>
          <span class="summary">{[to().length ? `To ${to().join(", ")}` : "", subject()].filter(Boolean).join(" · ")}</span>
        </Show>
        <span class="spacer" />
        <Show when={focusMode()}>
          <span class="saved">{words()} words</span>
        </Show>
        <span class="saved" aria-live="polite">
          <Show when={saveState() === "saved"}>
            <Icon name="check" size={12} /> Saved
          </Show>
          <Show when={saveState() === "saving"}>Saving…</Show>
        </span>
        <Show when={!props.init.inline}>
          <Show
            when={!focusMode()}
            fallback={
              <button type="button" class="exit-focus" onClick={() => setFocusMode(false)}>
                Exit focus <kbd>Esc</kbd>
              </button>
            }
          >
            {iconButton("minus", "Minimize (Ctrl+Shift+M)", () => props.onMinimize?.(true))}
            {iconButton("maximize", "Focus mode (Ctrl+Shift+F)", () => setFocusMode(true))}
          </Show>
        </Show>
        <Show when={!focusMode()}>{iconButton("x", "Close and keep the draft (Esc)", () => void close())}</Show>
      </div>
      <div class="fields">
        <RecipientField
          label="To"
          value={to()}
          onChange={(v) => (setTo(v), changed())}
          ref={(el) => (toInput = el)}
          outside={isOutside}
          after={
            <span class="cc-toggles">
              <Show when={!showCc()}>
                <button type="button" onClick={() => (setShowCc(true), queueMicrotask(() => ccInput?.focus()))} title="Cc (Ctrl+Shift+C)">
                  Cc
                </button>
              </Show>
              <Show when={!showBcc()}>
                <button type="button" onClick={() => (setShowBcc(true), queueMicrotask(() => bccInput?.focus()))} title="Bcc (Ctrl+Shift+B)">
                  Bcc
                </button>
              </Show>
            </span>
          }
        />
        <Show when={showCc()}>
          <RecipientField label="Cc" value={cc()} onChange={(v) => (setCc(v), changed())} ref={(el) => (ccInput = el)} outside={isOutside} />
        </Show>
        <Show when={showBcc()}>
          <RecipientField label="Bcc" value={bcc()} onChange={(v) => (setBcc(v), changed())} ref={(el) => (bccInput = el)} outside={isOutside} />
        </Show>
        <Show when={!props.init.inline || !props.init.inReplyTo}>
          <label class="field subject">
            <span class="label">Subject</span>
            <input value={subject()} onInput={(e) => (setSubject(e.currentTarget.value), changed())} />
          </label>
        </Show>
      </div>
      <Suspense fallback={<div class="editor-body" />}>
        <Show when={opening()}>
          {(start) => (
            <Editor
              text={start().body}
              html={start().html}
              autofocus={bodyFirst ? "start" : false}
              snippets={snippets}
              quoteOpen={props.init.quoteOpen}
              ref={editorReady}
              onChange={(text, rich) => (setBody(text), setHtml(rich), changed())}
            />
          )}
        </Show>
      </Suspense>
      <Show when={files().length || forwardOf()}>
        <div class="outgoing-files" aria-label="Attachments">
          <Show when={forwardOf()}>
            <span class="file-card" title="Attached from the forwarded message when it is sent">
              <span class="thumb">
                <Icon name="paperclip" size={18} />
              </span>
              <span class="meta">
                <span class="name">
                  {props.init.forwardFiles?.length
                    ? props.init.forwardFiles.map((f) => f.name).join(", ")
                    : "Attachments of the forwarded message"}
                </span>
              </span>
              <button type="button" class="remove" aria-label="Do not forward the attachments" onClick={() => (setForwardOf(null), changed())}>
                ×
              </button>
            </span>
          </Show>
          <For each={files()}>
            {(f, i) => (
              <span class="file-card" title={f.mime}>
                <span class="thumb">
                  <Show when={previews()[f.path]} fallback={<Icon name={f.mime.startsWith("image/") ? "image" : "file"} size={18} />}>
                    {(uri) => <img src={uri()} alt="" />}
                  </Show>
                </span>
                <span class="meta">
                  <span class="name">{f.name}</span>
                  <span class="size">{size(f.size)}</span>
                </span>
                <button
                  type="button"
                  class="remove"
                  aria-label={`Remove ${f.name}`}
                  onClick={() => (setFiles(files().filter((_, j) => j !== i())), changed())}
                >
                  ×
                </button>
              </span>
            )}
          </For>
        </div>
        <div class="size-meter" classList={{ near: total() > LARGE_BYTES * 0.7, over: total() > LARGE_BYTES }}>
          <span class="bar">
            <span style={{ width: `${Math.min(100, (total() / LARGE_BYTES) * 100)}%` }} />
          </span>
          <span>
            {size(total())} of 25 MB
            {total() > LARGE_BYTES
              ? ". Many servers refuse mail this big; send a link instead."
              : total() > LARGE_BYTES * 0.7
                ? ". Bigger files are better sent as a link."
                : ""}
          </span>
        </div>
      </Show>
      <Show when={dragging() && !props.minimized}>
        <div class="drop-zone" aria-hidden="true">
          <Icon name="download" size={28} />
          <strong>Drop to attach</strong>
        </div>
      </Show>
      <Show when={problem()}>
        <p class="error">{problem()}</p>
      </Show>
      <Show when={checks() || (outsiders().length && !outsideDismissed())}>
        <div class="checks">
          <Show when={checks()?.attachment}>
            {(word) => (
              <div class="check warn">
                <Icon name="paperclip" size={16} />
                <span class="text">You wrote “{word()}”, but nothing is attached.</span>
                <button type="button" class="solid" onClick={() => void pick()}>
                  Attach…
                </button>
                <button type="button" onClick={() => send(false)}>
                  Send anyway
                </button>
              </div>
            )}
          </Show>
          <Show when={checks()?.subject}>
            <div class="check warn">
              <Icon name="pen-line" size={16} />
              <span class="text">There's no subject.</span>
              <button type="button" onClick={() => send(false)}>
                Send anyway
              </button>
            </div>
          </Show>
          <Show when={outsiders().length && !outsideDismissed()}>
            <div class="check">
              <Icon name="globe" size={16} />
              <span class="text">
                {outsiders().length === 1 ? outsiders()[0] : `${outsiders().length} people`} {outsiders().length === 1 ? "is" : "are"} outside{" "}
                {sender() ? domainOf(sender()!) : "your organisation"}.
              </span>
              <button type="button" class="dismiss" aria-label="Dismiss" onClick={() => setOutsideDismissed(true)}>
                <Icon name="x" size={14} />
              </button>
            </div>
          </Show>
        </div>
      </Show>
      <footer>
        <div class="send-split" onFocusOut={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && setSendMenu(false)}>
          <button type="submit" class="primary">
            Send <kbd>Ctrl ↵</kbd>
          </button>
          <button
            type="button"
            class="primary more"
            aria-label="More ways to send"
            aria-haspopup="menu"
            aria-expanded={sendMenu()}
            onClick={() => setSendMenu(!sendMenu())}
          >
            <Icon name="chevron-down" size={14} />
          </button>
          <Show when={sendMenu()}>
            <div class="send-menu" role="menu">
              <button type="button" role="menuitem" onClick={() => (setSendMenu(false), send(true))}>
                Send & Done <kbd>Ctrl Shift ↵</kbd>
              </button>
              <button type="button" role="menuitem" onClick={() => (setSendMenu(false), setPicking("later"))}>
                Send later… <kbd>Ctrl Shift L</kbd>
              </button>
              <button type="button" role="menuitem" onClick={() => (setSendMenu(false), setPicking("followUp"))}>
                Remind me if no reply… <kbd>Ctrl Shift H</kbd>
              </button>
            </div>
          </Show>
        </div>
        <Show when={checks()}>
          <span class="hint">Ctrl ↵ again sends anyway</span>
        </Show>
        <Show when={followUp()}>
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
        <span class="tools">
          {iconButton("paperclip", "Attach files (Ctrl+Shift+A), or drop them here", () => void pick())}
          <Show when={snippetList().length}>{iconButton("file-text", "Snippet ( ; )", openSnippets)}</Show>
          <Show when={accountSignatures().length}>
            <label class="signature-pick" title="Signature (Ctrl+Shift+S)">
              <Icon name="pen-line" size={14} />
              <select
                aria-label="Signature"
                value={String(sigId() ?? "")}
                onChange={(e) => {
                  const id = Number(e.currentTarget.value);
                  void switchSignature(accountSignatures().find((s) => s.id === id) ?? null);
                }}
              >
                <For each={accountSignatures()}>{(s) => <option value={String(s.id)}>{s.name || "Untitled"}</option>}</For>
                <option value="">None</option>
              </select>
              <Icon name="chevron-down" size={12} />
            </label>
          </Show>
        </span>
        <span class="spacer" />
        {iconButton("trash", "Discard (Ctrl+Shift+,)", discard, "discard")}
      </footer>
    </form>
  );

  /** The folded compose: what it is and to whom, a click from opening again. */
  const card = (
    <div class="compose-card">
      <button type="button" class="open" onClick={() => props.onMinimize?.(false)} title="Open (Ctrl+Shift+M)">
        <span class="title">
          <Icon name="pen-line" size={14} />
          <span>{subject().trim() || "New message"}</span>
        </span>
        <span class="line">{to().length ? `To ${to().join(", ")}` : "No recipients yet"}</span>
        <span class="line faint">{ownText() || " "}</span>
        <Show when={saveState() === "saved"}>
          <span class="line saved">
            <Icon name="check" size={12} /> Saved
          </span>
        </Show>
      </button>
      <button type="button" class="close" aria-label="Close and keep the draft" title="Close and keep the draft" onClick={() => void close()}>
        <Icon name="x" size={14} />
      </button>
    </div>
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
        <div
          class="overlay compose-overlay"
          classList={{ minimized: props.minimized, focused: focusMode() }}
          onMouseDown={(e) => e.target === e.currentTarget && void close()}
        >
          {form}
        </div>
        <Show when={props.minimized}>{card}</Show>
      </Show>
      {picker}
    </>
  );
}
