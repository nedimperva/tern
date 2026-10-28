// The words searched for, lit up in a conversation opened from the results, so the reason it was found is in view.
// Drawn with the CSS Custom Highlight API like marks (marks.ts): the message's own markup is never touched.

/** The words a search looks for: filters (`from:ada`), left-out words (`-paid`) and OR dropped; a quoted phrase
 * stays whole. */
export function hitWords(query: string): string[] {
  const out: string[] = [];
  for (const m of query.matchAll(/(-?)(?:"([^"]*)"?|(\S+))/g)) {
    const [, minus, phrase, word] = m;
    if (minus || word === "OR") continue;
    if (word && /^[a-z_]+:/i.test(word)) continue;
    const text = (phrase ?? word ?? "").trim();
    if (text.length >= 2) out.push(text.toLowerCase());
  }
  return out;
}

type Highlights = { set(name: string, h: unknown): void; delete(name: string): void };

/** Lights up `words` in every open message: a word where a word starts (search matches prefixes), a phrase as
 * written. An empty list clears them. */
export function drawHits(words: string[]) {
  const byWindow = new Map<Window, Range[]>();
  const roots: Node[] = [];
  for (const card of document.querySelectorAll<HTMLElement>(".card[data-message]")) {
    const frame = card.querySelector<HTMLIFrameElement>("iframe");
    const root = frame ? frame.contentDocument?.body : card.querySelector(".body");
    if (root) roots.push(root);
    if (frame?.contentWindow) byWindow.set(frame.contentWindow, []);
  }
  byWindow.set(window, []);
  const pattern = words.length
    ? new RegExp(`(?<![\\p{L}\\p{N}])(?:${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "giu")
    : null;
  for (const root of pattern ? roots : []) {
    const doc = root.ownerDocument!;
    const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const text = n as Text;
      if (text.parentElement?.closest("style, script")) continue;
      for (const m of text.data.matchAll(pattern!)) {
        const range = doc.createRange();
        range.setStart(text, m.index);
        range.setEnd(text, m.index + m[0].length);
        byWindow.get(doc.defaultView!)?.push(range);
      }
    }
  }
  for (const [w, ranges] of byWindow) {
    const api = w as unknown as { CSS?: { highlights?: Highlights }; Highlight?: new (...r: Range[]) => unknown };
    const reg = api.CSS?.highlights;
    if (!reg || !api.Highlight) continue;
    if (ranges.length) reg.set("tern-hit", new api.Highlight(...ranges));
    else reg.delete("tern-hit");
  }
}
