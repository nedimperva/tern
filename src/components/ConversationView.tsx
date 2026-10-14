import { createSignal, For, Show } from "solid-js";
import { api, type ThreadMessage } from "../api";
import { when } from "./ConversationRow";

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
</style></head><body>${html}</body></html>`;
}

function HtmlBody(props: { html: string }) {
  const [remote, setRemote] = createSignal(false);
  const hasRemote = /<img[^>]+src=["']?https?:/i.test(props.html) || /url\(["']?https?:/i.test(props.html);

  // Same-origin without scripts: the frame cannot run anything, but we can measure it and catch link clicks.
  const onLoad = (e: Event) => {
    const frame = e.currentTarget as HTMLIFrameElement;
    const doc = frame.contentDocument;
    if (!doc) return;
    const fit = () => (frame.style.height = `${doc.documentElement.scrollHeight}px`);
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
          Remote images are blocked. <button onClick={() => setRemote(true)}>Load images</button>
        </div>
      </Show>
      <iframe class="html-body" sandbox="allow-same-origin" srcdoc={frameHtml(props.html, remote())} onLoad={onLoad} />
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
                <Show when={props.expanded(m.id)} fallback={<span class="snippet">{m.snippet}</span>}>
                  <span class="addr">{m.fromAddr}</span>
                  <span class="to">to {m.toAddrs}</span>
                </Show>
              </span>
              <time>{when(m.date)}</time>
            </header>
            <Show when={props.expanded(m.id)}>
              <div class="body">
                <Show when={m.bodyLoaded} fallback={<p class="loading">Loading message…</p>}>
                  <Show when={m.bodyHtml} fallback={<pre class="plain">{m.bodyText ?? ""}</pre>}>
                    <HtmlBody html={m.bodyHtml!} />
                  </Show>
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
