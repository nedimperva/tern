import { createEffect, createMemo, createResource, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import { api, type Mailto, type Mark, type ThreadMessage } from "../api";
import { quietMenu } from "../browserKeys";
import { labelColour } from "../colours";
import { foldAt, HTML_FOLD_SELECTOR } from "../fold";
import { linkify } from "../linkify";
import { drawHits } from "../hits";
import { hostOf, misleading } from "../links";
import {
  darken,
  designedFrame,
  fitFrame,
  frameTheme,
  isDesigned,
  readingFrame,
  readingMinutes,
  readingView,
  type Remote,
  textFrame,
  withoutTrackers,
} from "../mailview";
import { anyFact, factsOf } from "../facts";
import { drawMarks, FRAME_MARK_STYLE, setJumper, showRange } from "../marks";
import { aiOn, isDark, setSetting, settings } from "../settings";
import { when } from "./ConversationRow";
import { ActionMenu, type MenuItem } from "./ActionMenu";
import { AiReplies } from "./AiReplies";
import { AiSummary } from "./AiSummary";
import { Icon } from "./Icon";
import { Original } from "./Original";
import { PersonCard, type PersonActions } from "./PersonCard";
import { ReadingMargin } from "./ReadingMargin";
import { logoFor } from "../logos";

/** Images the HTML shows from the message's own parts. */
const CID = /(["'])cid:([^"']+)\1/gi;

/** Text selected in a message, where the bar for it goes (window coordinates of the selection's top middle). */
type Picked = { messageId: number; text: string; x: number; y: number };

/** The selection in `doc` when it lies in one message's words; `offset` places a frame's coordinates in the window. */
function picked(doc: Document, messageId: number | null, offset: { left: number; top: number }): Picked | null {
  const sel = doc.getSelection();
  const text = sel && !sel.isCollapsed ? sel.toString().trim() : "";
  if (!text || text.length > 2000) return null;
  const range = sel!.getRangeAt(0);
  const node = range.commonAncestorContainer;
  const id = messageId ?? Number((node instanceof Element ? node : node.parentElement)?.closest<HTMLElement>(".card[data-message] .body")?.closest<HTMLElement>(".card")?.dataset.message);
  if (!id) return null;
  const box = range.getBoundingClientRect();
  return { messageId: id, text, x: offset.left + box.left + box.width / 2, y: offset.top + box.top };
}

// Shift+B is the app's key (App.tsx); the open conversation switches reading view.
let readingSwitch: (() => void) | null = null;
export const switchReading = () => readingSwitch?.();

/** The link under the pointer: where it goes, and the site its text names when that is another one. Shown just
 * under the link (above it near the window's foot), since a mail's link text can say anything. */
type Hovered = { host: string; claimed: string | null; left: number; top: number; above: boolean };
const [hovered, setHovered] = createSignal<Hovered | null>(null);
const hover = (a: HTMLAnchorElement | null, frame?: HTMLIFrameElement | null) => {
  const host = a ? hostOf(a.href) : null;
  if (!a || !host) return setHovered(null);
  // A link in a mail frame is placed by the frame's coordinates; the label is drawn in the window's.
  const box = a.getBoundingClientRect();
  const at = frame?.getBoundingClientRect() ?? { left: 0, top: 0 };
  const above = at.top + box.bottom + 40 > window.innerHeight;
  setHovered({
    host,
    claimed: misleading(a.textContent ?? "", a.href),
    left: Math.max(8, Math.min(at.left + box.left, window.innerWidth - 488)),
    top: above ? at.top + box.top - 6 : at.top + box.bottom + 6,
    above,
  });
};

/** Frames tell the conversation they have (re)loaded, so marks are drawn in them again. */
const FRAME_LOADED = "tern-frame-loaded";

// Mail is untrusted: it renders in a frame with no scripts, and no remote content until asked for. What it would
// fetch (`web`, tracking pixels already taken out) is worked out by the conversation, whose header says what was
// blocked and loads images when asked.
function HtmlBody(props: {
  web: Remote;
  remote: boolean;
  designed: boolean;
  reading: boolean;
  messageId: number;
  large?: boolean;
  /** Shown above it by the reader bar: reading view leaves out the mail's own copy. */
  title?: string;
  onPick?: (p: Picked | null) => void;
}) {
  const remote = () => props.remote;
  // Pictures pasted into the mail come with it as parts; fetched (once, then cached) and drawn in place.
  const [inline, setInline] = createSignal<Record<string, string>>({});
  if (/["']cid:/i.test(props.web.html)) {
    void api.inlineImages(props.messageId).then(setInline, () => {});
  }
  const html = () => {
    const found = inline();
    return props.web.html.replace(CID, (whole, quote: string, cid: string) =>
      found[cid] ? `${quote}${found[cid]}${quote}` : whole,
    );
  };
  // Text mail takes Tern's look; mail its sender designed keeps its own, framed (see mailview.ts). Whether to show
  // a designed mail's words only (reading view) is the header's switch.
  const designed = () => props.designed;
  const reading = () => props.designed && props.reading;
  // The frame's colours come from the theme's tokens, read again once the theme has changed.
  const [theme, setTheme] = createSignal(frameTheme(isDark()));
  createEffect(on(isDark, (dark) => setTheme(frameTheme(dark)), { defer: true }));
  const darkened = () => designed() && !reading() && isDark() && settings.darkMail === "darken";
  const srcdoc = () =>
    reading()
      ? readingFrame(readingView(html(), props.title), remote(), theme())
      : designed()
        ? designedFrame(html(), remote()) + (darkened() ? "<!-- dark -->" : "")
        : textFrame(html(), remote(), theme(), props.large ? 16 : 15);
  // Darkened mail stays hidden until it is dark, so it never flashes white.
  const [ready, setReady] = createSignal(false);
  // A right-click on a link: Tern's own Open / Copy link, as the web view's menu is taken away (browserKeys.ts).
  const [linkMenu, setLinkMenu] = createSignal<{ x: number; y: number; href: string; claimed: string | null } | null>(null);
  const closeLinkMenu = () => setLinkMenu(null);
  onMount(() => {
    window.addEventListener("mousedown", closeLinkMenu);
    window.addEventListener("blur", closeLinkMenu);
    window.addEventListener("keydown", closeLinkMenu);
  });
  onCleanup(() => {
    window.removeEventListener("mousedown", closeLinkMenu);
    window.removeEventListener("blur", closeLinkMenu);
    window.removeEventListener("keydown", closeLinkMenu);
  });
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
    quietMenu(doc);
    const marks = doc.createElement("style");
    marks.textContent = FRAME_MARK_STYLE;
    doc.head?.append(marks);
    window.dispatchEvent(new Event(FRAME_LOADED));
    // A selection in the message offers Quote, Mark, Note and Copy; the frame's own coordinates are moved into the
    // window's, where the bar is drawn.
    doc.addEventListener("mouseup", () =>
      setTimeout(() => {
        const box = frame!.getBoundingClientRect();
        props.onPick?.(picked(doc, props.messageId, box));
      }),
    );
    doc.addEventListener("mousedown", () => props.onPick?.(null));
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
    const menuAt = (ev: MouseEvent, a: HTMLAnchorElement) => {
      const box = frame!.getBoundingClientRect();
      // Kept inside the window near its right and bottom edges.
      const x = Math.min(box.left + ev.clientX, window.innerWidth - 370);
      const y = Math.min(box.top + ev.clientY, window.innerHeight - 150);
      setLinkMenu({ x, y, href: a.href, claimed: misleading(a.textContent ?? "", a.href) });
    };
    doc.addEventListener("click", (ev) => {
      setLinkMenu(null);
      const a = (ev.target as Element).closest("a");
      if (!a?.href) return;
      ev.preventDefault();
      if (!/^(https?|mailto):/i.test(a.href)) return;
      // A link whose text names another site opens only from the menu, where that is said.
      if (misleading(a.textContent ?? "", a.href)) menuAt(ev, a);
      else api.openUrl(a.href);
    });
    doc.addEventListener("contextmenu", (ev) => {
      const a = (ev.target as Element).closest("a");
      if (!a?.href || !/^(https?|mailto):/i.test(a.href)) return;
      ev.preventDefault();
      menuAt(ev, a);
    });
    doc.addEventListener("mouseover", (ev) => hover((ev.target as Element).closest?.("a") ?? null, frame));
    doc.addEventListener("mouseleave", () => setHovered(null));
    doc.addEventListener("mousedown", (ev) => ev.button === 0 && setLinkMenu(null));
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
      {/* One wrapper whose framing toggles: moving the frame between two branches let the old branch's cleanup
          remove it, and "Show original" came back empty. */}
      <div class="html-stage" classList={{ framed: designed() && !reading() }}>
        {body}
      </div>
      <Show when={linkMenu()}>
        {(m) => (
          <div
            class="link-menu"
            role="menu"
            style={{ left: `${m().x}px`, top: `${m().y}px` }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <span class="link-menu-url" title={m().href}>
              {m().href.replace(/^mailto:/i, "")}
            </span>
            <Show when={m().claimed}>
              <span class="link-menu-warn" role="alert">
                The text says {m().claimed}, but the link goes to {hostOf(m().href)}.
              </span>
            </Show>
            <button role="menuitem" onClick={() => (api.openUrl(m().href), setLinkMenu(null))}>
              {/^mailto:/i.test(m().href) ? "Write to this address" : "Open link"}
            </button>
            <button
              role="menuitem"
              onClick={() => {
                void navigator.clipboard.writeText(m().href.replace(/^mailto:/i, "")).catch(() => {});
                setLinkMenu(null);
              }}
            >
              {/^mailto:/i.test(m().href) ? "Copy address" : "Copy link"}
            </button>
          </div>
        )}
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
      <pre class="plain">
        <Linked text={at() < 0 ? props.text : props.text.slice(0, at())} />
      </pre>
      <Show when={at() >= 0 && unfolded()}>
        <pre class="plain quoted" classList={{ signature: /^\s*-- ?\n/.test(props.text.slice(at())) }}>
          <Linked text={props.text.slice(at()).replace(/^\s*\n/, "")} />
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

/** Text with its web and mailto addresses as links, opened the way links in HTML mail are. */
function Linked(props: { text: string }) {
  return (
    <For each={linkify(props.text)}>
      {(p) =>
        typeof p === "string" ? (
          p
        ) : (
          <a
            href={p.href}
            title={p.href}
            onMouseEnter={(e) => hover(e.currentTarget)}
            onMouseLeave={() => setHovered(null)}
            onClick={(e) => {
              e.preventDefault();
              api.openUrl(p.href);
            }}
          >
            {p.text}
          </a>
        )
      }
    </For>
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
          {(_, i) => (
            <FileCard
              message={props.message}
              index={i()}
              busy={busy() === i()}
              onOpen={() => props.onView(i())}
              onSave={() => void run(i(), () => api.saveAttachment(props.message.id, i()))}
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

function initialsOf(name: string, addr: string): string {
  const words = (name || addr).split(/[\s@.]+/).filter(Boolean);
  return ((words[0]?.[0] ?? "") + (words.length > 1 ? words[1][0] : "")).toUpperCase();
}

/** Someone's initials on their colour, or their company's logo when logos are on and one was found. */
function Avatar(props: { addr: string; name: string }) {
  const logo = () => logoFor(props.addr);
  return (
    <span class="avatar" classList={{ logo: !!logo() }} style={{ background: logo() ? undefined : colour(props.addr) }}>
      <Show when={logo()} fallback={initialsOf(props.name, props.addr)}>
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

/** Minutes a message takes to read, from its HTML or its text; 0 until its body is here. */
function minutesOf(m: ThreadMessage): number {
  if (!m.bodyLoaded) return 0;
  if (m.bodyHtml) return readingMinutes(m.bodyHtml);
  return Math.round((m.bodyText ?? "").split(/\s+/).filter(Boolean).length / 230);
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** One message's body: its HTML in a frame, or its text, then its files. */
function MessageBody(props: {
  m: ThreadMessage;
  web?: Remote;
  remote: boolean;
  designed: boolean;
  reading: boolean;
  large?: boolean;
  onView: (index: number) => void;
  onPick: (p: Picked | null) => void;
  title?: string;
}) {
  return (
    <>
      <Show when={props.m.bodyLoaded} fallback={<p class="loading">Loading message…</p>}>
        <Show when={props.web} fallback={<PlainBody text={props.m.bodyText ?? ""} />}>
          {(web) => (
            <HtmlBody
              web={web()}
              remote={props.remote}
              designed={props.designed}
              reading={props.reading}
              messageId={props.m.id}
              large={props.large}
              title={props.title}
              onPick={props.onPick}
            />
          )}
        </Show>
      </Show>
      <Show when={props.m.attachments.length}>
        <Attachments message={props.m} onView={props.onView} />
      </Show>
    </>
  );
}

/** The open conversation (docs/design/ui.md §4.2). The newest message, or the only one, takes the stage: a byline
 * and a size up in type. Every earlier message is one line above it, all of them there, and opens in place. The
 * header says, as icons, what Tern blocked, how long the mail is and how to leave its list. */
export function ConversationView(props: {
  messages: ThreadMessage[];
  /** Gmail labels on the conversation, shown under its subject. */
  labels: string[];
  focused: number;
  expanded: (id: number) => boolean;
  /** Whether an address is one of this person's accounts. */
  mine: (addr: string) => boolean;
  /** An inline reply is open below the messages, so the reply row steps aside. */
  replying: boolean;
  onToggle: (index: number) => void;
  /** `text` starts the reply with it (a suggested reply). */
  onReply: (m: ThreadMessage, kind: "reply" | "replyAll" | "forward", text?: string) => void;
  onView: (m: ThreadMessage, index: number) => void;
  onMailto: (m: Mailto) => void;
  onDone: () => void;
  onClose: () => void;
  /** The Read later shelf: whether the conversation is on it (opened from there), and putting it on or off. */
  shelf: { on: boolean; toggle: () => void };
  /** Reply quoting the text selected in a message (the selection bar's "Quote in reply"). */
  onQuote: () => void;
  /** Snooze the conversation until then (the column's "Snooze until then"). */
  onSnoozeUntil: (due: number) => void;
  menu: () => MenuItem[];
  person: PersonActions;
  /** The words searched for, when the conversation was opened from search results: lit up in the messages. */
  hits?: string[];
}) {
  const last = () => props.messages[props.messages.length - 1];
  const stage = () => props.messages.length === 1;
  const subject = () => props.messages[0]?.subject || "(no subject)";
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
  /** The first message of each sender, for the avatars under the subject. */
  const senders = createMemo(() => {
    const seen = new Set<string>();
    return props.messages.filter((m) => !seen.has(m.fromAddr.toLowerCase()) && seen.add(m.fromAddr.toLowerCase())).slice(0, 4);
  });

  // What each message would fetch from the web, its tracking pixels already taken out. Worked out here rather than
  // in each body, so the header can say what was blocked across the conversation.
  const webs = createMemo(() => {
    const out = new Map<number, Remote>();
    for (const m of props.messages) if (m.bodyHtml) out.set(m.id, withoutTrackers(m.bodyHtml));
    return out;
  });
  /** Messages their senders designed (newsletters, receipts), which reading view can show as words only. */
  const designed = createMemo(() => new Set([...webs()].filter(([, web]) => isDesigned(web.html)).map(([id]) => id)));
  const [reading, setReading] = createSignal(false);
  const [asked, setAsked] = createSignal(false);
  const remoteFor = (m: ThreadMessage) =>
    asked() || settings.loadImages === "always" || settings.imagesFrom.includes(m.fromAddr.toLowerCase());
  const privacy = createMemo(() => {
    let trackers = 0;
    let blocked = 0;
    let shown = 0;
    let sender: string | null = null;
    for (const m of props.messages) {
      const web = webs().get(m.id);
      if (!web) continue;
      trackers += web.trackers;
      if (remoteFor(m)) shown += web.images;
      else if (web.images) (blocked += web.images), (sender = m.fromAddr);
    }
    return { trackers, blocked, shown, sender };
  });
  const shieldTip = () => {
    const { trackers, blocked, shown } = privacy();
    if (blocked) return `Blocked ${[trackers && plural(trackers, "tracker"), plural(blocked, "image")].filter(Boolean).join(" and ")}. Click to load the images.`;
    return shown ? `Images shown. ${plural(trackers, "tracker")} still blocked.` : `Blocked ${plural(trackers, "tracker")}.`;
  };
  const minutes = () => (last() ? minutesOf(last()) : 0);
  const listMail = () => [...props.messages].reverse().find((m) => unsubscribeTarget(m.listUnsubscribe));
  const [left, setLeft] = createSignal("");
  const unsubscribe = () => {
    const target = unsubscribeTarget(listMail()?.listUnsubscribe ?? null);
    if (!target) return;
    if ("web" in target) {
      api.openUrl(target.web);
      setLeft("Unsubscribe page opened in your browser.");
    } else {
      props.onMailto(target.mail);
      setLeft("Unsubscribe mail started.");
    }
  };
  const anyTool = () => !!(privacy().trackers || privacy().blocked || minutes() >= 2 || listMail() || designed().size || wide() || hasColumn());
  // Loading images for good is a choice about a sender, so it sits in the menu, beside the conversation's actions.
  const [original, setOriginal] = createSignal<ThreadMessage | null>(null);
  const menu = () => {
    const sender = privacy().sender;
    const items = [...props.menu(), { name: "Show original", run: () => setOriginal(last() ?? null) }];
    if (!sender) return items;
    return [
      ...items,
      { name: "Always load images from this sender", run: () => setSetting("imagesFrom", [...settings.imagesFrom, sender.toLowerCase()]) },
    ];
  };

  // Another conversation starts with its images blocked, reading view off and nobody unsubscribed.
  let shown: number | undefined;
  createEffect(() => {
    const first = props.messages[0]?.id;
    if (first === shown) return;
    shown = first;
    setAsked(false);
    setLeft("");
    setReading(false);
    readingChosen = false;
    setCurrentMark(null);
    setPick(null);
  });

  // MARK: The column beside the messages (docs/design/ui.md §4.2a–c)

  /** A newsletter: mail its sender designed, sent to a list. It opens in reading view unless Settings → Reading
   * says otherwise; the book icon still switches. Decided once per conversation, when its body is here. */
  const newsletter = () => !!last() && designed().has(last().id) && !!last().listUnsubscribe;
  let readingChosen = false;
  createEffect(() => {
    if (readingChosen || !newsletter()) return;
    readingChosen = true;
    if (settings.newsletterReading) setReading(true);
  });

  /** A message's own HTML: without the quote it carries or its signature, whose links were seen before. */
  const ownHtml = (m: ThreadMessage): string | null => {
    const web = webs().get(m.id);
    if (!web) return null;
    const doc = new DOMParser().parseFromString(web.html, "text/html");
    doc.querySelectorAll(HTML_FOLD_SELECTOR).forEach((n) => n.remove());
    return doc.body.innerHTML;
  };
  /** A message's own words: without the quote it carries or its signature. */
  const newWords = (m: ThreadMessage): string => {
    if (m.bodyText?.trim()) {
      const at = foldAt(m.bodyText);
      return at < 0 ? m.bodyText : m.bodyText.slice(0, at);
    }
    if (!m.bodyHtml) return "";
    const doc = new DOMParser().parseFromString(m.bodyHtml, "text/html");
    doc.querySelectorAll(`style, script, ${HTML_FOLD_SELECTOR}`).forEach((n) => n.remove());
    doc.querySelectorAll("br, p, div, li, tr, h1, h2, h3").forEach((n) => n.append("\n"));
    return doc.body.textContent ?? "";
  };
  /** What the newest message holds. A list's mail asks nothing of anyone in particular, and neither does your own. */
  const facts = createMemo(() => {
    const m = last();
    if (!m?.bodyLoaded || !settings.readingFacts) return null;
    const found = factsOf(newWords(m), ownHtml(m), m.date, newsletter() ? 12 : 6);
    if (m.listUnsubscribe || props.mine(m.fromAddr)) found.asks = [];
    return found;
  });
  /** A newsletter's parts, by its headings, while it shows in reading view. */
  const contents = createMemo(() => {
    const m = last();
    const web = m && reading() ? webs().get(m.id) : undefined;
    if (!web || !designed().has(m!.id)) return [];
    const doc = new DOMParser().parseFromString(readingView(web.html), "text/html");
    // Not the mail's name over and over: one-word lines are its brand ("Readwise"), and the subject is in the header.
    const subjectWords = subject().replace(/\s+/g, " ").trim().toLowerCase();
    return [...doc.querySelectorAll("h2")]
      .map((h) => h.textContent?.replace(/\s+/g, " ").trim() ?? "")
      .filter((h) => h.includes(" ") && h.toLowerCase() !== subjectWords)
      .slice(0, 12);
  });
  const toPart = (i: number) => {
    const frame = document.querySelector<HTMLIFrameElement>(`.card[data-message="${last().id}"] iframe`);
    const heading = frame?.contentDocument?.querySelectorAll("h2")[i];
    if (!heading) return;
    const range = heading.ownerDocument.createRange();
    range.selectNode(heading);
    showRange(range, 0.1);
  };

  // Marks: fetched for the conversation's messages, drawn into them, and stepped through with [ and ].
  const ids = createMemo(() => props.messages.map((m) => m.id).join(","));
  const [marks, { refetch: refetchMarks }] = createResource(
    ids,
    (list) => (list ? api.marks(list.split(",").map(Number)) : Promise.resolve([] as Mark[])),
    { initialValue: [] },
  );
  const [currentMark, setCurrentMark] = createSignal<number | null>(null);
  const [placed, setPlaced] = createSignal(new Map<number, Range | null>());
  const [loads, setLoads] = createSignal(0);
  const frameLoaded = () => setLoads((n) => n + 1);
  createEffect(() => {
    const words = props.hits ?? [];
    loads();
    reading();
    for (const m of props.messages) props.expanded(m.id);
    requestAnimationFrame(() => drawHits(words));
  });
  // A mark asked for whose message was folded: shown once its message is open and drawn.
  let wanted: number | null = null;
  createEffect(() => {
    const list = marks();
    const on = currentMark();
    loads();
    reading();
    for (const m of props.messages) props.expanded(m.id);
    requestAnimationFrame(() => {
      const found = drawMarks(list, on);
      setPlaced(found);
      const range = wanted !== null ? found.get(wanted) : null;
      if (range) (wanted = null), showRange(range);
    });
  });
  const showMark = (id: number) => {
    setCurrentMark(id);
    const range = placed().get(id);
    if (range) return showRange(range);
    wanted = id;
    const mark = marks().find((k) => k.id === id);
    const i = props.messages.findIndex((m) => m.id === mark?.message);
    if (i >= 0 && i < props.messages.length - 1 && !props.expanded(props.messages[i].id)) props.onToggle(i);
  };
  // The reader (§4.2c): a newsletter in reading view gets the reader bar and its title in the reading face.
  const reader = () => reading() && newsletter();
  const readerMeta = () =>
    [minutes() ? `${minutes()} min read` : "", contents().length > 1 ? `${contents().length} parts` : ""].filter(Boolean).join(" · ");
  readingSwitch = () => designed().size > 0 && setReading(!reading());
  onCleanup(() => (readingSwitch = null));

  setJumper((step) => {
    const list = marks();
    if (!list.length) return;
    const at = list.findIndex((k) => k.id === currentMark());
    const next = at < 0 ? (step > 0 ? 0 : list.length - 1) : (at + step + list.length) % list.length;
    showMark(list[next].id);
  });
  onCleanup(() => {
    setJumper(null);
    setHovered(null);
    drawHits([]);
    drawMarks([], null);
  });

  // The selection bar: Quote in reply, Mark, Note, Copy, over text selected in a message.
  const [pick, setPick] = createSignal<Picked | null>(null);
  const [noting, setNoting] = createSignal<number | null>(null);
  const [markProblem, setMarkProblem] = createSignal("");
  const unselect = () => {
    document.getSelection()?.removeAllRanges();
    for (const f of document.querySelectorAll<HTMLIFrameElement>(".card iframe")) f.contentWindow?.getSelection()?.removeAllRanges();
  };
  const markIt = async (withNote: boolean) => {
    const p = pick();
    if (!p) return;
    setPick(null);
    unselect();
    try {
      const mark = await api.addMark(p.messageId, p.text, "");
      await refetchMarks();
      setCurrentMark(mark.id);
      if (withNote) setNoting(mark.id);
    } catch (e) {
      setMarkProblem(String(e));
    }
  };
  const dropPick = () => setPick(null);
  onMount(() => {
    window.addEventListener(FRAME_LOADED, frameLoaded);
    window.addEventListener("mousedown", dropPick);
    window.addEventListener("keydown", dropPick);
    window.addEventListener("resize", dropPick);
  });
  onCleanup(() => {
    window.removeEventListener(FRAME_LOADED, frameLoaded);
    window.removeEventListener("mousedown", dropPick);
    window.removeEventListener("keydown", dropPick);
    window.removeEventListener("resize", dropPick);
  });

  // Beside the messages when the pane has room for both, else above them.
  const [wide, setWide] = createSignal(true);
  const hasColumn = () => contents().length > 1 || !!(facts() && anyFact(facts()!)) || marks().length > 0;
  // Beside the messages it stays, found something or not, so it does not come and go between conversations; in a
  // narrow pane, where it sits above them, only when it has something to show.
  const hasMargin = () => settings.readingColumn && (hasColumn() || wide());
  const margin = () => (
    <ReadingMargin
      narrow={!wide()}
      facts={facts()}
      contents={contents()}
      onContents={toPart}
      issue={newsletter()}
      onSnooze={props.onSnoozeUntil}
      marks={marks()}
      current={currentMark()}
      hidden={(id) => !placed().get(id)}
      onShowMark={showMark}
      onChanged={() => void refetchMarks()}
      noting={noting()}
      onHide={() => setSetting("readingColumn", false)}
    />
  );
  /** "3 days later" above the message at `i`, when the one before it is days older. */
  const gap = (i: number) => (i > 0 ? later(props.messages[i - 1].date, props.messages[i].date) : null);

  // The full header scrolls away with the messages; once the subject is out of view a compact bar fades in over
  // the pane. The bar takes no space, so nothing moves as it comes and goes, and nothing can flicker.
  let title!: HTMLHeadingElement;
  const [compact, setCompact] = createSignal(false);
  onMount(() => {
    const pane = title.closest(".conversation-pane");
    const watch = new IntersectionObserver(([e]) => setCompact(!e.isIntersecting), { root: pane });
    watch.observe(title);
    // Room for the messages (560 px at least) and the column beside them.
    // Moving the column resizes the message frames, which have observers of their own: wait for the next frame.
    const room = new ResizeObserver(([e]) => requestAnimationFrame(() => setWide(e.contentRect.width >= 880)));
    if (pane) room.observe(pane);
    const scrolled = () => (setPick(null), setHovered(null));
    pane?.addEventListener("scroll", scrolled, { passive: true });
    onCleanup(() => {
      watch.disconnect();
      room.disconnect();
      pane?.removeEventListener("scroll", scrolled);
    });
  });

  const name = (m: ThreadMessage) => (props.mine(m.fromAddr) ? "You" : m.fromName || m.fromAddr);
  const sender = (m: ThreadMessage) => (
    <PersonCard
      name={m.fromName}
      email={m.fromAddr}
      colour={colour(m.fromAddr)}
      initials={initialsOf(m.fromName, m.fromAddr)}
      actions={props.person}
    >
      <strong title={m.fromAddr}>{name(m)}</strong>
    </PersonCard>
  );
  const replyRow = () => (
    <Show when={!props.replying && last()}>
      {(m) => (
        <div class="reply-end">
          <Show when={aiOn("replies", m().accountId) && !props.mine(m().fromAddr)}>
            <AiReplies id={m().id} onPick={(text) => props.onReply(m(), "reply", text)} />
          </Show>
          <div class="end">
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
  );

  // The conversation's tools: in the header, or in the reader bar, where reading time is said in words and the book
  // is "Original look".
  const tools = () => (
    <div class="tools">
      <Show when={privacy().trackers || privacy().blocked}>
        <button class="tool safe" data-tip={shieldTip()} aria-label={shieldTip()} onClick={() => privacy().blocked && setAsked(true)}>
          <Icon name="shield-check" size={15} />
          <Show when={privacy().trackers}>{privacy().trackers}</Show>
        </button>
      </Show>
      <Show when={minutes() >= 2 && !reader()}>
        <span class="tool" tabIndex={0} data-tip={`${minutes()} min read`} aria-label={`${minutes()} min read`}>
          <Icon name="clock" size={15} />
        </span>
      </Show>
      <Show when={designed().size && !reader()}>
        <button
          class="tool"
          classList={{ on: reading() }}
          aria-pressed={reading()}
          data-tip={reading() ? "Show the original" : "Reading view: the words and pictures in Tern's type"}
          aria-label="Reading view"
          onClick={() => setReading(!reading())}
        >
          <Icon name="book-open" size={15} />
        </button>
      </Show>
      <Show when={wide() || hasColumn()}>
        <button
          class="tool"
          classList={{ on: settings.readingColumn }}
          aria-pressed={settings.readingColumn}
          data-tip={settings.readingColumn ? "Hide the column (I)" : "Show what's in it, links and marks (I)"}
          aria-label="The column beside the messages"
          onClick={() => setSetting("readingColumn", !settings.readingColumn)}
        >
          <Icon name="panel-right" size={15} />
        </button>
      </Show>
      <Show when={listMail()}>
        <button class="tool" data-tip={left() || "Unsubscribe from this list"} aria-label={left() || "Unsubscribe"} onClick={unsubscribe}>
          <Icon name={left() ? "check" : "mail-x"} size={15} />
        </button>
      </Show>
      <Show when={anyTool()}>
        <span class="vsep" />
      </Show>
      <button class="primary" onClick={props.onDone}>
        Done <kbd>E</kbd>
      </button>
      <ActionMenu items={menu} />
      <button class="tool" data-tip="Close (Esc)" aria-label="Close" onClick={props.onClose}>
        <Icon name="x" size={15} />
      </button>
    </div>
  );

  return (
    <div class="reading" classList={{ "has-margin": hasMargin() && wide() }}>
      <div
        class="conversation"
        classList={{ replying: props.replying }}
        onMouseUp={() => setTimeout(() => setPick(picked(document, null, { left: 0, top: 0 })))}
      >
        <div class="compact" classList={{ shown: compact() }} aria-hidden={!compact()}>
          <div class="bar">
            <span class="subject">{subject()}</span>
            <button class="primary" tabIndex={compact() ? 0 : -1} onClick={props.onDone}>
              Done <kbd>E</kbd>
            </button>
          </div>
        </div>
        <Show when={reader()}>
          <div class="reader-bar">
            <strong>{last().fromName || last().fromAddr}</strong>
            <span class="meta">{readerMeta()}</span>
            <span class="spacer" />
            <button class="soft" onClick={() => setReading(false)} title="The mail as its sender made it (Shift+B)">
              Original look <kbd>Shift B</kbd>
            </button>
            <button class="soft" onClick={props.shelf.toggle} title={props.shelf.on ? "Off the shelf, back to the inbox (Shift+L)" : "Keep it on the Read later shelf (Shift+L); a reply brings it back"}>
              {props.shelf.on ? "Back to the inbox" : "Read later"} <kbd>Shift L</kbd>
            </button>
            {tools()}
          </div>
        </Show>
        <header class="conversation-head" classList={{ reader: reader() }}>
          <div class="title">
            <h1 ref={title}>{subject()}</h1>
            <Show when={props.labels.length}>
              <div class="labels">
                <For each={props.labels}>
                  {(l) => (
                    <span class="label-chip" style={{ "--label": labelColour(l) }}>
                      {l}
                    </span>
                  )}
                </For>
              </div>
            </Show>
            <Show when={!stage()}>
              <div class="people">
                <span class="stack">
                  <For each={senders()}>{(m) => <Avatar addr={m.fromAddr} name={m.fromName} />}</For>
                </span>
                <span>
                  {people()} · {props.messages.length} messages
                </span>
              </div>
            </Show>
            <Show when={last() && aiOn("summaries", last().accountId) && last()}>{(m) => <AiSummary id={m().id} />}</Show>
          </div>
          <Show when={!reader()}>{tools()}</Show>
        </header>
        <Show when={hasMargin() && !wide()}>{margin()}</Show>
        {/* Every earlier message as one line, all of them there: a click opens one in place. */}
        <Show when={!stage()}>
          <div class="history">
            <For each={props.messages.slice(0, -1)}>
              {(m, i) => {
                const open = () => props.expanded(m.id);
                return (
                  <>
                    <Show when={gap(i())}>{(g) => <div class="gap">{g()}</div>}</Show>
                    <article
                      class="card row"
                      data-message={m.id}
                      classList={{ focused: i() === props.focused, open: open(), unread: !m.seen, mine: props.mine(m.fromAddr) }}
                    >
                      <header onClick={() => props.onToggle(i())}>
                        <Avatar addr={m.fromAddr} name={m.fromName} />
                        <span class="line">
                          {sender(m)}
                          <Show when={m.draftId != null}>
                            <span class="draft-label">Draft · R to continue</span>
                          </Show>
                          <Show when={open()} fallback={<span class="snippet">{m.snippet}</span>}>
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
                        <time title={full(m.date)}>{when(m.date)}</time>
                      </header>
                      <Show when={open()}>
                        <div class="body">
                          <MessageBody
                            m={m}
                            web={webs().get(m.id)}
                            remote={remoteFor(m)}
                            designed={designed().has(m.id)}
                            reading={reading()}
                            onView={(index) => props.onView(m, index)}
                            onPick={setPick}
                          />
                        </div>
                      </Show>
                    </article>
                  </>
                );
              }}
            </For>
          </div>
          <Show when={gap(props.messages.length - 1)}>{(g) => <div class="gap">{g()}</div>}</Show>
        </Show>
        {/* The newest message, or the only one, on stage: a byline and the body a size up. */}
        <Show when={last()}>
          {(m) => (
            <article class="card stage-msg" data-message={m().id} classList={{ unread: !m().seen, mine: props.mine(m().fromAddr) }}>
              <div class="byline" classList={{ gone: reader() }}>
                <Avatar addr={m().fromAddr} name={m().fromName} />
                <div class="who">
                  <div class="line">
                    {sender(m())}
                    <Show when={m().draftId != null}>
                      <span class="draft-label">Draft · R to continue</span>
                    </Show>
                  </div>
                  <div class="detail" title={full(m().date)}>
                    {[recipients(m().toAddrs, props.mine, names()), ago(m().date)].filter(Boolean).join(" · ")}
                  </div>
                </div>
              </div>
              <div class="body">
                <MessageBody
                  m={m()}
                  web={webs().get(m().id)}
                  remote={remoteFor(m())}
                  designed={designed().has(m().id)}
                  reading={reading()}
                  large
                  title={reader() ? subject() : undefined}
                  onView={(index) => props.onView(m(), index)}
                  onPick={setPick}
                />
              </div>
            </article>
          )}
        </Show>
        {replyRow()}
      </div>
      <Show when={hasMargin() && wide()}>{margin()}</Show>
      <Show when={pick()}>
        {(p) => (
          <div
            class="selection-bar"
            role="toolbar"
            aria-label="Selected text"
            style={{ left: `${Math.max(8, Math.min(p().x - 150, window.innerWidth - 308))}px`, top: `${Math.max(8, p().y - 44)}px` }}
            // Pressing a button must not take the selection away first.
            onMouseDown={(e) => (e.preventDefault(), e.stopPropagation())}
          >
            <button onClick={() => (setPick(null), props.onQuote())}>
              Quote in reply <kbd>R</kbd>
            </button>
            <button onClick={() => void markIt(false)}>Mark</button>
            <button onClick={() => void markIt(true)}>Note</button>
            <button onClick={() => (void navigator.clipboard.writeText(p().text).catch(() => {}), setPick(null))}>Copy</button>
          </div>
        )}
      </Show>
      <Show when={original()}>
        {(m) => <Original id={m().id} subject={m().subject || "(no subject)"} onClose={() => setOriginal(null)} />}
      </Show>
      <Show when={hovered()}>
        {(h) => (
          <div
            class="link-host"
            classList={{ warn: !!h().claimed, above: h().above }}
            style={{ left: `${h().left}px`, top: `${h().top}px` }}
            aria-live="polite"
          >
            <Show when={h().claimed} fallback={h().host}>
              Goes to <strong>{h().host}</strong>, not {h().claimed}
            </Show>
          </div>
        )}
      </Show>
      <Show when={markProblem()}>
        <p class="attachment-problem" role="alert">
          {markProblem()}
        </p>
      </Show>
    </div>
  );
}
