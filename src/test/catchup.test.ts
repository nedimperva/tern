import { describe, expect, it } from "vitest";
import { asks, catchUp } from "../catchup";

const m = (id: number, bodyText: string, fromAddr = "ana@x.com") => ({ id, fromAddr, bodyText, snippet: "" });

describe("coming back to a conversation", () => {
  it("hears a question in the message's own words, not in its quote or links", () => {
    expect(asks("Can you confirm the totals by Thursday?\n\nThanks")).toBe(true);
    expect(asks("Done.\n\nOn Tue, Ana wrote:\n> Can you confirm?")).toBe(false);
    expect(asks("See https://x.com/a?b=1 for it.")).toBe(false);
  });

  it("counts what is new and what asks, only on a return", () => {
    const thread = [m(1, "Hi"), m(2, "Any news?"), m(3, "Sure?", "me@x.com")];
    const mine = (a: string) => a === "me@x.com";
    expect(catchUp(thread, new Set([2, 3]), mine)).toEqual({ count: 2, questions: 1, first: 2 });
    expect(catchUp(thread, new Set([1, 2, 3]), mine)).toBeNull();
    expect(catchUp(thread, new Set(), mine)).toBeNull();
  });
});
