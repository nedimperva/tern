import { createEffect, createMemo, createResource, createSignal, For, on, Show } from "solid-js";
import { api, type ThreadMessage } from "../api";
import { foldAt, HTML_FOLD_SELECTOR } from "../fold";
import { darken, designedFrame, frameTheme, isDesigned, readingFrame, readingView, textFrame } from "../mailview";
import { isDark, setSetting, settings } from "../settings";
import { when } from "./ConversationRow";
import { ActionMenu, type MenuItem } from "./ActionMenu";
import { Icon } from "./Icon";
import { PersonCard, type PersonActions } from "./PersonCard";

/** Images the HTML shows from the message's own parts. */
const CID = /(["'])cid:([^"']+)\1/gi;

// Mail is untrusted: it renders in a frame with no scripts, and no remote content (tracking pixels) until asked for.
function HtmlBody(props: { html: string; sender: string; messageId: number }) {
  const trusted = () => settings.loadImages === "always" || settings.imagesFrom.includes(props.sender.toLowerCase());
  const [asked, setAsked] = createSignal(false);
  const remote = () => trusted() || asked();
  // Pictures pasted into the mail come with it as parts; fetched (once, then cached) and drawn in place.
  const [inline, setInline] = createSignal<Record<string, string>>({});
  if (/["']cid:/i.test(props.html)) {
    void api.inlineImages(props.messageId).then(setInline, () => {});
  }
  const html = () => {
    const found = inline();
    return props.html.replace(CID, (whole, quote: string, cid: string) =>
      found[cid] ? `${quote}${found[cid]}${quote}` : whole,
    );
  };
  const hasRemote = /<img[^>]+src=["']?https?:/i.test(props.html) || /url\(["']?https?:/i.test(props.html);
  // Text mail takes Tern's look; mail its sender designed keeps its own, framed (see mailview.ts).
  const designed = createMemo(() => isDesigned(props.html));
  const [reading, setReading] = createSignal(false);
  // The frame's colours come from the theme's tokens, read again once the theme has changed.
  const [theme, setTheme] = createSignal(frameTheme(isDark()));
  createEffect(on(isDark, (dark) => setTheme(frameTheme(dark)), { defer: true }));
  const darkened = () => designed() && !reading() && isDark() && settings.darkMail === "darken";
  const srcdoc = () =>
    reading()
      ? readingFrame(readingView(html()), remote(), theme())
      : designed()
        ? designedFrame(html(), remote()) + (darkened() ? "<!-- dark -->" : "")
        : textFrame(html(), remote(), theme());
  // Darkened mail stays hidden until it is dark, so it never flashes white.
  const [ready, setReady] = createSignal(false);
  createEffect(on(srcdoc, () => setReady(false)));
  // Quoted replies and signatures start folded; the pill below the frame opens them.
  const [foldable, setFoldable] = createSignal(false);
  const [unfolded, setUnfolded] = createSignal(false);
  let frame: HTMLIFrameElement | undefined;

  // Same-origin without scripts: the frame cannot run anything, but we can measure it and catch link clicks.
  const onLoad = (e: Event) => {
    frame = e.currentTarget as HTMLIFrameElement;
    const doc = frame.contentDocument;
    if (!doc) return;
    if (darkened()) darken(doc);
    setReady(true);
    setFoldable(!reading() && doc.querySelector(HTML_FOLD_SELECTOR) !== null);
    doc.documentElement.classList.toggle("tern-fold", !unfolded());
    const fit = () => (frame!.style.height = `${doc.documentElement.scrollHeight}px`);
    fit();
    new ResizeObserver(fit).observe(doc.body);
    // Keys typed while the message has focus (after selecting text in it) still reach Tern's shortcuts.
    doc.addEventListener("keydown", (ev) => {
      // A form field in the mail keeps its typing.
      const t = ev.target as HTMLElement;
      if (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
      const copy = new KeyboardEvent("keydown", {
        key: ev.key,
        code: ev.code,
        ctrlKey: ev.ctrlKey,
        shiftKey: ev.shiftKey,
        altKey: ev.altKey,
        metaKey: ev.metaKey,
        cancelable: true,
      });
      window.dispatchEvent(copy);
      if (copy.defaultPrevented) ev.preventDefault();
    });
    doc.addEventListener("click", (ev) => {
      const a = (ev.target as Element).closest("a");
      if (!a?.href) return;
      ev.preventDefault();
      if (/^(https?|mailto):/i.test(a.href)) api.openUrl(a.href);
    });
  };

  const body = (
    <iframe
      class="html-body"
      classList={{ waiting: darkened() && !ready() }}
      sandbox="allow-same-origin"
      srcdoc={srcdoc()}
      onLoad={onLoad}
      title="Message"
    />
  );
  return (
    <>
      <Show when={(hasRemote && !remote()) || designed()}>
        <div class="body-tools">
          <Show when={hasRemote && !remote()}>
            <span>Remote images are blocked.</span>
            <button onClick={() => setAsked(true)}>Load images</button>
            <button onClick={() => setSetting("imagesFrom", [...settings.imagesFrom, props.sender.toLowerCase()])}>
              Always for this sender
            </button>
          </Show>
          <Show when={designed()}>
            <button class="reading" aria-pressed={reading()} onClick={() => setReading(!reading())}>
              {reading() ? "Show original" : "Reading view"}
            </button>
          </Show>
        </div>
      </Show>
      <Show when={designed() && !reading()} fallback={body}>
        <div class="html-stage">{body}</div>
      </Show>
      <Show when={foldable()}>
        <button
          class="fold"
          title={unfolded() ? "Hide quoted text" : "Show quoted text"}
          aria-expanded={unfolded()}
          onClick={() => {
            setUnfolded(!unfolded());
            frame?.contentDocument?.documentElement.classList.toggle("tern-fold", !unfolded());
          }}
        >
          ···
        </button>
      </Show>
    </>
  );
}

/** A plain-text body in Tern's type, with its quoted reply or signature folded behind "···"; unfolded, the quote
 * sits behind a bar so it reads apart from the new text. */
function PlainBody(props: { text: string }) {
  const [unfolded, setUnfolded] = createSignal(false);
  const at = () => foldAt(props.text);
  return (
    <>
      <pre class="plain">{at() < 0 ? props.text : props.text.slice(0, at())}</pre>
      <Show when={at() >= 0 && unfolded()}>
        <pre class="plain quoted" classList={{ signature: /^\s*-- ?\n/.test(props.text.slice(at())) }}>
          {props.text.slice(at()).replace(/^\s*\n/, "")}
        </pre>
      </Show>
      <Show when={at() >= 0}>
        <button
          class="fold"
          title={unfolded() ? "Hide quoted text" : "Show quoted text"}
          aria-expanded={unfolded()}
          onClick={() => setUnfolded(!unfolded())}
        >
          ···
        </button>
      </Show>
    </>
  );
}

function size(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${Math.round(bytes / 1000)} KB`;
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

/** What kind of file a name is, for its badge's label and colour. */
function kind(name: string, mime: string): { label: string; tone: string } {
  const ext = /\.([a-z0-9]{1,5})$/i.exec(name)?.[1]?.toLowerCase() ?? "";
  const tone =
    ext === "pdf" ? "pdf"
    : /^(docx?|odt|rtf|pages)$/.test(ext) ? "doc"
    : /^(xlsx?|ods|csv|numbers)$/.test(ext) ? "sheet"
    : /^(pptx?|odp|key)$/.test(ext) ? "slides"
    : /^(zip|rar|7z|gz|tar)$/.test(ext) ? "archive"
    : mime.startsWith("image/") ? "image"
    : "other";
  return { label: (ext || "file").slice(0, 4).toUpperCase(), tone };
}

/** One file as a card: a picture of it when it is an image already on this computer, else a badge of its type.
 * Opening it downloads it the first time; a preview never does. */
function FileCard(props: { message: ThreadMessage; index: number; busy: boolean; onOpen: () => void; onSave: () => void }) {
  const file = () => props.message.attachments[props.index];
  const [preview] = createResource(
    () => (file().mime.startsWith("image/") ? [props.message.id, props.index] as const : null),
    ([id, index]) => api.attachmentPreview(id, index).catch(() => null),
  );
  const type = () => kind(file().name, file().mime);
  return (
    <span class="file-card" classList={{ busy: props.busy }} title={file().mime}>
      <button type="button" class="open" onClick={props.onOpen} title={`View ${file().name} (V)`}>
        <Show when={preview()} fallback={<span class={`badge ${type().tone}`}>{type().label}</span>}>
          {(src) => <img class="thumb" src={src()} alt="" />}
        </Show>
        <span class="meta">
          <span class="name">{file().name}</span>
          <span class="size">{props.busy ? "Getting it…" : size(file().size)}</span>
        </span>
      </button>
      <button type="button" class="save" onClick={props.onSave} aria-label={`Save ${file().name}`} title="Save">
        <Icon name="download" size={14} />
      </button>
    </span>
  );
}

/** The files of a received message: a card opens one in the viewer, the arrow beside it saves it. */
function Attachments(props: { message: ThreadMessage; onView: (index: number) => void }) {
  const [busy, setBusy] = createSignal<number | null>(null);
  const [problem, setProblem] = createSignal("");
  const run = async (index: number, work: () => Promise<unknown>) => {
    if (busy() !== null) return;
    setBusy(index);
    setProblem("");
    try {
      await work();
    } catch (e) {
      setProblem(String(e));
    } finally {
      setBusy(null);
    }
  };
  return (
    <>
      <div class="attachments" aria-label="Attachments">
        <For each={props.message.attachments}>
          {(a, i) => (
            <FileCard
              message={props.message}
              index={i()}
              busy={busy() === i()}
              onOpen={() => props.onView(i())}
              onSave={() => void run(i(), () => api.saveAttachment(props.message.id, i(), a.name))}
            />
          )}
        </For>
      </div>
      <Show when={problem()}>
        <p class="attachment-problem">{problem()}</p>
      </Show>
    </>
  );
}

/** Text selected in one of the open messages, for a reply that quotes only that (`r`). The selection is cleared,
 * so a later reply is a whole one again. */
export function takeQuote(): { id: number; text: string } | null {
  const card = (node: Node | null | undefined) =>
    (node instanceof Element ? node : node?.parentElement)?.closest<HTMLElement>(".card[data-message]");
  const sel = document.getSelection();
  const here = sel && !sel.isCollapsed ? card(sel.anchorNode) : null;
  if (here && sel!.toString().trim()) {
    const text = sel!.toString().trim();
    sel!.removeAllRanges();
    return { id: Number(here.dataset.message), text };
  }
  // In mail HTML the selection lives in the message's frame.
  for (const frame of document.querySelectorAll<HTMLIFrameElement>(".card[data-message] iframe")) {
    const inner = frame.contentWindow?.getSelection();
    const text = inner && !inner.isCollapsed ? inner.toString().trim() : "";
    if (text) {
      inner!.removeAllRanges();
      return { id: Number(card(frame)!.dataset.message), text };
    }
  }
  return null;
}

const PALETTE = ["#5b5bd6", "#2f9e6e", "#d0453f", "#c98a1b", "#0e9bb5", "#b24fb0", "#7a7f8a", "#e07a30"];

/** A colour per sender, the same every time (docs/design/ui.md §4.2). */
function colour(addr: string): string {
  let h = 0;
  for (const ch of addr.toLowerCase()) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

function initials(m: ThreadMessage): string {
  const name = m.fromName || m.fromAddr;
  const words = name.split(/[\s@.]+/).filter(Boolean);
  return ((words[0]?.[0] ?? "") + (words.length > 1 ? words[1][0] : "")).toUpperCase();
}

/** The open conversation: messages as cards, oldest first, collapsed to a line unless expanded. */
export function ConversationView(props: {
  messages: ThreadMessage[];
  focused: number;
  expanded: (id: number) => boolean;
  onToggle: (index: number) => void;
  onReply: (m: ThreadMessage) => void;
  onView: (m: ThreadMessage, index: number) => void;
  onDone: () => void;
  onClose: () => void;
  menu: () => MenuItem[];
  person: PersonActions;
}) {
  const last = () => props.messages[props.messages.length - 1];
  return (
    <div class="conversation">
      <header class="conversation-head">
        <h1>{props.messages[0]?.subject || "(no subject)"}</h1>
        <button class="primary" onClick={props.onDone}>
          Done <kbd>E</kbd>
        </button>
        <ActionMenu items={props.menu} />
        <button class="link" onClick={props.onClose} aria-label="Close">
          <kbd>Esc</kbd>
        </button>
      </header>
      <For each={props.messages}>
        {(m, i) => (
          <article class="card" data-message={m.id} classList={{ focused: i() === props.focused, open: props.expanded(m.id), unread: !m.seen }}>
            <header onClick={() => props.onToggle(i())}>
              <span class="avatar" style={{ background: colour(m.fromAddr) }}>
                {initials(m)}
              </span>
              <span class="who">
                <PersonCard name={m.fromName} email={m.fromAddr} colour={colour(m.fromAddr)} initials={initials(m)} actions={props.person}>
                  <strong>{m.fromName || m.fromAddr}</strong>
                </PersonCard>
                <Show when={m.draftId != null}>
                  <span class="draft-label">Draft · R to continue</span>
                </Show>
                <Show when={props.expanded(m.id)} fallback={<span class="snippet">{m.snippet}</span>}>
                  <span class="addr">{m.fromAddr}</span>
                  <span class="to">to {m.toAddrs}</span>
                </Show>
              </span>
              <Show when={m.attachments.length || m.hasAttachments}>
                <span
                  class="clip"
                  title={m.attachments.length === 1 ? "1 attachment" : m.attachments.length ? `${m.attachments.length} attachments` : "Attachments"}
                >
                  <Icon name="paperclip" size={13} />
                  <Show when={m.attachments.length > 1}>{m.attachments.length}</Show>
                </span>
              </Show>
              <time>{when(m.date)}</time>
            </header>
            <Show when={props.expanded(m.id)}>
              <div class="body">
                <Show when={m.bodyLoaded} fallback={<p class="loading">Loading message…</p>}>
                  <Show when={m.bodyHtml} fallback={<PlainBody text={m.bodyText ?? ""} />}>
                    <HtmlBody html={m.bodyHtml!} sender={m.fromAddr} messageId={m.id} />
                  </Show>
                </Show>
                <Show when={m.attachments.length}>
                  <Attachments message={m} onView={(index) => props.onView(m, index)} />
                </Show>
              </div>
            </Show>
          </article>
        )}
      </For>
      <Show when={last()}>
        <button class="reply" onClick={() => props.onReply(last()!)}>
          Reply <kbd>R</kbd>
        </button>
      </Show>
    </div>
  );
}
