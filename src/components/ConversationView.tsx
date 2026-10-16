import { createEffect, createMemo, createResource, createSignal, For, type JSX, on, onCleanup, onMount, Show } from "solid-js";
import { api, type Mailto, type ThreadMessage } from "../api";
import { foldAt, HTML_FOLD_SELECTOR } from "../fold";
import {
  darken,
  designedFrame,
  fitFrame,
  frameTheme,
  isDesigned,
  readingFrame,
  readingMinutes,
  readingView,
  textFrame,
  withoutTrackers,
} from "../mailview";
import { isDark, setSetting, settings } from "../settings";
import { when } from "./ConversationRow";
import { ActionMenu, type MenuItem } from "./ActionMenu";
import { Icon } from "./Icon";
import { PersonCard, type PersonActions } from "./PersonCard";
import { logoFor } from "../logos";

/** Images the HTML shows from the message's own parts. */
const CID = /(["'])cid:([^"']+)\1/gi;

// Mail is untrusted: it renders in a frame with no scripts, and no remote content (tracking pixels) until asked for.
function HtmlBody(props: { html: string; sender: string; messageId: number; extra?: JSX.Element }) {
  const trusted = () => settings.loadImages === "always" || settings.imagesFrom.includes(props.sender.toLowerCase());
  const [asked, setAsked] = createSignal(false);
  const remote = () => trusted() || asked();
  // Pictures pasted into the mail come with it as parts; fetched (once, then cached) and drawn in place.
  const [inline, setInline] = createSignal<Record<string, string>>({});
  if (/["']cid:/i.test(props.html)) {
    void api.inlineImages(props.messageId).then(setInline, () => {});
  }
  // Tracking pixels are taken out first: they never load, not even when images do.
  const web = createMemo(() => withoutTrackers(props.html));
  const minutes = createMemo(() => readingMinutes(props.html));
  const html = () => {
    const found = inline();
    return web().html.replace(CID, (whole, quote: string, cid: string) =>
      found[cid] ? `${quote}${found[cid]}${quote}` : whole,
    );
  };
  const blocked = () => web().images > 0 && !remote();
  const privacy = () => {
    const { trackers, images } = web();
    const t = `${trackers} tracker${trackers === 1 ? "" : "s"}`;
    const i = `${images} image${images === 1 ? "" : "s"}`;
    if (blocked()) return trackers ? `Blocked ${t} and ${i}` : `Blocked ${i}`;
    return images ? `Images shown · ${t} still blocked` : `Blocked ${t}`;
  };
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
    const fit = () => fitFrame(frame!, doc);
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
      classList={{ waiting: darkened() && !ready(), own: !designed() || reading() }}
      sandbox="allow-same-origin"
      srcdoc={srcdoc()}
      onLoad={onLoad}
      title="Message"
    />
  );
  return (
    <>
      <Show when={blocked() || web().trackers || minutes() >= 2 || designed() || props.extra}>
        <div class="body-tools">
          <Show when={blocked() || web().trackers}>
            <span class="fact safe">
              <Icon name="shield-check" size={13} />
              {privacy()}
              <Show when={blocked()}>
                <button onClick={() => setAsked(true)}>Load images</button>
                <button onClick={() => setSetting("imagesFrom", [...settings.imagesFrom, props.sender.toLowerCase()])}>
                  Always for this sender
                </button>
              </Show>
            </span>
          </Show>
          <Show when={minutes() >= 2}>
            <span class="fact">
              <Icon name="clock" size={13} />
              {minutes()} min read
            </span>
          </Show>
          {props.extra}
          <Show when={designed()}>
            <button class="reading" aria-pressed={reading()} onClick={() => setReading(!reading())}>
              {reading() ? "Show original" : "Reading view"}
            </button>
          </Show>
        </div>
      </Show>
      {/* One wrapper whose framing toggles: moving the frame between two branches let the old branch's cleanup
          remove it, and "Show original" came back empty. */}
      <div class="html-stage" classList={{ framed: designed() && !reading() }}>
        {body}
      </div>
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

/** A sender's initials on their colour, or their company's logo when logos are on and one was found. */
function Avatar(props: { m: ThreadMessage }) {
  const logo = () => logoFor(props.m.fromAddr);
  return (
    <span class="avatar" classList={{ logo: !!logo() }} style={{ background: logo() ? undefined : colour(props.m.fromAddr) }}>
      <Show when={logo()} fallback={initials(props.m)}>
        {(src) => <img src={src()} alt="" />}
      </Show>
    </span>
  );
}

/** Where List-Unsubscribe points: a web page opens in the browser, an address gets a mail to send. */
function unsubscribeTarget(header: string | null): { web: string } | { mail: Mailto } | null {
  const links = [...(header ?? "").matchAll(/<([^>]+)>/g)].map((x) => x[1].trim());
  const web = links.find((l) => /^https?:\/\//i.test(l));
  if (web) return { web };
  const mail = links.find((l) => /^mailto:/i.test(l));
  if (!mail) return null;
  const [addr, query = ""] = mail.slice("mailto:".length).split("?");
  const q = new URLSearchParams(query);
  return { mail: { to: [decodeURIComponent(addr)], cc: [], bcc: [], subject: q.get("subject") ?? "Unsubscribe", body: q.get("body") ?? "" } };
}

/** "Mailing list · Unsubscribe" for mail that says how to leave its list. */
function ListFact(props: { header: string | null; onMailto: (m: Mailto) => void }) {
  const target = createMemo(() => unsubscribeTarget(props.header));
  const [done, setDone] = createSignal("");
  const go = () => {
    const t = target()!;
    if ("web" in t) {
      api.openUrl(t.web);
      setDone("Unsubscribe page opened");
    } else {
      props.onMailto(t.mail);
      setDone("Unsubscribe mail started");
    }
  };
  return (
    <Show when={target()}>
      <span class="fact">
        <Icon name="list" size={13} />
        <Show
          when={done()}
          fallback={
            <>
              Mailing list <button onClick={go}>Unsubscribe</button>
            </>
          }
        >
          {done()}
        </Show>
      </span>
    </Show>
  );
}

const DAY = 86_400_000;
const startOfDay = (seconds: number) => new Date(seconds * 1000).setHours(0, 0, 0, 0);

/** "3 days later" between messages far apart; nothing for ones a day or less apart. */
function later(from: number, to: number): string | null {
  const days = Math.round((startOfDay(to) - startOfDay(from)) / DAY);
  if (days < 2) return null;
  if (days < 14) return `${days} days later`;
  if (days < 60) return `${Math.round(days / 7)} weeks later`;
  if (days < 365) return `${Math.round(days / 30)} months later`;
  const years = Math.round(days / 365);
  return years === 1 ? "A year later" : `${years} years later`;
}

const fullDate = new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
const fullDateYear = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" });
const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

function full(seconds: number): string {
  const d = new Date(seconds * 1000);
  return (d.getFullYear() === new Date().getFullYear() ? fullDate : fullDateYear).format(d);
}

/** How long ago, within the last month; older mail shows its date. */
function ago(seconds: number): string {
  const minutes = Math.round((Date.now() / 1000 - seconds) / 60);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return relative.format(-minutes, "minute");
  const days = Math.round((startOfDay(Date.now() / 1000) - startOfDay(seconds)) / DAY);
  if (days === 0) return relative.format(-Math.round(minutes / 60), "hour");
  if (days < 30) return relative.format(-days, "day");
  return when(seconds);
}

/** "to you, Tom Berg": the names of people who wrote in the conversation, "you" for this person's addresses. */
function recipients(to: string, mine: (addr: string) => boolean, names: Map<string, string>): string {
  const addrs = to.split(",").map((a) => a.trim()).filter(Boolean);
  const others = addrs.filter((a) => !mine(a)).map((a) => names.get(a.toLowerCase()) || a);
  const people = [...(addrs.some(mine) ? ["you"] : []), ...others];
  return people.length ? `to ${people.join(", ")}` : "";
}

/** The open conversation: messages oldest first, collapsed to a line unless expanded. Open messages are raised
 * cards; a long conversation folds its closed middle into one line (docs/design/ui.md §4.2). */
export function ConversationView(props: {
  messages: ThreadMessage[];
  focused: number;
  expanded: (id: number) => boolean;
  /** Whether an address is one of this person's accounts. */
  mine: (addr: string) => boolean;
  /** An inline reply is open below the messages, so the reply bar steps aside. */
  replying: boolean;
  onToggle: (index: number) => void;
  onReply: (m: ThreadMessage, kind: "reply" | "replyAll" | "forward") => void;
  onView: (m: ThreadMessage, index: number) => void;
  onMailto: (m: Mailto) => void;
  onDone: () => void;
  onClose: () => void;
  menu: () => MenuItem[];
  person: PersonActions;
}) {
  const last = () => props.messages[props.messages.length - 1];
  const names = createMemo(() => new Map(props.messages.map((m) => [m.fromAddr.toLowerCase(), m.fromName] as const)));
  const people = createMemo(() => {
    const out: string[] = [];
    for (const m of props.messages) {
      const name = props.mine(m.fromAddr) ? "you" : m.fromName || m.fromAddr;
      if (!out.includes(name)) out.push(name);
    }
    // "Ana Rossi, Tom Berg, you": you read best last.
    out.sort((a, b) => Number(a === "you") - Number(b === "you"));
    return out.length > 4 ? `${out.slice(0, 3).join(", ")} and ${out.length - 3} others` : out.join(", ");
  });
  const files = () => props.messages.reduce((n, m) => n + m.attachments.length, 0);

  // The middle of a long conversation (all but the first and the last two) folds into one line while all of it
  // is closed. Opening any of it, or moving into it, unfolds it for good; another conversation starts folded.
  const [unfolded, setUnfolded] = createSignal(false);
  let shown: number | undefined;
  createEffect(() => {
    const n = props.messages.length;
    const middle = n >= 5 ? props.messages.slice(1, n - 2) : [];
    const touched = middle.some((m, i) => props.expanded(m.id) || props.focused === i + 1);
    const first = props.messages[0]?.id;
    if (first !== shown) {
      shown = first;
      setUnfolded(touched);
    } else if (touched) {
      setUnfolded(true);
    }
  });
  const fold = createMemo(() => {
    const n = props.messages.length;
    return n >= 5 && !unfolded() ? { from: 1, to: n - 3 } : null;
  });

  // The full header scrolls away with the messages; once the subject is out of view a compact bar fades in over
  // the pane. The bar takes no space, so nothing moves as it comes and goes, and nothing can flicker.
  let title!: HTMLHeadingElement;
  const [compact, setCompact] = createSignal(false);
  onMount(() => {
    const watch = new IntersectionObserver(([e]) => setCompact(!e.isIntersecting), { root: title.closest(".conversation-pane") });
    watch.observe(title);
    onCleanup(() => watch.disconnect());
  });

  return (
    <div class="conversation" classList={{ replying: props.replying }}>
      <div class="compact" classList={{ shown: compact() }} aria-hidden={!compact()}>
        <div class="bar">
          <span class="subject">{props.messages[0]?.subject || "(no subject)"}</span>
          <button class="primary" tabIndex={compact() ? 0 : -1} onClick={props.onDone}>
            Done <kbd>E</kbd>
          </button>
        </div>
      </div>
      <header class="conversation-head">
        <div class="title">
          <h1 ref={title}>{props.messages[0]?.subject || "(no subject)"}</h1>
          <div class="meta">
            <span>{people()}</span>
            <Show when={props.messages.length > 1}>
              <span class="sep">·</span>
              <span>{props.messages.length} messages</span>
            </Show>
            <Show when={files()}>
              <span class="sep">·</span>
              <span>{files() === 1 ? "1 file" : `${files()} files`}</span>
            </Show>
          </div>
        </div>
        <div class="acts">
          <button class="primary" onClick={props.onDone}>
            Done <kbd>E</kbd>
          </button>
          <ActionMenu items={props.menu} />
          <button class="link" onClick={props.onClose} aria-label="Close">
            <kbd>Esc</kbd>
          </button>
        </div>
      </header>
      <div class="messages">
        <For each={props.messages}>
          {(m, i) => {
            const open = () => props.expanded(m.id);
            const mine = () => props.mine(m.fromAddr);
            const folded = () => {
              const f = fold();
              return !!f && i() >= f.from && i() <= f.to;
            };
            const gap = () => (i() > 0 ? later(props.messages[i() - 1].date, m.date) : null);
            return (
              <>
                <Show when={fold()?.from === i() && fold()}>
                  {(f) => (
                    <button class="folded" onClick={() => setUnfolded(true)}>
                      <span class="stack">
                        <For each={props.messages.slice(f().from, f().to + 1).slice(0, 4)}>
                          {(h) => (
                            <Avatar m={h} />
                          )}
                        </For>
                      </span>
                      <span>{f().to - f().from + 1} earlier messages</span>
                      <span class="rule" />
                    </button>
                  )}
                </Show>
                <Show when={!folded()}>
                  <Show when={gap()}>{(g) => <div class="gap">{g()}</div>}</Show>
                  <article
                    class="card"
                    data-message={m.id}
                    classList={{ focused: i() === props.focused, open: open(), unread: !m.seen, mine: mine() }}
                  >
                    <header onClick={() => props.onToggle(i())}>
                      <Avatar m={m} />
                      <span class="who">
                        <span class="line">
                          <PersonCard name={m.fromName} email={m.fromAddr} colour={colour(m.fromAddr)} initials={initials(m)} actions={props.person}>
                            <strong title={m.fromAddr}>{mine() ? "You" : m.fromName || m.fromAddr}</strong>
                          </PersonCard>
                          <Show when={m.draftId != null}>
                            <span class="draft-label">Draft · R to continue</span>
                          </Show>
                          <Show when={!open()}>
                            <span class="snippet">{m.snippet}</span>
                          </Show>
                        </span>
                        <Show when={open()}>
                          <span class="detail">
                            {[recipients(m.toAddrs, props.mine, names()), full(m.date)].filter(Boolean).join(" · ")}
                          </span>
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
                      <time title={full(m.date)}>{open() ? ago(m.date) : when(m.date)}</time>
                    </header>
                    <Show when={open()}>
                      <div class="body">
                        <Show when={m.bodyLoaded} fallback={<p class="loading">Loading message…</p>}>
                          <Show
                            when={m.bodyHtml}
                            fallback={
                              <>
                                <Show when={m.listUnsubscribe}>
                                  <div class="body-tools">
                                    <ListFact header={m.listUnsubscribe} onMailto={props.onMailto} />
                                  </div>
                                </Show>
                                <PlainBody text={m.bodyText ?? ""} />
                              </>
                            }
                          >
                            <HtmlBody
                              html={m.bodyHtml!}
                              sender={m.fromAddr}
                              messageId={m.id}
                              extra={m.listUnsubscribe ? <ListFact header={m.listUnsubscribe} onMailto={props.onMailto} /> : undefined}
                            />
                          </Show>
                        </Show>
                        <Show when={m.attachments.length}>
                          <Attachments message={m} onView={(index) => props.onView(m, index)} />
                        </Show>
                      </div>
                    </Show>
                  </article>
                </Show>
              </>
            );
          }}
        </For>
      </div>
      <Show when={!props.replying && last()}>
        {(m) => (
          <div class="reply-bar">
            <div class="box">
              <button class="start" title="Reply (R)" onClick={() => props.onReply(m(), "reply")}>
                <span>{props.mine(m().fromAddr) ? "Reply…" : `Reply to ${m().fromName || m().fromAddr}…`}</span>
                <kbd>R</kbd>
              </button>
              <button class="link" title="Reply all (Enter)" onClick={() => props.onReply(m(), "replyAll")}>
                Reply all <kbd>↵</kbd>
              </button>
              <button class="link" title="Forward (F)" onClick={() => props.onReply(m(), "forward")}>
                Forward <kbd>F</kbd>
              </button>
            </div>
          </div>
        )}
      </Show>
    </div>
  );
}
