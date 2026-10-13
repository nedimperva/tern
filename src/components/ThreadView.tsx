import { createSignal, For, Show } from "solid-js";
import { api, type ThreadMessage } from "../api";
import { when } from "./MessageRow";

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

export function ThreadView(props: { messages: ThreadMessage[]; onReply: (m: ThreadMessage) => void }) {
  const last = () => props.messages[props.messages.length - 1];
  return (
    <div class="thread">
      <h1 class="thread-subject">{props.messages[0]?.subject || "(no subject)"}</h1>
      <For each={props.messages}>
        {(m) => (
          <article class="message">
            <header>
              <div class="avatar">{(m.fromName || m.fromAddr).slice(0, 1).toUpperCase()}</div>
              <div class="who">
                <div>
                  <strong>{m.fromName || m.fromAddr}</strong> <span class="addr">&lt;{m.fromAddr}&gt;</span>
                </div>
                <div class="to">to {m.toAddrs}</div>
              </div>
              <time>{when(m.date)}</time>
            </header>
            <Show when={m.bodyLoaded} fallback={<p class="loading">Loading message…</p>}>
              <Show when={m.bodyHtml} fallback={<pre class="plain">{m.bodyText ?? ""}</pre>}>
                <HtmlBody html={m.bodyHtml!} />
              </Show>
            </Show>
          </article>
        )}
      </For>
      <Show when={last()}>
        <button class="reply" onClick={() => props.onReply(last()!)}>
          Reply <kbd>r</kbd>
        </button>
      </Show>
    </div>
  );
}
