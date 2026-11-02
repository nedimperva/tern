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
    // A short line is a title only over a real paragraph; a list of short lines stays a list.
    const next = out[k + 1]?.label.split(" ").length ?? 0;
    p.heading = !p.greeting && next > 12 && n <= 8 && !/[.?!:,;]$/.test(p.label);
    if (p.heading) p.ask = false;
    p.label = n > 7 ? `${p.label.split(" ").slice(0, 7).join(" ")}…` : p.label;
  }
  return out;
}

/** Where the signature sits: from its "-- " line to the quote or the end, and a name to show while it is folded
 * (its first line that isn't a closing like "Best," or "S poštovanjem,"). */
export function signatureRange(doc: ProseNode): { from: number; to: number; name: string } | null {
  let from = -1;
  let to = doc.content.size;
  const lines: string[] = [];
  doc.forEach((node, pos) => {
    if (from >= 0 && to === doc.content.size && node.type.name === "blockquote") to = pos;
    if (from >= 0 || node.type.name === "blockquote") {
      if (from >= 0 && pos < to) lines.push(...node.textBetween(0, node.content.size, "\n", "\n").split("\n"));
      return;
    }
    const text = node.textBetween(0, node.content.size, "\n", "\n");
    if (!/^--[^\S\n]*(\n|$)/.test(text)) return;
    from = pos;
    lines.push(...text.split("\n").slice(1));
  });
  if (from < 0) return null;
  // The "On …, Ada wrote:" line just above the quote belongs to the quote, not to the signature.
  if (to < doc.content.size) {
    const before = doc.resolve(to).nodeBefore;
    if (before && to - before.nodeSize > from && /:\s*$/.test(before.textContent)) {
      to -= before.nodeSize;
      lines.splice(lines.length - before.textBetween(0, before.content.size, "\n", "\n").split("\n").length);
    }
  }
  const name = lines.map((l) => l.trim()).find((l) => l && !/[,:]$/.test(l)) ?? "";
  return { from, to, name: name.length > 40 ? `${name.slice(0, 40)}…` : name };
}
