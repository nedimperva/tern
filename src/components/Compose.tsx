import { createEffect, createMemo, createResource, createSignal, For, lazy, onCleanup, onMount, Show, Suspense } from "solid-js";
import type { EditorView } from "prosemirror-view";
import { TextSelection } from "prosemirror-state";
import { type Part, partsOf } from "../editor/outline";
import {
  api,
  type Account,
  type Draft,
  type ForwardOf,
  type OutgoingAttachment,
  type SendOptions,
  type Signature,
  type Snippet,
  type AiRecipient,
  type AiWritten,
  type AiSuggestion,
  type Contact,
} from "../api";
import { Portal } from "solid-js/web";
import { aiSlot, setAiSide, setAiSlot, setReplyDraft } from "../app/state";
import { fillSnippet } from "../snippets";
import { attachmentWords, domainOf, mentionsAttachment, outside } from "../attachmentWords";
import { colourOf } from "../colours";
import { aiOn, settings } from "../settings";
import { until } from "./ConversationRow";
import { SnoozePicker } from "./SnoozePicker";
import type { SnippetSource } from "./Editor";
import { Icon } from "./Icon";
import { wordDiff } from "../wordDiff";
import { HtmlFrame } from "./HtmlFrame";
// The editor is a chunk of its own (ProseMirror is most of its weight); App loads it once the list is up.
const Editor = lazy(() => import("./Editor").then((m) => ({ default: m.Editor })));
import { RecipientField, splitAddresses, validAddress } from "./RecipientField";

export type ComposeInit = {
  accountId?: number;
  /** One of the account's aliases to send as; none sends as the account's address. */
  from?: string | null;
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
  /** A reply: the message answered, for the AI sidebar's Starts (suggested replies). */
  aiReplyTo?: number;
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
  /** A saved draft's HTML signature, shown under the text again. */
  htmlSignature?: number | null;
};

/** A From picker line: "From Ada · ada@example.com". */
const fromLabel = (name: string, email: string) => (name ? `From ${name} · ${email}` : `From ${email}`);

/** The signature of `accountId` for new mail or for replies, if it has one. */
export function defaultSignature(all: Signature[], accountId: number | undefined, kind: "new" | "reply") {
  return all.find((s) => s.accountId === accountId && (kind === "new" ? s.forNew : s.forReply)) ?? null;
}

/** Signature work needs the editor's document model, so it loads with the editor, not with the app. */
const signatureTools = () => import("../signature");
const schemaTools = () => import("../editor/schema");

/** Above this a message may bounce: many servers take 25 MB at most. */
const LARGE_BYTES = 25_000_000;
/** From here on a mail counts as long: compose widens and shows its outline. */
const LONG_WORDS = 150;


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
  // The alias it goes out as, spelled as the account lists it; null is the account's own address.
  const aliasOf = (accountId: number | undefined, address: string | null | undefined) => {
    const key = address?.trim().toLowerCase();
    return props.accounts.find((a) => a.id === accountId)?.aliases?.find((x) => x.email.toLowerCase() === key)?.email ?? null;
  };
  const [alias, setAlias] = createSignal(aliasOf(from(), props.init.from));
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
  const [sigId, setSigId] = createSignal<number | null>(props.init.signature?.id ?? props.init.htmlSignature ?? null);
  // An HTML signature (pasted from another mail app) isn't in the text: it shows under it and joins it on the way out.
  const htmlSig = () => {
    const s = props.signatures.find((x) => x.id === sigId());
    return s?.custom && s.html ? s : null;
  };
  // An HTML signature folds to one line like a text one (Editor's signatureFold).
  const [htmlSigOpen, setHtmlSigOpen] = createSignal(false);
  const sigBelow = () => props.init.signature?.below ?? (settings.signatureBelow && !!props.init.inReplyTo);
  let tools: Awaited<ReturnType<typeof signatureTools>> | undefined;
  void signatureTools().then((t) => (tools = t));
  const sigKind = props.init.signature?.kind ?? (props.init.inReplyTo ? "reply" : "new");
  const accountSignatures = () => props.signatures.filter((s) => s.accountId === from());
  let view: EditorView | undefined;
  let formEl: HTMLFormElement | undefined;
  // The view arrives after the first render; what reads it (ownText) runs again then.
  const [ready, setReady] = createSignal(false);
  const editorReady = (v: EditorView) => {
    view = v;
    setReady(true);
    // An inline reply opens below the whole conversation; the editor takes the focus without scrolling (ProseMirror
    // focuses that way), so bring the reply into view, the end of the message above it still showing.
    if (props.init.inline) {
      const smooth = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      requestAnimationFrame(() => formEl?.scrollIntoView({ block: "start", behavior: smooth ? "smooth" : "auto" }));
    }
    // A saved draft: find which of the account's signatures it holds, so switching replaces that one.
    if (props.init.signature || props.init.htmlSignature) return;
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
    const blocks = next && !next.custom ? signatureDoc(next).content : null;
    if (at) view.dispatch(blocks ? state.tr.replaceWith(at.from, at.to, blocks) : state.tr.delete(at.from, at.to));
    else if (blocks) {
      const below = props.init.signature?.below ?? false;
      view.dispatch(state.tr.insert(signaturePlace(state.doc, below), blocks));
    }
    setSigId(next?.id ?? null);
    // The text did not change, but what goes out did.
    if (current?.custom || next?.custom) changed();
  };
  /** Ctrl+Shift+S: the account's next signature, then none, then round again. */
  const cycleSignature = () => {
    const list = accountSignatures();
    if (!list.length) return;
    const i = list.findIndex((s) => s.id === sigId());
    void switchSignature(i + 1 < list.length ? list[i + 1] : null);
  };
  /** Writing from another account brings its signature, when the one in the text was the old account's. The
   * picker's value is the account's id, then a space and the alias when it is one. */
  const changeFrom = (picked: string) => {
    const [id, address] = picked.split(" ");
    const accountId = Number(id);
    const old = props.signatures.find((s) => s.id === sigId());
    setAlias(aliasOf(accountId, address));
    setFrom(accountId);
    changed();
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
  /** Kept files become pictures in the text, each under a Content-ID of its own. */
  const asPictures = (kept: OutgoingAttachment[], names: string[] = []) => {
    const named = kept.map((f, i) => ({ ...f, cid: `${crypto.randomUUID()}@tern`, name: names[i] || f.name }));
    setFiles([...files(), ...named]);
    changed();
    return named.map((f) => ({ cid: f.cid, alt: f.name }));
  };
  /** Pictures pasted into the text (or dropped on it in a browser). */
  const pictures = async (pasted: File[]) => {
    try {
      return asPictures(await Promise.all(pasted.map((p) => api.addImage(p))), pasted.map((p) => p.name));
    } catch (e) {
      setProblem(`Could not put the picture in: ${e}`);
      return [];
    }
  };
  /** Files dropped on the window: pictures dropped on the text go in it, everything else is attached. */
  const dropped = async (paths: string[], at: { x: number; y: number } | null) => {
    const box = formEl?.querySelector(".editor-body")?.getBoundingClientRect();
    const onText = !!(at && box && view && at.x >= box.left && at.x <= box.right && at.y >= box.top && at.y <= box.bottom);
    const picture = (p: string) => onText && /\.(png|jpe?g|gif|webp)$/i.test(p);
    void attach(paths.filter((p) => !picture(p)));
    const shown = paths.filter(picture);
    if (!shown.length) return;
    try {
      const placed = asPictures(await api.addAttachments(shown));
      const { insertPictures } = await import("../editor/schema");
      if (view) insertPictures(view, placed, at!);
    } catch (e) {
      setProblem(`Could not attach: ${e}`);
    }
  };
  // Files dragged over the window: the drop zone shows while they are.
  const [dragging, setDragging] = createSignal(false);
  onMount(() => onCleanup(api.onFilesDropped((paths, at) => void dropped(paths, at), setDragging)));
  /** The pictures in the text, by Content-ID, as their previews. */
  const shownPictures = () =>
    Object.fromEntries(files().flatMap((f) => (f.cid && previews()[f.path] ? [[f.cid, previews()[f.path]]] : [])));
  /** Files that show as cards: pictures in the text show there instead. */
  const cards = () => files().filter((f) => !f.cid);
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
  // Read once: `init` is gone by the time compose is cleaned up.
  const inline = !!props.init.inline;
  // An inline reply's draft is written here, so the conversation above leaves its copy out meanwhile.
  let gone = false;
  if (inline) setReplyDraft(draftId);
  onCleanup(() => ((gone = true), inline && setReplyDraft(null)));
  // Reopened after undo-send, what is here may never have been saved.
  let dirty = props.init.unsaved ?? false;
  let saveTimer: number | undefined;
  const draft = (): Draft => {
    const sig = htmlSig();
    const out = sig && view && tools ? tools.withHtmlSignature(view.state.doc, sig, sigBelow()) : null;
    return {
      from: alias(),
      to: to(),
      cc: cc(),
      bcc: bcc(),
      subject: subject(),
      body: body(),
      html: html(),
      inReplyTo: props.init.inReplyTo ?? null,
      references: props.init.references ?? [],
      // A picture taken out of the text again is left behind (undo in the text can still bring it back).
      attachments: files().filter((f) => !f.cid || (html() ?? "").includes(`cid:${f.cid}`)),
      forwardOf: forwardOf(),
      htmlSignature: sig?.id ?? null,
      outBody: out?.body ?? null,
      outHtml: out?.html ?? null,
    };
  };
  /** Saves the draft, if there is anything to keep. */
  const save = async (uploadNow: boolean) => {
    clearTimeout(saveTimer);
    if (!dirty || from() == null) return;
    setSaveState("saving");
    try {
      draftId = await api.saveDraft(draftId, from()!, draft(), uploadNow);
      // A save still on its way when compose closed must not hide the draft again.
      if (inline && !gone) setReplyDraft(draftId);
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

  const sender = () => alias() ?? props.accounts.find((a) => a.id === from())?.email;
  const isOutside = (address: string) => outside(address, sender());
  /** Outside recipients, when they are mixed with people from the sender's own organisation. */
  const outsiders = () => {
    const everyone = [...to(), ...cc(), ...bcc()];
    const out = everyone.filter(isOutside);
    return out.length && out.length < everyone.length ? out : [];
  };
  /** What the person wrote themselves: not the quoted message, not the signature. */
  const ownText = () => {
    ready();
    let text = body();
    if (view) {
      const parts: string[] = [];
      // Line breaks as text too, or the signature's lines run together and are not found below.
      const doc = view.state.doc;
      doc.forEach((node, _, i) => {
        // Not the quote, nor the "On …, Ada wrote:" line just above it.
        const attribution = doc.maybeChild(i + 1)?.type.name === "blockquote" && /:\s*$/.test(node.textContent);
        if (node.type.name !== "blockquote" && !attribution) parts.push(node.textBetween(0, node.content.size, "\n", "\n"));
      });
      text = parts.join("\n");
    }
    // Compared with spaces collapsed: the editor and the saved signature break lines differently.
    const flat = (t: string) => t.replace(/\s+/g, " ").trim();
    const sig = props.signatures.find((s) => s.id === sigId());
    return sig?.body.trim() ? flat(text).replace(flat(sig.body), "").trim() : flat(text);
  };

  const send = (done: boolean, at: number | null = null) => {
    // A try waiting to be kept or dropped is not what the person means to send yet.
    if (pending() || aiBusy()) return setAiHold(true);
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

  // Writing help (package 10): a sidebar beside the text, opened with Ctrl+J, the AI keycap or Space in an empty
  // draft. It is not a chat. The Brief is one note the person edits and writes from again; Reshape reworks their
  // words (or the selection); in a reply, Starts offers the suggested replies. Each answer is a try, shown in the
  // text's place but not in the email, until the person keeps it (Tab) or drops it (Esc). In new mail the answer also
  // names people, matched in the contacts on this computer, and the person adds each one. Nothing here sends.
  const aiAllowed = () => aiOn("writing", from());
  const newMail = () => !props.init.inReplyTo && !props.init.forwardOf;
  /** `request` is what went to the model; `said` what it is called (a chip's own name). */
  /** `base`: the text a tone ask reworked, to show what it changed. */
  type Version = { request: string; said: string; written: AiWritten | null; streamed: string; error?: string; base?: string };
  const [aiOpen, setAiOpen] = createSignal(false);
  const [versions, setVersions] = createSignal<Version[]>([]);
  // The try on show; the newest unless the person stepped back.
  const [shown, setShown] = createSignal(0);
  /** The Brief: what the email should say. It stays after writing, to edit and write again. */
  const [aiAsk, setAiAsk] = createSignal("");
  const [aiBusy, setAiBusy] = createSignal(false);
  // Send was pressed while a try waited to be kept or dropped.
  const [aiHold, setAiHold] = createSignal(false);
  const [hasStyle, setHasStyle] = createSignal(false);
  /** "In your style", for this compose only. */
  const [inStyle, setInStyle] = createSignal(true);
  /** New mail: the people the latest answer named. They stay after a keep, to add one by one. */
  const [found, setFound] = createSignal<{ to: AiRecipient[]; cc: AiRecipient[] } | null>(null);
  /** Suggested replies, for Starts: none asked yet, being asked, the list, or what went wrong. */
  const [starts, setStarts] = createSignal<AiSuggestion[] | "busy" | { error: string } | null>(null);
  let aiInput: HTMLTextAreaElement | undefined;
  let asideEl: HTMLElement | undefined;
  let aiRun = 0;
  const current = () => versions()[shown()];
  const pending = () => versions().some((v) => v.written);
  /** The try in the text's place, while it streams or once written. */
  const tryShown = () => {
    const v = current();
    return v && !v.error && (v.written || bodyOf(v.streamed)) ? v : null;
  };
  const inSide = (e: Event) => !!asideEl && e.target instanceof Node && asideEl.contains(e.target);
  const openAi = () => {
    if (!aiAllowed()) return;
    setAiOpen(true);
    void api.aiStyle(from()!).then((s) => setHasStyle(!!s && settings.ai.voice), () => setHasStyle(false));
    queueMicrotask(() => aiInput?.focus());
  };
  /** Esc with a try on show: every try goes; the email is as it was. */
  const dropTries = () => {
    aiRun++;
    setVersions([]);
    setShown(0);
    setAiBusy(false);
    setAiHold(false);
  };
  /** Esc with nothing on show, or the sidebar's ×. */
  const closeAi = () => {
    dropTries();
    setAiOpen(false);
    setAiAsk("");
    setFound(null);
    view?.focus();
  };
  // An inline reply's sidebar takes the companion's place for as long as it is open.
  createEffect(() => {
    if (!inline) return;
    setAiSide(aiOpen());
    if (!aiOpen()) setAiSlot(null);
  });
  onCleanup(() => inline && (setAiSide(false), setAiSlot(null)));
  /** Where the person's own words end: before the signature or the quote, whichever comes first. */
  const ownPart = async () => {
    if (!view) return null;
    const { findSignature, signaturePlace } = await signatureTools();
    const doc = view.state.doc;
    let end = signaturePlace(doc, false);
    const sig = props.signatures.find((x) => x.id === sigId());
    const at = sig ? findSignature(doc, sig) : null;
    if (at && at.from < end) end = at.from;
    return { end, text: doc.textBetween(0, end, "\n\n", "\n").trim() };
  };
  /** The body as it streams: in new mail, the header lines before "===" are not the email's words. */
  const bodyOf = (streamed: string) => {
    if (!newMail()) return streamed;
    const at = streamed.indexOf("\n===");
    return at < 0 ? "" : streamed.slice(at + 4).replace(/^=*\s*/, "");
  };
  /** What is selected of the person's own words, for a Reshape that should change only that. */
  const selected = (end: number) => {
    if (!view || versions().length) return "";
    const { from: a, to: b } = view.state.selection;
    return b > a && a < end ? view.state.doc.textBetween(a, Math.min(b, end), "\n\n", "\n").trim() : "";
  };
  /** Asks for a try: what the Brief says, or what a chip asks. */
  const askAi = async (chip?: { label: string; request: string }) => {
    if (aiBusy()) return;
    let request = chip?.request ?? aiAsk().trim();
    const own = await ownPart();
    if (!own || !view) return;
    if (!request && !own.text && !versions().length) {
      aiInput?.focus();
      return;
    }
    const part = chip ? selected(own.end) : "";
    if (part) request += ` Change only this part and keep the rest word for word: "${part}"`;
    // Asking again after stepping back starts from that try: the later ones give way.
    const earlier = versions().slice(0, shown() + 1).filter((v) => v.written);
    const { toText } = await schemaTools();
    const quoted = props.init.inReplyTo
      ? toText(view.state.doc)
          .split("\n")
          .filter((l) => l.startsWith(">"))
          .join("\n")
      : "";
    const run = ++aiRun;
    const asked = request || (versions().length ? "Again, differently." : "Write this out as a full email.");
    // A tone ask reworks the try on show, or the person's own words: that is what its change is shown against.
    const base = chip && TONES.has(chip.label) ? (earlier[earlier.length - 1]?.written?.body ?? own.text) || undefined : undefined;
    setVersions([...earlier, { request: asked, said: chip?.label ?? asked, written: null, streamed: "", base }]);
    setShown(earlier.length);
    setAiBusy(true);
    setAiHold(false);
    const update = (patch: Partial<Version>) =>
      run === aiRun && setVersions((list) => list.map((v, i) => (i === list.length - 1 ? { ...v, ...patch } : v)));
    try {
      const written = await api.aiWrite(
        {
          accountId: from()!,
          draft: own.text,
          request: asked,
          inReplyTo: props.init.inReplyTo ?? null,
          replyingTo: quoted || null,
          turns: earlier.map((v) => ({ request: v.request, wrote: v.written!.body })),
          newMail: newMail(),
          plain: !inStyle(),
        },
        (t) => update({ streamed: (versions()[versions().length - 1]?.streamed ?? "") + t }),
      );
      update({ written });
      if (run === aiRun && newMail() && (written.to.length || written.cc.length)) setFound({ to: written.to, cc: written.cc });
    } catch (e) {
      update({ error: String(e) });
    } finally {
      if (run === aiRun) {
        setAiBusy(false);
        queueMicrotask(() => aiInput?.focus());
      }
    }
  };
  /** The Brief's Write: from what it says, or, left empty, as the button's name says. */
  const writeFromBrief = () =>
    aiAsk().trim() ? void askAi() : void askAi({ label: chipLabel("Write it out"), request: chipRequest("Write it out", AI_CHIPS[0][1]) });
  /** Starts: the suggested replies to the message answered, on request. */
  const askStarts = async () => {
    const id = props.init.aiReplyTo;
    if (id == null || starts() === "busy") return;
    setStarts("busy");
    try {
      setStarts(await api.aiReplies(id, false, () => {}));
    } catch (e) {
      setStarts({ error: String(e) });
    }
  };
  /** A start becomes a try like any other, to keep or drop. */
  const pickStart = (s: AiSuggestion) => {
    aiRun++;
    setAiBusy(false);
    setVersions([{ request: `Start with: ${s.label}`, said: s.label, written: { body: s.text, subject: null, to: [], cc: [] }, streamed: "" }]);
    setShown(0);
    queueMicrotask(() => aiInput?.focus());
  };
  /** Tab: the try on show goes into the email as ordinary text (Ctrl+Z in the editor brings back what was there);
   * in new mail its subject too, when there is none. People are added one by one from the sidebar. */
  const keepAi = async () => {
    const w = current()?.written;
    const own = await ownPart();
    if (!w || !own || !view) return;
    const { fromText } = await schemaTools();
    view.dispatch(view.state.tr.replaceWith(0, own.end, fromText(w.body).content));
    if (newMail() && w.subject && !subject().trim()) setSubject(w.subject);
    changed();
    dropTries();
    view.focus();
  };
  /** Adds someone the AI named. A stranger never gets here: an address only the AI came up with may have been planted
   * in what it read. */
  const addPerson = (field: "to" | "cc", r: AiRecipient) => {
    if (!r.address || r.stranger) return;
    const list = field === "to" ? to() : cc();
    if (list.some((a) => a.toLowerCase() === r.address!.toLowerCase())) return;
    if (field === "to") setTo([...list, r.address]);
    else (setCc([...list, r.address]), setShowCc(true));
    changed();
  };
  const added = (r: AiRecipient) => !!r.address && [...to(), ...cc()].some((a) => a.toLowerCase() === r.address!.toLowerCase());
  /** "2 people called Ana": another of them in place of the one picked. */
  const pickPerson = (field: "to" | "cc", index: number, person: Contact) =>
    setFound((f) => {
      if (!f) return f;
      const people = f[field].map((r, k) =>
        k === index && r.address
          ? { ...r, address: person.email, name: person.name, others: [{ email: r.address, name: r.name }, ...r.others.filter((o) => o.email !== person.email)] }
          : r,
      );
      return { ...f, [field]: people };
    });
  /** No words of the person's own yet: only the signature and what is quoted or forwarded, if anything. */
  const ownEmpty = () =>
    !ownText()
      .replace(/On .+ wrote:\s*$/s, "")
      .replace(/-{5,} Forwarded message -{5,}[\s\S]*/, "")
      // The "-- " line a signature starts with.
      .replace(/(^|\s)--(?=\s|$)/g, " ")
      .trim();
  /** "Write it out" is the Brief's button: from the draft, or in an empty reply from the conversation. The rest are
   * Reshape: on a try they rework it, else the person's own words. */
  const AI_CHIPS = [
    ["Write it out", "Write this out as a full email."],
    ["Shorter", "Make it shorter."],
    ["Warmer", "Make it warmer and friendlier, still in my voice."],
    ["Firmer", "Make it firmer and more direct, still polite."],
    ["More formal", "Make it more formal."],
    ["Fix grammar", "Fix spelling and grammar only. Change nothing else."],
  ] as const;
  /** Quick asks that rework words already there: their try shows what it changed. */
  const TONES = new Set(["Shorter", "Warmer", "Firmer", "More formal", "Fix grammar"]);
  const nothingYet = () => !versions().length && ownEmpty();
  // A draft that is a few points ("- totals confirmed") is written out from them, keeping each: a list of two or more,
  // and no paragraph of the person's own beside it (the signature and a reply's "wrote:" line aside).
  const points = () => {
    body();
    if (versions().length || !view) return false;
    const flat = (t: string) => t.replace(/\s+/g, " ").trim();
    const sig = flat(props.signatures.find((s) => s.id === sigId())?.body ?? "");
    let items = 0;
    let prose = 0;
    view.state.doc.forEach((n) => {
      if (n.type.name === "blockquote") return;
      if (n.type.name === "bullet_list" || n.type.name === "ordered_list") items += n.childCount;
      else {
        const t = flat(n.textBetween(0, n.content.size, "\n", "\n"));
        if (t && !/^--(\s|$)/.test(t) && !sig.includes(t) && !/wrote:$/.test(t)) prose++;
      }
    });
    return items >= 2 && prose === 0;
  };
  const chipLabel = (label: string) =>
    label !== "Write it out" ? label : points() ? "Write out these points" : nothingYet() ? (props.init.inReplyTo ? "Write a reply" : "Write it out") : label;
  const chipRequest = (label: string, request: string) =>
    label !== "Write it out"
      ? request
      : points()
        ? "Write these points out as a full email. Keep every point, in this order, and add nothing they don't say."
        : nothingYet() && props.init.inReplyTo
          ? "Write a reply to the newest message."
          : request;
  /** Languages Reshape can translate into. */
  const LANGUAGES = ["English", "Bosnian", "Croatian", "Serbian", "German", "French", "Italian", "Spanish"];
  /** Space at the start of an empty draft (its first line, nothing written yet) asks AI instead. */
  const spaceAsks = (e: KeyboardEvent) => {
    if (e.key !== " " || e.ctrlKey || e.metaKey || e.altKey || aiOpen() || !aiAllowed() || !view || !view.hasFocus()) return false;
    const $from = view.state.selection.$from;
    return view.state.selection.empty && $from.depth === 1 && $from.index(0) === 0 && $from.parent.content.size === 0;
  };

  const onKeyDown = (e: KeyboardEvent) => {
    const ctrl = e.ctrlKey || e.metaKey;
    // Nothing in the sidebar sends, and Enter in a field (Subject, an empty To) never submits the form.
    if (e.key === "Enter" && ((ctrl && inSide(e)) || (!ctrl && e.target instanceof HTMLInputElement))) return e.preventDefault();
    if (e.key === "Escape" && aiOpen()) versions().length ? (dropTries(), aiInput?.focus()) : closeAi();
    else if (ctrl && !e.shiftKey && e.key.toLowerCase() === "j" && aiAllowed()) aiOpen() && inSide(e) ? closeAi() : openAi();
    else if (spaceAsks(e)) openAi();
    else if (e.key === "Escape" && sendMenu()) setSendMenu(false);
    else if (e.key === "Escape" && focusMode()) setFocusMode(false);
    else if (e.key === "Escape") void close();
    else if (ctrl && e.shiftKey && e.key.toLowerCase() === "f" && !props.init.inline) setFocusMode(!focusMode());
    else if (ctrl && e.shiftKey && e.key.toLowerCase() === "m" && !props.init.inline) (setFocusMode(false), props.onMinimize?.(true));
    else if (ctrl && e.shiftKey && e.key.toLowerCase() === "o" && !props.init.inline) (setOutlinePref(!long()), aiOpen() && closeAi());
    else if (e.altKey && !ctrl && (e.key === "ArrowUp" || e.key === "ArrowDown") && view?.hasFocus()) stepPart(e.key === "ArrowUp" ? -1 : 1);
    else if (ctrl && e.key === "Enter") send(e.shiftKey);
    else if (ctrl && e.shiftKey && e.key.toLowerCase() === "l") setPicking("later");
    else if (ctrl && e.shiftKey && e.key.toLowerCase() === "h") setPicking("followUp");
    // By the key, not the character: Shift+, types "<" on US keyboards and ";" on Bosnian ones.
    else if (ctrl && e.shiftKey && e.code === "Comma") discard();
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

  // While the person types, the tools step back; a pause, the mouse or a Tab into them brings them again.
  const [typing, setTyping] = createSignal(false);
  let typingTimer: number | undefined;
  const typed = () => {
    setTyping(true);
    clearTimeout(typingTimer);
    typingTimer = window.setTimeout(() => setTyping(false), 1200);
  };
  onCleanup(() => clearTimeout(typingTimer));

  // Long-mail mode: past LONG_WORDS a dialog compose widens and lists the mail's parts beside the text. It only
  // folds back 30 words lower, so cutting a sentence doesn't make the page jump; Ctrl+Shift+O opens or hides it.
  const [outlinePref, setOutlinePref] = createSignal<boolean | null>(null);
  const [grown, setGrown] = createSignal(false);
  createEffect(() => {
    const n = words();
    if (n >= LONG_WORDS) setGrown(true);
    else if (n < LONG_WORDS - 30) setGrown(false);
  });
  const long = () => !props.init.inline && !focusMode() && !aiOpen() && (outlinePref() ?? grown());
  // The top-level block the caret is in, for the outline's highlight.
  const [at, setAt] = createSignal(-1);
  const caret = () => view && setAt(view.state.selection.$from.index(0));
  onMount(() => {
    const moved = () => view?.hasFocus() && caret();
    document.addEventListener("selectionchange", moved);
    onCleanup(() => document.removeEventListener("selectionchange", moved));
  });
  const parts = createMemo<Part[]>(() => {
    body();
    return long() && view ? partsOf(view.state.doc, props.signatures.find((s) => s.id === sigId())?.body ?? "") : [];
  });
  const [askSeen, setAskSeen] = createSignal(false);
  /** The first part that asks something, when it sits below the first part of a mail long enough to skim. */
  const lateAsk = () => {
    const all = parts();
    const rest = all.filter((p) => !p.greeting);
    const k = rest.findIndex((p) => p.ask);
    return !askSeen() && rest.length >= 3 && k >= 1 ? { part: rest[k], n: all.indexOf(rest[k]) + 1, of: all.length, top: rest[0] } : null;
  };
  /** Moves a top-level block to just before `before` (a position in the current doc), the caret going with it. */
  const movePart = (pos: number, before: number) => {
    if (!view || pos === before) return;
    const node = view.state.doc.nodeAt(pos);
    if (!node) return;
    const tr = view.state.tr.delete(pos, pos + node.nodeSize);
    const to = tr.mapping.map(before);
    tr.insert(to, node);
    tr.setSelection(TextSelection.near(tr.doc.resolve(to + 1))).scrollIntoView();
    view.dispatch(tr);
    view.focus();
    caret();
  };
  const jump = (p: Part) => {
    if (!view) return;
    view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(p.pos + 1))).scrollIntoView());
    view.focus();
    caret();
  };
  /** Alt+↑/↓: the block the caret is in swaps with the one above or below; the quote at the end stays put. */
  const stepPart = (dir: -1 | 1) => {
    if (!view) return;
    const { doc, selection } = view.state;
    const i = selection.$from.index(0);
    const j = i + dir;
    if (j < 0 || j >= doc.childCount || doc.child(i).type.name === "blockquote" || doc.child(j).type.name === "blockquote") return;
    const first = Math.min(i, j);
    let pos = 0;
    for (let k = 0; k < first; k++) pos += doc.child(k).nodeSize;
    const a = doc.child(first);
    const b = doc.child(first + 1);
    const offset = selection.from - (dir === -1 ? pos + a.nodeSize : pos);
    const tr = view.state.tr.replaceWith(pos, pos + a.nodeSize + b.nodeSize, [b, a]);
    const start = dir === -1 ? pos : pos + b.nodeSize;
    tr.setSelection(TextSelection.near(tr.doc.resolve(start + offset))).scrollIntoView();
    view.dispatch(tr);
    caret();
  };
  // Reordering in the outline by pointer, not HTML drag and drop: the shell takes drops for files on Windows.
  const [dragged, setDragged] = createSignal<number | null>(null);
  const [dragOver, setDragOver] = createSignal<number | null>(null);
  const grab = (e: PointerEvent, k: number) => {
    if (e.button !== 0) return;
    const x0 = e.clientX;
    const y0 = e.clientY;
    let moving = false;
    const move = (m: PointerEvent) => {
      if (!moving && Math.abs(m.clientY - y0) + Math.abs(m.clientX - x0) < 5) return;
      moving = true;
      setDragged(k);
      const li = document.elementFromPoint(m.clientX, m.clientY)?.closest<HTMLElement>(".outline li");
      setDragOver(li ? Number(li.dataset.k) : null);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      const to = dragOver();
      const list = parts();
      setDragged(null);
      setDragOver(null);
      if (!moving) return jump(list[k]);
      if (to == null || to === k || !list[to]) return;
      // Dragged down, it lands after the part it is dropped on; dragged up, before it.
      movePart(list[k].pos, to > k ? list[to].pos + list[to].size : list[to].pos);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const outline = () => (
    <aside class="outline" aria-label="Outline">
      <div class="outline-head">
        <span>Outline</span>
        <span class="faint">drag to move</span>
        <span class="spacer" />
        <button type="button" class="link" title="Hide the outline (Ctrl+Shift+O)" onClick={() => (setOutlinePref(false), view?.focus())}>
          Hide
        </button>
      </div>
      <ol>
        <For each={parts()}>
          {(p, k) => (
            <li
              data-k={k()}
              classList={{ current: p.index === at(), heading: p.heading, greeting: p.greeting, dragged: dragged() === k(), over: dragOver() === k() && dragged() !== k() }}
            >
              <button
                type="button"
                title="Go there; drag to move it. Alt+↑/↓ moves the part you're in."
                onPointerDown={(e) => grab(e, k())}
                onClick={(e) => e.detail === 0 && jump(p)}
              >
                <span class="num">{k() + 1}</span>
                <span class="label">{p.label}</span>
                <Show when={p.ask}>
                  <span class="tag">asks</span>
                </Show>
              </button>
            </li>
          )}
        </For>
      </ol>
      <span class="spacer" />
      <Show when={lateAsk()} keyed>
        {(l) => (
          <div class="outline-check">
            <span>
              Your question is in part {l.n} of {l.of}. Most people read the first part closely.
            </span>
            <span class="row">
              <button type="button" class="link" onClick={() => (movePart(l.part.pos, l.top.pos), setAskSeen(true))}>
                Move it up
              </button>
              <button type="button" class="link" onClick={() => setAskSeen(true)}>
                Leave it
              </button>
            </span>
          </div>
        )}
      </Show>
      <span class="outline-foot">
        {words()} words · about {Math.max(1, Math.round(words() / 230))} min to read
      </span>
    </aside>
  );
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

  /** The AI sidebar: beside the text in the dialog, in the companion's place for an inline reply. */
  const side = () => (
    <aside class="ai-side" ref={asideEl} aria-label="Writing help">
      <header>
        <kbd class="ai-mark">AI</kbd>
        <strong>Writing help</strong>
        <span class="spacer" />
        <kbd>Ctrl J</kbd>
        {iconButton("x", "Close (Esc)", closeAi)}
      </header>
      <div class="ai-side-body">
        <Show when={props.init.aiReplyTo != null && aiOn("replies", from())}>
          <section>
            <h3>Starts</h3>
            <Show
              when={Array.isArray(starts()) ? (starts() as AiSuggestion[]) : null}
              fallback={
                <Show
                  when={starts() === "busy"}
                  fallback={
                    <>
                      <Show when={starts() && typeof starts() === "object" && !Array.isArray(starts()) ? (starts() as { error: string }).error : null}>
                        {(error) => <p class="ai-error">{error()}</p>}
                      </Show>
                      <button type="button" class="ai-side-button" onClick={() => void askStarts()}>
                        Suggest how to answer
                      </button>
                    </>
                  }
                >
                  <p class="hint">Thinking of replies…</p>
                </Show>
              }
            >
              {(list) => (
                <For each={list()}>
                  {(s) => (
                    <button type="button" class="ai-start" title={s.text} onClick={() => pickStart(s)}>
                      {s.label}
                    </button>
                  )}
                </For>
              )}
            </Show>
          </section>
        </Show>
        <section>
          <h3>Brief</h3>
          <label class="ai-brief">
            <span class="hint">
              {newMail() ? "Who it goes to and what it should say." : "What should the answer say?"} One note, not a chat: change
              it and write again.
            </span>
            <textarea
              ref={aiInput}
              rows={3}
              value={aiAsk()}
              placeholder={newMail() ? "ask marko to sign off october freight, cc lejla" : "yes to friday, ask for the file"}
              onInput={(e) => setAiAsk(e.currentTarget.value)}
              onKeyDown={(e) => {
                const ctrl = e.ctrlKey || e.metaKey;
                if (e.key === "Enter" && !e.shiftKey && !ctrl) {
                  e.preventDefault();
                  e.stopPropagation();
                  writeFromBrief();
                } else if (e.key === "Tab" && !e.shiftKey && current()?.written) {
                  e.preventDefault();
                  e.stopPropagation();
                  void keepAi();
                } else if (e.altKey && e.key === "ArrowUp" && shown() > 0) {
                  e.preventDefault();
                  setShown(shown() - 1);
                } else if (e.altKey && e.key === "ArrowDown" && shown() < versions().length - 1) {
                  e.preventDefault();
                  setShown(shown() + 1);
                }
              }}
            />
          </label>
          <div class="ai-brief-row">
            <button type="button" class="ai-side-button" disabled={aiBusy()} onClick={writeFromBrief}>
              {aiAsk().trim() ? (versions().length ? "Write again" : "Write") : chipLabel("Write it out")} <kbd>↵</kbd>
            </button>
            <span class="spacer" />
            <Show when={versions().length > 1}>
              <span class="ai-tries">
                <button type="button" class="link" aria-label="Earlier try (Alt+↑)" disabled={shown() === 0} onClick={() => setShown(shown() - 1)}>
                  ‹
                </button>
                Try {shown() + 1} of {versions().length}
                <button
                  type="button"
                  class="link"
                  aria-label="Later try (Alt+↓)"
                  disabled={shown() >= versions().length - 1}
                  onClick={() => setShown(shown() + 1)}
                >
                  ›
                </button>
              </span>
            </Show>
          </div>
          <Show when={current()?.error}>{(error) => <p class="ai-error">{error()}</p>}</Show>
        </section>
        <section>
          <h3>Reshape</h3>
          <span class="hint">Works on the try on show, your selection, or all your own words.</span>
          <div class="ai-chips">
            <For each={AI_CHIPS.filter(([l]) => TONES.has(l))}>
              {([label, request]) => (
                <button type="button" class="chip" disabled={aiBusy() || (ownEmpty() && !versions().length)} onClick={() => void askAi({ label, request })}>
                  {label}
                </button>
              )}
            </For>
            <label class="chip translate">
              <span class="visually-hidden">Translate into</span>
              <select
                disabled={aiBusy() || (ownEmpty() && !versions().length)}
                value=""
                onChange={(e) => {
                  const lang = e.currentTarget.value;
                  e.currentTarget.value = "";
                  if (lang) void askAi({ label: `In ${lang}`, request: `Translate it into ${lang}. Keep the meaning, the tone and the names.` });
                }}
              >
                <option value="">Translate…</option>
                <For each={LANGUAGES}>{(l) => <option value={l}>{l}</option>}</For>
              </select>
            </label>
          </div>
        </section>
        <Show when={newMail() ? found() : null}>
          {(f) => {
            const people = (field: "to" | "cc") => (
              <For each={f()[field]}>
                {(r, k) => (
                  <div class="ai-found" classList={{ missing: !r.address || r.stranger }}>
                    <Show
                      when={!r.stranger}
                      fallback={<span>Not offered: {r.address} is not in your contacts or your words. Type it in yourself if it's right.</span>}
                    >
                      <Show when={r.address} fallback={<span>No one called “{r.asked}” in your contacts</span>}>
                        <span class="who">
                          <strong>{r.name || r.address}</strong>
                          <Show when={r.name}>
                            <span class="addr">{r.address}</span>
                          </Show>
                          <Show when={r.others.length}>
                            <span class="others">
                              also{" "}
                              <For each={r.others}>
                                {(o) => (
                                  <button type="button" class="link" onClick={() => pickPerson(field, k(), o)}>
                                    {o.name || o.email}
                                  </button>
                                )}
                              </For>
                            </span>
                          </Show>
                        </span>
                        <Show when={!added(r)} fallback={<span class="hint">Added</span>}>
                          <button type="button" class="ai-side-button small" onClick={() => addPerson(field, r)}>
                            {field === "to" ? "Add to To" : "Add to Cc"}
                          </button>
                        </Show>
                      </Show>
                    </Show>
                  </div>
                )}
              </For>
            );
            return (
              <section>
                <h3>People it found</h3>
                {people("to")}
                {people("cc")}
                <span class="hint">Only people in your contacts, and only when you add them.</span>
              </section>
            );
          }}
        </Show>
      </div>
      <footer>
        <Show when={hasStyle()}>
          <label class="ai-style-pick">
            <input type="checkbox" checked={inStyle()} onChange={(e) => setInStyle(e.currentTarget.checked)} />
            In your style
          </label>
        </Show>
        <span>
          {props.init.inReplyTo ? "Reads this conversation and your draft." : "Reads what you write here."}
          {newMail() ? " Names are matched in your contacts on this computer." : ""} Nothing here can send the mail.
        </span>
      </footer>
    </aside>
  );

  const form = (
    <form
      ref={formEl}
      class="compose"
      classList={{ inline: props.init.inline, focus: focusMode(), "with-ai": aiOpen() && !props.init.inline, long: long(), typing: typing() }}
      onKeyDown={onKeyDown}
      onMouseMove={() => typing() && setTyping(false)}
      // Only Send (the button, Ctrl+Enter) sends: a form submitted any other way does nothing.
      onSubmit={(e) => e.preventDefault()}
    >
      <Show when={long()}>{outline()}</Show>
      <div class="compose-main">
      <div class="compose-head">
        <Show when={focusMode()}>
          <span class="summary">{[to().length ? `To ${to().join(", ")}` : "", subject()].filter(Boolean).join(" · ")}</span>
        </Show>
        <span class="spacer" />
        <Show when={focusMode()}>
          <span class="saved">{words()} words</span>
        </Show>
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
        <Show when={props.accounts.length > 1 || props.accounts.some((a) => a.aliases?.length)}>
          <div class="field from-row">
            <span class="label">from</span>
            <label class="from-pick" title="Send from">
            <span class="dot" style={{ background: from() != null ? colourOf(props.accounts, from()!) : undefined }} />
            <select
              aria-label="From"
              value={alias() ? `${from()} ${alias()}` : String(from())}
              onChange={(e) => changeFrom(e.currentTarget.value)}
            >
              <For each={props.accounts}>
                {(a) => (
                  <>
                    <option value={String(a.id)}>{fromLabel(a.displayName, a.email)}</option>
                    <For each={a.aliases ?? []}>
                      {(x) => <option value={`${a.id} ${x.email}`}>{fromLabel(x.name || a.displayName, x.email)}</option>}
                    </For>
                  </>
                )}
              </For>
            </select>
            <Icon name="chevron-down" size={12} />
          </label>
          </div>
        </Show>
        <Show when={!props.init.inline || !props.init.inReplyTo}>
          <div class="field subject">
            <span class="label">about</span>
            <input
              aria-label="Subject"
              placeholder="Subject"
              value={subject()}
              onInput={(e) => (setSubject(e.currentTarget.value), changed())}
            />
          </div>
        </Show>
      </div>
      {/* A try from the AI shows in the text's place; the editor stays as it was underneath until it is kept. */}
      <div class="editor-wrap" classList={{ covered: !!tryShown() }}>
      <Suspense fallback={<div class="editor-body" />}>
        <Show when={opening()}>
          {(start) => (
            <Editor
              text={start().body}
              html={start().html}
              autofocus={bodyFirst ? "start" : false}
              snippets={snippets}
              quoteOpen={props.init.quoteOpen}
              foldSignature
              ref={editorReady}
              onPictures={pictures}
              pictures={shownPictures}
              onChange={(text, rich) => (setBody(text), setHtml(rich), changed(), typed(), caret())}
            />
          )}
        </Show>
      </Suspense>
      </div>
      <Show when={tryShown()} keyed>
        {(v) => (
          <div class="ai-try" aria-live="polite">
            <Show when={newMail() && v.written?.subject && !subject().trim()}>
              <div class="ai-try-subject">
                <span class="label">Subject</span>
                {v.written!.subject}
              </div>
            </Show>
            <Show
              when={v.written && v.base ? wordDiff(v.base!, v.written!.body) : null}
              fallback={<div class="ai-preview">{v.written?.body ?? bodyOf(v.streamed)}</div>}
            >
              {(pieces) => (
                <div class="ai-preview diff">
                  <For each={pieces()}>
                    {(p) => (p.kind === "same" ? p.text : p.kind === "added" ? <ins>{p.text}</ins> : <del>{p.text}</del>)}
                  </For>
                </div>
              )}
            </Show>
            <div class="ai-try-bar">
              <kbd class="ai-mark">AI</kbd>
              <span class="text">
                {v.written
                  ? `Try ${shown() + 1} of ${versions().length}. It isn't in the email until you keep it.`
                  : "Writing…"}
              </span>
              <Show when={v.written}>
                <button type="button" class="link" onClick={() => void keepAi()}>
                  <kbd>Tab</kbd> keep
                </button>
              </Show>
              <button type="button" class="link" onClick={() => (dropTries(), aiInput?.focus())}>
                <kbd>Esc</kbd> drop
              </button>
            </div>
          </div>
        )}
      </Show>
      <Show when={htmlSig()}>
        {(s) => (
          <Show
            when={htmlSigOpen()}
            fallback={
              <button type="button" class="sig-fold" title="Show the signature" onClick={() => setHtmlSigOpen(true)}>
                — {s().name ? `“${s().name}” signature` : "Your signature"} · show
              </button>
            }
          >
            <div class="html-signature" title="Your signature, as it goes out. Change it in Settings → Signatures.">
              <HtmlFrame html={s().html!} title="Signature" />
            </div>
          </Show>
        )}
      </Show>
      <Show when={cards().length || forwardOf()}>
        <section class="outgoing-files" aria-label="Attachments">
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
          <For each={cards()}>
            {(f) => (
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
                  onClick={() => (setFiles(files().filter((x) => x !== f)), changed())}
                >
                  ×
                </button>
              </span>
            )}
          </For>
        </section>
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
          <span>Pictures dropped on the text go in it</span>
        </div>
      </Show>
      <Show when={problem()}>
        <p class="error">{problem()}</p>
      </Show>
      <Show when={!aiOpen() && aiAllowed() && ownEmpty()}>
        <button type="button" class="ai-invite" onClick={openAi}>
          <kbd class="ai-mark">AI</kbd>
          <span>
            Write, or press <kbd>Space</kbd> for help {newMail() ? "with what to write and to whom" : "with the answer"}
          </span>
        </button>
      </Show>
      <Show when={aiHold()}>
        <p class="ai-hold">Keep the try (Tab) or drop it (Esc) before you send.</p>
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
        <span class="saved" aria-live="polite">
          <Show when={saveState() === "saved"}>Saved</Show>
          <Show when={saveState() === "saving"}>Saving…</Show>
          <Show when={words()}>
            {(n) => (
              <span>
                {saveState() ? " · " : ""}
                {n()} {n() === 1 ? "word" : "words"}
              </span>
            )}
          </Show>
        </span>
        <div class="send-split" onFocusOut={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && setSendMenu(false)}>
          <button type="button" class="primary" onClick={() => send(false)}>
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
            >
              <Icon name="clock" size={12} />
              <span class="visually-hidden">Remind me if no reply by </span>
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
          <Show when={aiAllowed()}>
            <button
              type="button"
              class="icon-button ai-button"
              classList={{ on: aiOpen() }}
              title="Writing help (Ctrl+J)"
              aria-label="Writing help"
              aria-pressed={aiOpen()}
              onClick={() => (aiOpen() ? closeAi() : openAi())}
            >
              <kbd class="ai-mark">AI</kbd>
            </button>
          </Show>
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
      </div>
      <Show when={aiOpen() && !props.init.inline}>{side()}</Show>
      <Show when={aiOpen() && props.init.inline ? aiSlot() : null} keyed>
        {(slot) => <Portal mount={slot}>{side()}</Portal>}
      </Show>
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
        {/* biome-ignore lint/a11y/noStaticElementInteractions: a click beside compose closes it (the draft is kept), as Esc does */}
        <div
          class="overlay compose-overlay"
          classList={{ minimized: props.minimized, focused: focusMode(), long: long() }}
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
