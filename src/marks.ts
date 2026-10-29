// Marks in an open conversation (docs/design/ui.md §4.2b): where each marked passage is in its message, drawn with
// the CSS Custom Highlight API so the message's own markup is never changed (mail HTML sits in a sandboxed frame,
// and wrapping its text would break its layout). Kept by text, so a mark survives the message being shown again.

import type { Mark } from "./api";

/** Words only, one space between them: a selection and the text it came from differ in their spaces. */
const squash = (s: string) => s.replace(/\s+/g, " ").trim();

/** The range of `text` in `root`, across element boundaries; null when it is not there (an edited draft). */
export function rangeOf(root: Node, text: string): Range | null {
  const doc = root.ownerDocument ?? (root as Document);
  const want = squash(text);
  if (!want) return null;
  // The squashed text of every text node, and for each of its characters the node and offset it came from.
  const nodes: Text[] = [];
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n as Text);
  let flat = "";
  const from: [Text, number][] = [];
  let space = true;
  for (const node of nodes) {
    const s = node.data;
    for (let i = 0; i < s.length; i++) {
      const blank = /\s/.test(s[i]);
      if (blank && space) continue;
      flat += blank ? " " : s[i];
      from.push([node, i]);
      space = blank;
    }
  }
  const at = flat.indexOf(want);
  if (at < 0) return null;
  const [startNode, startOffset] = from[at];
  const [endNode, endOffset] = from[at + want.length - 1];
  const range = doc.createRange();
  range.setStart(startNode, startOffset);
  range.setEnd(endNode, endOffset + 1);
  return range;
}

/** Where a message's words are: inside its frame for HTML mail, else the card's body. */
function rootOf(messageId: number): Node | null {
  const card = document.querySelector<HTMLElement>(`.card[data-message="${messageId}"]`);
  if (!card) return null;
  const frame = card.querySelector<HTMLIFrameElement>("iframe");
  return frame ? (frame.contentDocument?.body ?? null) : card.querySelector(".body");
}

type Highlights = { set(name: string, h: unknown): void; delete(name: string): void };
const registry = (w: Window | null) => (w as unknown as { CSS?: { highlights?: Highlights } } | null)?.CSS?.highlights;
const HighlightOf = (w: Window | null) => (w as unknown as { Highlight?: new (...r: Range[]) => unknown } | null)?.Highlight;

/** Draws the marks, the current one (`on`) stronger, and returns where each one is (null: not shown, its message
 * folded or the text gone). Each window has its own highlights, so a frame's ranges are drawn in that frame. */
export function drawMarks(marks: Mark[], on: number | null): Map<number, Range | null> {
  const found = new Map<number, Range | null>();
  const byWindow = new Map<Window, { all: Range[]; current: Range[] }>();
  for (const mark of marks) {
    const root = rootOf(mark.message);
    const range = root ? rangeOf(root, mark.text) : null;
    found.set(mark.id, range);
    const w = range?.startContainer.ownerDocument?.defaultView;
    if (!range || !w) continue;
    const entry = byWindow.get(w) ?? { all: [], current: [] };
    (mark.id === on ? entry.current : entry.all).push(range);
    byWindow.set(w, entry);
  }
  // Clear every window that showed marks before, then draw the ones that have some now.
  const windows = new Set<Window>([window, ...[...document.querySelectorAll<HTMLIFrameElement>(".card iframe")].map((f) => f.contentWindow!).filter(Boolean)]);
  for (const w of windows) {
    // A mail's frame on its way out refuses access and throws, which would stop the window's update (hits.ts).
    try {
      const reg = registry(w);
      const Highlight = HighlightOf(w);
      if (!reg || !Highlight) continue;
      const entry = byWindow.get(w);
      if (entry?.all.length) reg.set("tern-mark", new Highlight(...entry.all));
      else reg.delete("tern-mark");
      if (entry?.current.length) reg.set("tern-mark-on", new Highlight(...entry.current));
      else reg.delete("tern-mark-on");
    } catch {}
  }
  return found;
}

/** Scrolls the conversation so a range sits `at` of the way down the pane (a third, for a mark). */
export function showRange(range: Range, at = 1 / 3) {
  const pane = document.querySelector<HTMLElement>(".conversation-pane");
  if (!pane) return;
  const box = range.getBoundingClientRect();
  const frame = range.startContainer.ownerDocument?.defaultView?.frameElement as HTMLElement | null;
  const top = box.top + (frame ? frame.getBoundingClientRect().top : 0);
  const paneTop = pane.getBoundingClientRect().top;
  pane.scrollBy({ top: top - paneTop - pane.clientHeight * at, behavior: "smooth" });
}

/** The styles a mail frame needs to show marks and search hits (hits.ts); added once the frame has loaded. */
export const FRAME_MARK_STYLE =
  "::highlight(tern-mark){background-color:rgba(242,201,76,.38);color:inherit}::highlight(tern-mark-on){background-color:rgba(124,124,240,.38);color:inherit}" +
  "::highlight(tern-hit){background-color:rgba(47,158,110,.26);color:inherit}";

// `[` and `]` are the app's keys (App.tsx); the open conversation says what they do.
let jumper: ((step: 1 | -1) => void) | null = null;
export const setJumper = (f: typeof jumper) => (jumper = f);
export const jumpMark = (step: 1 | -1) => jumper?.(step);
