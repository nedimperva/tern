// Links in plain-text mail. HTML mail has its own anchors; a plain body only has text that looks like an address.

export type Piece = string | { href: string; text: string };

const LINK = /\b(?:https?:\/\/|mailto:|www\.)[^\s<>"'`]+/gi;

/** `text` cut into plain runs and links. A link drops punctuation that ends the sentence around it ("see
 * https://x.org." or "(https://x.org)") but keeps a closing bracket it opened itself (Wikipedia's "_(film)"). */
export function linkify(text: string): Piece[] {
  const out: Piece[] = [];
  let at = 0;
  for (const m of text.matchAll(LINK)) {
    let link = m[0];
    for (;;) {
      const last = link.at(-1)!;
      if (/[.,;:!?'"*]/.test(last)) link = link.slice(0, -1);
      else if (last === ")" && count(link, "(") < count(link, ")")) link = link.slice(0, -1);
      else if (last === "]" && count(link, "[") < count(link, "]")) link = link.slice(0, -1);
      else if (last === ">" || last === "}") link = link.slice(0, -1);
      else break;
    }
    if (/^(www\.|mailto:)$/i.test(link) || /^https?:\/\/$/i.test(link)) continue;
    if (m.index > at) out.push(text.slice(at, m.index));
    const href = /^www\./i.test(link) ? `https://${link}` : link;
    out.push({ href, text: link });
    at = m.index + link.length;
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
}

function count(s: string, c: string): number {
  return s.split(c).length - 1;
}
