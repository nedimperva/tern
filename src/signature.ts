// Signatures in compose: where one goes in a new message or reply, and how compose finds it again to swap it.

import { Fragment, type Node } from "prosemirror-model";
import type { Signature } from "./api";
import { fromHtml, fromText, schema, toHtml, toText } from "./editor/schema";

/** The signature as editor blocks, after a "-- " line that lets mail apps fold it away. */
export function signatureDoc(sig: Signature): Node {
  return sig.html ? fromHtml(`<p>-- </p>${sig.html}`) : fromText(`-- \n${sig.body.trim()}`);
}

/** Blocks' words with line breaks and spacing evened out: a draft read back from its HTML loses trailing spaces. */
const words = (nodes: readonly Node[]) =>
  nodes
    .map((n) => n.textBetween(0, n.content.size, " ", " "))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

const blocks = (doc: Node) => {
  const out: Node[] = [];
  doc.forEach((n) => void out.push(n));
  return out;
};

/** Where `sig` sits in `doc`, as positions around its blocks; null when it is not there as written. */
export function findSignature(doc: Node, sig: Signature): { from: number; to: number } | null {
  // An HTML signature is never in the text: compose shows it under it.
  if (sig.custom) return null;
  const want = blocks(signatureDoc(sig));
  const have = blocks(doc);
  const text = words(want);
  let pos = 0;
  for (let i = 0; i + want.length <= have.length; i++) {
    const run = have.slice(i, i + want.length);
    if (words(run) === text) return { from: pos, to: pos + run.reduce((n, b) => n + b.nodeSize, 0) };
    pos += have[i].nodeSize;
  }
  return null;
}

/** Where a signature goes when there is none: before what is quoted or forwarded, or after the quote of a reply
 * when signatures go below it; at the end when nothing is quoted. */
export function signaturePlace(doc: Node, below: boolean): number {
  const have = blocks(doc);
  const quoteHead = (n: Node) =>
    n.type === schema.nodes.paragraph && /^(On .+ wrote:|-{5,} Forwarded message -{5,})/.test(n.textContent.trim());
  let at = have.findIndex((n, i) => n.type === schema.nodes.blockquote || (quoteHead(n) && i > 0));
  if (at < 0 || below) return doc.content.size;
  if (at > 0 && quoteHead(have[at - 1])) at--;
  return have.slice(0, at).reduce((n, b) => n + b.nodeSize, 0);
}

/** Compose's opening text: what is written, the signature, and the quote, as plain text and (when the signature
 * has formatting) HTML. The signature goes above the quote unless `below`; a forward never puts it below. */
export function withSignature(
  text: string,
  quote: string,
  sig: Signature | null,
  below: boolean,
): { body: string; html: string | null } {
  if (!sig || sig.custom) return { body: text + quote, html: null };
  if (!sig.html) {
    const lines = `-- \n${sig.body.trim()}`;
    return { body: below ? `${text}${quote}\n\n${lines}` : `${text}\n\n${lines}${quote}`, html: null };
  }
  // Leading blank lines in `text` are room to write in; fromText keeps one empty paragraph for them.
  const parts = [fromText(text || "\n"), signatureDoc(sig), ...(quote.trim() ? [fromText(quote)] : [])];
  if (below && parts.length === 3) parts.push(parts.splice(1, 1)[0]);
  const doc = schema.topNodeType.create(null, Fragment.fromArray(parts.flatMap(blocks)));
  return { body: toText(doc), html: toHtml(doc) };
}

/** What goes out with an HTML signature (Signature.custom), which the editor can't hold: the text and HTML with it
 * where a signature goes. The text version gets the "-- " line; the HTML is the person's own, as it is. */
export function withHtmlSignature(doc: Node, sig: Signature, below: boolean): { body: string; html: string } {
  const at = signaturePlace(doc, below);
  const before = doc.cut(0, at);
  const after = doc.cut(at);
  const rest = after.childCount ? toText(after) : "";
  return {
    body: `${toText(before).trimEnd()}\n\n-- \n${sig.body.trim()}${rest ? `\n\n${rest}` : ""}`,
    html: `${toHtml(before)}<div class="tern-signature">${sig.html ?? ""}</div>${after.childCount ? toHtml(after) : ""}`,
  };
}
