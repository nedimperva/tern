// Coming back to a conversation (docs/design/ui.md §4.2): what is new since it was last read, and whether any of it
// asks something. Plain functions, unit-tested in src/test/catchup.test.ts.

import { foldAt } from "./fold";

type Message = { id: number; fromAddr: string; bodyText: string | null; snippet: string };

/** Whether the message's own words (its quote and signature aside) ask a question. */
export function asks(text: string) {
  const at = foldAt(text);
  const own = at < 0 ? text : text.slice(0, at);
  // A question mark ending a sentence, not one inside a link.
  return /[^\s/=&?]\?(\s|$)/.test(own.replace(/https?:\/\/\S+/g, ""));
}

/** "3 new · 1 asks you something": only when there was something read before, so a first visit says nothing. */
export function catchUp(messages: Message[], fresh: ReadonlySet<number>, mine: (addr: string) => boolean) {
  const added = messages.filter((m) => fresh.has(m.id));
  if (!added.length || added.length === messages.length) return null;
  const questions = added.filter((m) => !mine(m.fromAddr) && asks(m.bodyText ?? m.snippet)).length;
  return { count: added.length, questions, first: added[0].id };
}
