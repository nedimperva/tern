// HTML signatures (Signature.custom), the person's own from another mail app: reading a paste, the text version,
// and pictures that would not reach anyone. Kept apart from signature.ts, which needs the editor.

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
  return doc.body.innerHTML.trim();
}

/** Pictures in an HTML signature that the people written to can't see: ones only on this computer. */
export function localPictures(html: string): number {
  const doc = new DOMParser().parseFromString(html, "text/html");
  return [...doc.querySelectorAll("img")].filter((img) => !/^(https?|data):/i.test(img.getAttribute("src") ?? "")).length;
}
