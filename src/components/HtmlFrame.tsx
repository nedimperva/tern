// HTML that isn't Tern's own (a signature pasted from another mail app) in a frame of its own: no scripts run, and
// its styles stay inside. Mail is read the same way (ConversationView); this one is only as tall as what it holds.

/** White, as the people written to see it in most apps. */
const PAGE = "<!doctype html><meta charset=utf-8><style>html,body{margin:0;background:#fff;color:#222;font:14px/1.45 system-ui,sans-serif}</style>";

export function HtmlFrame(props: { html: string; title: string; class?: string }) {
  let frame!: HTMLIFrameElement;
  const fit = () => {
    const doc = frame.contentDocument;
    if (doc) frame.style.height = `${doc.documentElement.scrollHeight}px`;
  };
  return (
    <iframe
      ref={frame}
      class={`html-frame ${props.class ?? ""}`}
      sandbox="allow-same-origin"
      title={props.title}
      srcdoc={PAGE + props.html}
      onLoad={fit}
    />
  );
}
