// HTML signatures (Signature.custom), the person's own from another mail app: reading a paste, the text version,
// and pictures that would not reach anyone. Kept apart from signature.ts, which needs the editor.

import type { Signature } from "./api";

/** The plain-text version of an HTML signature, for the text part of the mail: one line per row or block. */
export function htmlText(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll("style, script, title").forEach((e) => e.remove());
  doc.querySelectorAll("br").forEach((e) => e.replaceWith("\n"));
  doc.querySelectorAll("p, div, tr, li, table, h1, h2, h3, h4").forEach((e) => e.append("\n"));
  doc.querySelectorAll("td, th").forEach((e) => e.append(" "));
  return (doc.body.textContent ?? "")
    .split("\n")
    .map((l) => l.replace(/[\s ]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** What was pasted, as HTML: another mail app's signature copied with its formatting, else the plain text. */
export function pastedHtml(data: DataTransfer): string {
  const html = data.getData("text/html");
  if (!html) {
    const box = document.createElement("div");
    box.textContent = data.getData("text/plain");
    return box.innerHTML.replace(/\n/g, "<br>");
  }
  // The clipboard wraps a copy in a whole page with markers around the part copied: the part is what counts.
  const doc = new DOMParser().parseFromString(html, "text/html");
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_COMMENT);
  const comments: ChildNode[] = [];
  while (walker.nextNode()) comments.push(walker.currentNode as ChildNode);
  comments.forEach((c) => c.remove());
  doc.body.querySelectorAll("meta, title, script").forEach((e) => e.remove());
  // Copies often start or end with empty lines (Gmail's begins with two): they would show as a gap.
  const empty = (n: ChildNode | null) =>
    !!n &&
    (n.nodeName === "BR" ||
      (n.nodeType === Node.TEXT_NODE && !n.textContent?.trim()) ||
      (n instanceof Element && !n.textContent?.trim() && !n.querySelector("img")));
  while (empty(doc.body.firstChild)) doc.body.firstChild!.remove();
  while (empty(doc.body.lastChild)) doc.body.lastChild!.remove();
  return doc.body.innerHTML.trim();
}

/** `text` when it is HTML code (a signature from a generator or another app's settings, pasted as text), else null. */
export function htmlSource(text: string): string | null {
  const t = text.trim();
  const opens = /^<(!doctype|html|body|table|div|p|span|a|img|font|b|strong|em|i|h[1-6]|ul|ol|section|style|meta)\b/i;
  if (!opens.test(t) || !t.endsWith(">") || !/<\/[a-z]|\/>|<br\b/i.test(t)) return null;
  return t;
}

/** A signature whose text is HTML code, as the HTML signature it was meant to be. Written in "Write it here",
 * the code was kept as words and went out as code. */
export function codeAsHtml(sig: Signature): Signature {
  const src = sig.custom || sig.html ? null : htmlSource(sig.body);
  return src ? { ...sig, custom: true, html: src, body: htmlText(src) } : sig;
}

/** Pictures in an HTML signature that the people written to can't see: ones only on this computer. */
export function localPictures(html: string): number {
  const doc = new DOMParser().parseFromString(html, "text/html");
  return [...doc.querySelectorAll("img")].filter((img) => !/^(https?|data):/i.test(img.getAttribute("src") ?? "")).length;
}
