import { createSignal, For, Show } from "solid-js";
import { api, type ThreadMessage } from "../api";
import { foldAt, HTML_FOLD_CSS, HTML_FOLD_SELECTOR } from "../fold";
import { setSetting, settings } from "../settings";
import { when } from "./ConversationRow";
import { Icon } from "./Icon";

// Mail is untrusted: no scripts, and no remote content (tracking pixels) until asked for.
function frameHtml(html: string, remote: boolean): string {
  const img = remote ? "data: cid: https: http:" : "data: cid:";
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${img}; style-src 'unsafe-inline'; font-src data:">
<style>
  html,body{margin:0;padding:0;background:#fff;color:#111;font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;overflow:hidden}
  body{padding:4px 2px;word-wrap:break-word}
  img{max-width:100%;height:auto}
  pre{white-space:pre-wrap}
  ${HTML_FOLD_CSS}
</style></head><body>${html}</body></html>`;
}

/** Images the HTML shows from the message's own parts. */
const CID = /(["'])cid:([^"']+)\1/gi;

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
  // Quoted replies and signatures start folded; the pill below the frame opens them.
  const [foldable, setFoldable] = createSignal(false);
  const [unfolded, setUnfolded] = createSignal(false);
  let frame: HTMLIFrameElement | undefined;

  // Same-origin without scripts: the frame cannot run anything, but we can measure it and catch link clicks.
  const onLoad = (e: Event) => {
    frame = e.currentTarget as HTMLIFrameElement;
    const doc = frame.contentDocument;
    if (!doc) return;
    setFoldable(doc.querySelector(HTML_FOLD_SELECTOR) !== null);
    doc.documentElement.classList.toggle("tern-fold", !unfolded());
    const fit = () => (frame!.style.height = `${doc.documentElement.scrollHeight}px`);
    fit();
    new ResizeObserver(fit).observe(doc.body);
    doc.addEventListener("click", (ev) => {
      const a = (ev.target as Element).closest("a");
      if (!a?.href) return;
      ev.preventDefault();
      if (/^(https?|mailto):/i.test(a.href)) api.openUrl(a.href);
    });
  };

  return (
    <>
      <Show when={hasRemote && !remote()}>
        <div class="remote-bar">
          Remote images are blocked.
          <button onClick={() => setAsked(true)}>Load images</button>
          <button
            onClick={() => setSetting("imagesFrom", [...settings.imagesFrom, props.sender.toLowerCase()])}
          >
            Always for this sender
          </button>
        </div>
      </Show>
      <iframe class="html-body" sandbox="allow-same-origin" srcdoc={frameHtml(html(), remote())} onLoad={onLoad} />
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

/** A plain-text body with its quoted reply or signature folded behind "···". */
function PlainBody(props: { text: string }) {
  const [unfolded, setUnfolded] = createSignal(false);
  const at = () => foldAt(props.text);
  return (
    <>
      <pre class="plain">{at() < 0 || unfolded() ? props.text : props.text.slice(0, at())}</pre>
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

/** The files of a received message: a chip opens one with the system's program, the arrow beside it saves it. */
function Attachments(props: { message: ThreadMessage }) {
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
            <span class="file" classList={{ busy: busy() === i() }} title={a.mime}>
              <button type="button" class="open" onClick={() => void run(i(), () => api.openAttachment(props.message.id, i()))} title={`Open ${a.name}`}>
                <Icon name="paperclip" size={13} />
                <span class="name">{a.name}</span>
                <span class="size">{busy() === i() ? "Getting it…" : size(a.size)}</span>
              </button>
              <button
                type="button"
                class="save"
                onClick={() => void run(i(), () => api.saveAttachment(props.message.id, i(), a.name))}
                aria-label={`Save ${a.name}`}
                title="Save"
              >
                <Icon name="download" size={13} />
              </button>
            </span>
          )}
        </For>
      </div>
      <Show when={problem()}>
        <p class="attachment-problem">{problem()}</p>
      </Show>
    </>
  );
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
  onDone: () => void;
  onClose: () => void;
}) {
  const last = () => props.messages[props.messages.length - 1];
  return (
    <div class="conversation">
      <header class="conversation-head">
        <h1>{props.messages[0]?.subject || "(no subject)"}</h1>
        <button class="primary" onClick={props.onDone}>
          Done <kbd>E</kbd>
        </button>
        <button class="link" onClick={props.onClose} aria-label="Close">
          <kbd>Esc</kbd>
        </button>
      </header>
      <For each={props.messages}>
        {(m, i) => (
          <article class="card" classList={{ focused: i() === props.focused, open: props.expanded(m.id), unread: !m.seen }}>
            <header onClick={() => props.onToggle(i())}>
              <span class="avatar" style={{ background: colour(m.fromAddr) }}>
                {initials(m)}
              </span>
              <span class="who">
                <strong>{m.fromName || m.fromAddr}</strong>
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
                  <Attachments message={m} />
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
