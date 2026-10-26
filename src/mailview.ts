// How a message's HTML is drawn (docs/design/ui.md §4.2). Mail that is mostly text takes Tern's own type and
// colours; mail its sender laid out (newsletters, receipts) keeps its design, framed, and can be darkened.
import interLatin from "@fontsource-variable/inter/files/inter-latin-wght-normal.woff2?url";
import interLatinExt from "@fontsource-variable/inter/files/inter-latin-ext-wght-normal.woff2?url";
import { HTML_FOLD_CSS } from "./fold";

/** Colours a frame takes from the app's theme (the frame cannot read the app's CSS variables). */
export type FrameTheme = { dark: boolean; fg0: string; fg1: string; fg2: string; line: string; accent: string; bg2: string };

export function frameTheme(dark: boolean): FrameTheme {
  const css = getComputedStyle(document.documentElement);
  const get = (name: string) => css.getPropertyValue(name).trim();
  return {
    dark,
    fg0: get("--fg-0"),
    fg1: get("--fg-1"),
    fg2: get("--fg-2"),
    line: get("--line"),
    accent: get("--accent"),
    bg2: get("--bg-2"),
  };
}

const WHITE = /^\s*(#fff(fff)?|white|transparent|none|inherit|initial|rgba?\(\s*255\s*,\s*255\s*,\s*255\s*(,\s*1\s*)?\))\s*(!important)?\s*$/i;

/** Whether the sender laid the mail out: layout tables with their own colours or wide pictures. Outlook and
 * Gmail replies (white backgrounds, a signature table) count as text. */
export function isDesigned(html: string): boolean {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const painted = [...doc.querySelectorAll<HTMLElement>("[bgcolor], [style*='background']")].filter((el) => {
    const attr = el.getAttribute("bgcolor");
    if (attr && !WHITE.test(attr)) return true;
    const style = /background(?:-color)?\s*:\s*([^;]+)/i.exec(el.getAttribute("style") ?? "");
    return !!style && !WHITE.test(style[1]) && !/^url\(/i.test(style[1].trim());
  }).length;
  const wide = [...doc.images].filter((img) => Number.parseInt(img.getAttribute("width") ?? "0", 10) >= 300).length;
  const layout = [...doc.querySelectorAll("table")].filter(
    (t) => t.querySelector("table") || t.hasAttribute("bgcolor") || /^(\d{3,}|100%)$/.test(t.getAttribute("width") ?? ""),
  ).length;
  return painted >= 3 || (layout > 0 && (painted > 0 || wide > 0)) || layout >= 3;
}

/** A remote picture nobody is meant to see: a pixel or a hidden image, there to report that the mail was opened. */
function isTracker(img: HTMLImageElement): boolean {
  const style = img.getAttribute("style") ?? "";
  const size = (name: "width" | "height") => {
    const attr = img.getAttribute(name);
    const css = new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*([\\d.]+)px`, "i").exec(style);
    return Number.parseFloat(attr ?? css?.[1] ?? "NaN");
  };
  return size("width") <= 2 || size("height") <= 2 || /display\s*:\s*none|visibility\s*:\s*hidden/i.test(style);
}

/** What a mail would fetch from the web. */
export type Remote = { html: string; trackers: number; images: number };

/** Takes tracking pixels out of a mail, so they never load, not even once images are allowed, and counts the
 * pictures that wait for "Load images". */
export function withoutTrackers(html: string): Remote {
  if (!/https?:/i.test(html)) return { html, trackers: 0, images: 0 };
  const doc = new DOMParser().parseFromString(html, "text/html");
  let trackers = 0;
  let images = (html.match(/url\(\s*["']?https?:|\sbackground=["']?https?:/gi) ?? []).length;
  for (const img of [...doc.images]) {
    if (!/^\s*(https?:)?\/\//i.test(img.getAttribute("src") ?? "")) continue;
    if (isTracker(img)) {
      img.remove();
      trackers++;
    } else {
      images++;
    }
  }
  return { html: trackers ? doc.documentElement.outerHTML : html, trackers, images };
}

/** Minutes a mail takes to read at an unhurried 230 words a minute. */
export function readingMinutes(html: string): number {
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll("head, style, script").forEach((el) => el.remove());
  const words = (doc.body?.textContent ?? "").split(/\s+/).filter(Boolean).length;
  return Math.round(words / 230);
}

const CSP = (remote: boolean) =>
  `default-src 'none'; img-src ${remote ? "data: cid: https: http:" : "data: cid:"}; style-src 'unsafe-inline'; font-src data: ${location.origin}`;

const FONT_FACES = `
@font-face{font-family:"Inter Variable";font-weight:100 900;font-display:swap;src:url(${new URL(interLatin, location.href).href}) format("woff2-variations");
  unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD}
@font-face{font-family:"Inter Variable";font-weight:100 900;font-display:swap;src:url(${new URL(interLatinExt, location.href).href}) format("woff2-variations");
  unicode-range:U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF}`;

const page = (remote: boolean, css: string, html: string) => `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${CSP(remote)}">
<style>${css}
  /* The frame is sized to the mail, so the mail must not size itself to the frame: a body at height 100% would
     keep whatever height the frame last had. */
  html,body{height:auto!important;min-height:0!important}
  img{max-width:100%;height:auto}
  pre{white-space:pre-wrap}
  ${HTML_FOLD_CSS}
</style></head><body>${html}</body></html>`;

/** Sizes a mail's frame to its content: the mail's own height, never the frame's current one (which only ever
 * grew, leaving space below a mail shown after a taller one), and mail laid out wider than the frame (fixed-width
 * tables, as Apple's) shrunk to fit, as other mail apps do, rather than cut off at the right. */
export function fitFrame(frame: HTMLIFrameElement, doc: Document) {
  const body = doc.body;
  if (!body) return;
  const room = doc.documentElement.clientWidth;
  const overflows = () => Math.max(body.scrollWidth, doc.documentElement.scrollWidth) > room + 1;
  // The zoom is worked out again only when the frame's width changed or the mail no longer fits (a picture came
  // in). Resetting it on every resize made the body change size, which fired the observer that calls this, around
  // and around: the mail flashed, many times a second.
  if (frame.dataset.room !== String(room) || overflows()) {
    frame.dataset.room = String(room);
    body.style.zoom = "";
    const wide = Math.max(body.scrollWidth, doc.documentElement.scrollWidth);
    if (room > 0 && wide > room + 1) body.style.zoom = String(room / wide);
  }
  frame.style.height = `${Math.ceil(body.getBoundingClientRect().height)}px`;
}

/** Text mail in Tern's type, on the app's own background: the sender's fonts and colours give way, so it reads
 * like the rest of Tern and follows dark mode. Links, sizes and emphasis stay. */
export function textFrame(html: string, remote: boolean, t: FrameTheme, size = 15): string {
  return page(
    remote,
    `${FONT_FACES}
  :root{color-scheme:${t.dark ? "dark" : "light"}}
  html,body{margin:0;padding:0;background:transparent;overflow:hidden}
  body{padding:2px 0 4px;max-width:72ch;color:${t.fg0};font:${size}px/${size > 15 ? 1.7 : 1.65} "Inter Variable","Inter",system-ui,sans-serif;word-wrap:break-word}
  body *:not(a){color:inherit!important;background-color:transparent!important;font-family:inherit!important}
  a{color:${t.accent}!important;text-decoration-color:color-mix(in srgb,${t.accent} 40%,transparent);text-underline-offset:2px}
  body blockquote{margin:8px 0!important;padding:2px 0 2px 12px!important;border:0!important;border-left:3px solid ${t.line}!important;color:${t.fg1}!important}
  .gmail_attr,.moz-cite-prefix{color:${t.fg2}!important;font-size:13px}
  hr{border:0;border-top:1px solid ${t.line}}
  table{border-collapse:collapse}
  td,th{border-color:${t.line}!important}`,
    html,
  );
}

/** Designed mail as its sender made it, on white unless it says otherwise. */
export function designedFrame(html: string, remote: boolean): string {
  return page(
    remote,
    `:root{color-scheme:light}
  html,body{margin:0;padding:0;overflow:hidden}
  html{background:#fff}
  body{color:#111;font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;word-wrap:break-word}`,
    html,
  );
}

// MARK: Dark mode for designed mail

type Rgb = { r: number; g: number; b: number; a: number };

function parseRgb(css: string): Rgb | null {
  const m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,/\s]+([\d.]+%?))?\s*\)$/.exec(css.trim());
  if (!m) return null;
  const a = m[4] === undefined ? 1 : m[4].endsWith("%") ? Number.parseFloat(m[4]) / 100 : Number(m[4]);
  return { r: +m[1], g: +m[2], b: +m[3], a };
}

function toHsl({ r, g, b }: Rgb): [number, number, number] {
  const [rr, gg, bb] = [r / 255, g / 255, b / 255];
  const max = Math.max(rr, gg, bb);
  const min = Math.min(rr, gg, bb);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === rr ? (gg - bb) / d + (gg < bb ? 6 : 0) : max === gg ? (bb - rr) / d + 2 : (rr - gg) / d + 4;
  return [h * 60, s, l];
}

const hsl = (h: number, s: number, l: number, a: number) =>
  `hsla(${h.toFixed(0)}, ${(s * 100).toFixed(0)}%, ${(l * 100).toFixed(1)}%, ${a})`;

/** A light background turned dark, keeping its hue; dark ones (a brand's header) stay. */
export function darkBackground(c: Rgb): string | null {
  const [h, s, l] = toHsl(c);
  if (l <= 0.5) return null;
  return hsl(h, s * 0.5, 0.11 + (1 - l) * 0.45, c.a);
}

/** Dark text made light, keeping its hue, so links stay blue and red stays red. */
export function lightText(c: Rgb): string | null {
  const [h, s, l] = toHsl(c);
  if (l >= 0.55) return null;
  return hsl(h, Math.min(s, 0.8), 0.86 - l * 0.35, c.a);
}

/** Darkens a designed mail in place, as other mail apps do in dark mode: backgrounds go dark, text goes light,
 * pictures are left alone. Reads every colour first, then writes, so the page is styled once. */
export function darken(doc: Document) {
  const win = doc.defaultView;
  if (!win || !doc.body) return;
  const all = [doc.documentElement, doc.body, ...doc.body.querySelectorAll<HTMLElement>("*")];
  const plan: [HTMLElement, string | null, string | null, string | null][] = [];
  for (const el of all) {
    if (el instanceof win.HTMLImageElement || el instanceof win.SVGElement) continue;
    const cs = win.getComputedStyle(el);
    const bg = parseRgb(cs.backgroundColor);
    const fg = parseRgb(cs.color);
    const border = cs.borderTopStyle !== "none" ? parseRgb(cs.borderTopColor) : null;
    plan.push([
      el,
      bg && bg.a > 0 ? darkBackground(bg) : null,
      fg ? lightText(fg) : null,
      border && toHsl(border)[2] > 0.6 ? "rgba(255, 255, 255, 0.14)" : null,
    ]);
  }
  for (const [el, bg, fg, border] of plan) {
    if (bg) el.style.setProperty("background-color", bg, "important");
    if (fg) el.style.setProperty("color", fg, "important");
    if (border) el.style.setProperty("border-color", border, "important");
  }
  // Mail that sets no background of its own sat on the frame's white.
  const root = parseRgb(win.getComputedStyle(doc.documentElement).backgroundColor);
  if (!root || root.a === 0 || toHsl(root)[2] > 0.5) doc.documentElement.style.setProperty("background-color", "#18181b", "important");
}

// MARK: Reading view

const KEEP_INLINE = new Set(["A", "B", "STRONG", "I", "EM", "U", "BR", "SPAN", "FONT", "SMALL", "SUP", "SUB", "CODE", "ABBR", "LABEL"]);
const BLOCKS = "h1,h2,h3,h4,h5,h6,p,li,td,th,div,blockquote,pre";

/** A designed mail's words, headings, links and pictures, without its layout: for reading a long newsletter in
 * Tern's type. Small pictures (spacers, icons, tracking pixels) are dropped. */
export function readingView(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll("style, script, head, title, meta, [hidden]").forEach((el) => el.remove());
  const out: string[] = [];
  const nested = (el: Element) => el.querySelector(BLOCKS + ",img,table,ul,ol") !== null;
  // Text and inline elements, with only links (to the web or mail) and emphasis kept.
  const fragment = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return escape(node.textContent ?? "");
    if (!(node instanceof Element)) return "";
    const inner = [...node.childNodes].map(fragment).join("");
    const href = node.getAttribute("href") ?? "";
    if (node.tagName === "A") return /^(https?|mailto):/i.test(href) ? `<a href="${escape(href)}">${inner}</a>` : inner;
    if (node.tagName === "BR") return "<br>";
    if (/^(B|STRONG)$/.test(node.tagName)) return `<strong>${inner}</strong>`;
    if (/^(I|EM)$/.test(node.tagName)) return `<em>${inner}</em>`;
    return inner;
  };
  const push = (tag: string, html: string) => {
    const text = html.replace(/\s+/g, " ").trim();
    if (text.replace(/<[^>]+>|<br>/g, "").trim()) out.push(`<${tag}>${text}</${tag}>`);
  };
  const walk = (el: Element) => {
    let run = "";
    for (const node of el.childNodes) {
      if (node.nodeType === Node.TEXT_NODE || (node instanceof Element && KEEP_INLINE.has(node.tagName) && !nested(node))) {
        run += fragment(node);
        continue;
      }
      if (!(node instanceof Element)) continue;
      push("p", run);
      run = "";
      if (node.tagName === "IMG") {
        const w = Number.parseInt(node.getAttribute("width") ?? "0", 10);
        const src = node.getAttribute("src") ?? "";
        if ((w === 0 || w >= 200) && /^(https?|data|cid):/i.test(src)) {
          out.push(`<p><img src="${escape(src)}" alt="${escape(node.getAttribute("alt") ?? "")}"></p>`);
        }
      } else if (/^H[1-6]$/.test(node.tagName) && !nested(node)) {
        push(/^H[1-3]$/.test(node.tagName) ? "h2" : "h3", fragment(node));
      } else if (node.tagName === "LI" && !nested(node)) {
        push("p", `• ${fragment(node)}`);
      } else {
        walk(node);
      }
    }
    push("p", run);
  };
  if (doc.body) walk(doc.body);
  return out.join("\n");
}

function escape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** The reading view's frame: Tern's colours with a book face for long text. */
export function readingFrame(html: string, remote: boolean, t: FrameTheme): string {
  return page(
    remote,
    `${FONT_FACES}
  :root{color-scheme:${t.dark ? "dark" : "light"}}
  html,body{margin:0;padding:0;background:transparent;overflow:hidden}
  body{padding:2px 0 8px;max-width:62ch;color:${t.fg0};font:17px/1.7 "Source Serif 4","Iowan Old Style","Charter",Georgia,serif;word-wrap:break-word}
  h2,h3{font-family:"Inter Variable","Inter",system-ui,sans-serif;line-height:1.3;margin:18px 0 8px}
  h2{font-size:22px} h3{font-size:17px}
  p{margin:0 0 14px}
  img{display:block;border-radius:8px;margin:4px 0}
  a{color:${t.accent}}`,
    html,
  );
}
