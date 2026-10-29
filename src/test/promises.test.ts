// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { dueIn, promisesIn } from "../promises";

const at = Math.floor(new Date(2026, 9, 26, 10).getTime() / 1000);
const m = (id: number, fromAddr: string, fromName: string, bodyText: string) => ({ id, fromAddr, fromName, bodyText, snippet: "", date: at });
const mine = (a: string) => a === "me@x.com";

describe("promises in a conversation", () => {
  const thread = [
    m(1, "ana@x.com", "Ana Rossi", "Hi,\n\nCan you confirm the EU totals by Thursday?\n\nI will send the board pack on Friday.\n\nAna"),
    m(2, "me@x.com", "Me", "Sure. I'll check the numbers tomorrow morning.\n\nOn Mon, Ana wrote:\n> Can you confirm the EU totals?"),
  ];
  const found = promisesIn(thread, mine);

  it("splits what you owe from what is owed to you", () => {
    expect(found.filter((p) => p.yours).map((p) => [p.who, p.text])).toEqual([
      ["Ana", "Can you confirm the EU totals by Thursday?"],
      ["You", "I'll check the numbers tomorrow morning."],
    ]);
    expect(found.filter((p) => !p.yours).map((p) => [p.who, p.text])).toEqual([["Ana", "I will send the board pack on Friday."]]);
  });

  it("reads the day it is due and leaves quotes alone", () => {
    // Sent on Monday 26 October: "by Thursday" is the 29th, "on Friday" the 30th, "tomorrow" the 27th.
    expect(new Date(found[0].due! * 1000).getDate()).toBe(29);
    expect(new Date(found[1].due! * 1000).getDate()).toBe(30);
    expect(new Date(found[2].due! * 1000).getDate()).toBe(27);
    expect(dueIn("Whenever suits you.", at)).toBeNull();
    expect(found).toHaveLength(3);
    expect(new Set(found.map((p) => p.key)).size).toBe(3);
  });
});
