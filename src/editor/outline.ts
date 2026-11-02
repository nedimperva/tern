import type { Node as ProseNode } from "prosemirror-model";

/** One top-level block of the mail as the outline lists it. */
export type Part = { index: number; pos: number; size: number; label: string; ask: boolean; greeting: boolean; heading: boolean };
// A question mark, or the usual ways of asking in English and Bosnian. Unicode-aware edges, as in facts.ts.
const ASKS =
  /\?|(?<![\p{L}\p{N}])(please|could you|can you|would you|let me know|by (monday|tuesday|wednesday|thursday|friday|tomorrow|the end of)|molim|možete li|možeš li|javi(te)? mi)(?![\p{L}\p{N}])/iu;

/** The parts of the person's own text: not the quote at the end, not the signature, not empty lines. */
export function partsOf(doc: ProseNode, signature: string): Part[] {
  const flat = (t: string) => t.replace(/\s+/g, " ").trim();
  const sig = flat(signature);
  const out: Part[] = [];
  // From the "-- " line on it is the signature, whatever the saved one says.
  let signed = false;
  doc.forEach((node, pos, index) => {
    if (signed || node.type.name === "blockquote") return;
    const text = flat(node.textBetween(0, node.content.size, " ", " "));
    if (/^--( |$)/.test(text)) signed = true;
    if (!text || signed) return;
    out.push({ index, pos, size: node.nodeSize, label: text, ask: ASKS.test(text), greeting: false, heading: false });
  });
  while (sig && out.length && sig.includes(out[out.length - 1].label)) out.pop();
  for (const [k, p] of out.entries()) {
    const n = p.label.split(" ").length;
    p.greeting = k === 0 && n <= 4 && /[,!]$/.test(p.label);
    p.heading = !p.greeting && k < out.length - 1 && n <= 8 && !/[.?!:,;]$/.test(p.label);
    if (p.heading) p.ask = false;
    p.label = n > 7 ? `${p.label.split(" ").slice(0, 7).join(" ")}…` : p.label;
  }
  return out;
}
