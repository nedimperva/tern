import { describe, expect, it } from "vitest";
import type { ThreadRow } from "../api";
import { asRow, keepRows, keyOf, sameRow } from "../app/rows";

const row = (over: Partial<ThreadRow> = {}): ThreadRow =>
  ({
    id: 1,
    accountId: 1,
    threadId: "t10",
    folderId: 1,
    uid: 1,
    subject: "Hello",
    fromName: "Ada",
    fromAddr: "ada@example.com",
    date: 100,
    seen: false,
    flagged: false,
    snippet: "",
    hasAttachments: false,
    labels: ["Work"],
    snoozedUntil: null,
    count: 2,
    unread: 1,
    participants: ["Ada"],
    ...over,
  }) as ThreadRow;

describe("keyOf", () => {
  it("names the conversation, not its newest message", () => {
    expect(keyOf(row({ id: 1 }))).toBe(keyOf(row({ id: 2 })));
    expect(keyOf(row({ accountId: 2 }))).not.toBe(keyOf(row()));
  });
});

describe("keepRows", () => {
  it("keeps the old object for a row that did not change, labels compared by value", () => {
    const old = [row(), row({ threadId: "t11" })];
    const next = [row(), row({ threadId: "t11", unread: 0 })];
    const kept = keepRows(old, next);
    expect(kept[0]).toBe(old[0]);
    expect(kept[1]).toBe(next[1]);
  });

  it("takes a new message in the conversation as a change", () => {
    const old = [row()];
    const kept = keepRows(old, [row({ id: 2, date: 200 })]);
    expect(kept[0]).not.toBe(old[0]);
  });

  it("returns the new rows as they are when there were none", () => {
    const next = [row()];
    expect(keepRows([], next)).toBe(next);
  });
});

describe("sameRow", () => {
  it("sees a field more or less as a change", () => {
    expect(sameRow({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(sameRow({ a: [1] }, { a: [1] })).toBe(true);
  });
});

describe("asRow", () => {
  it("shows a search hit as a one-message conversation", () => {
    const hit = asRow({ ...row(), seen: true, fromName: "" });
    expect(hit).toMatchObject({ count: 1, unread: 0, snoozedUntil: null, participants: ["ada@example.com"] });
  });
});
