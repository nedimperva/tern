// The conversation list's rows: how they are told apart across reloads, and how a reload keeps the ones that did
// not change. Plain functions, so they are unit-tested (src/test/rows.test.ts).

import type { MessageRow, ThreadRow } from "../api";

/** A conversation's identity across reloads: its newest message, and so the row's id, changes as mail arrives. */
export const keyOf = (r: MessageRow) => `${r.accountId}:${r.threadId}`;

/** `next`, with each row that did not change kept as the very object it was, so the list's <For> keeps its
 * element instead of making it again: during a backfill the list reloads many times a second. */
export function keepRows<T extends MessageRow>(old: T[], next: T[]): T[] {
  if (!old.length) return next;
  const before = new Map(old.map((r) => [keyOf(r), r]));
  return next.map((r) => {
    const was = before.get(keyOf(r));
    return was && sameRow(was, r) ? was : r;
  });
}

export function sameRow(a: object, b: object): boolean {
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => {
    const x = (a as Record<string, unknown>)[k];
    const y = (b as Record<string, unknown>)[k];
    return x === y || (typeof x === "object" && typeof y === "object" && JSON.stringify(x) === JSON.stringify(y));
  });
}

/** A search hit shown like a conversation row. */
export const asRow = (m: MessageRow): ThreadRow => ({
  ...m,
  snoozedUntil: null,
  count: 1,
  unread: m.seen ? 0 : 1,
  participants: [m.fromName || m.fromAddr],
});
