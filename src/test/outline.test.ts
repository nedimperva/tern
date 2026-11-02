// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { partsOf, signatureRange } from "../editor/outline";
import { fromText } from "../editor/schema";

const labels = (text: string, sig = "") => partsOf(fromText(text), sig).map((p) => p.label);

describe("outline", () => {
  it("lists the person's own paragraphs, not the signature after the -- line", () => {
    expect(labels("Hi both,\n\nThe numbers are in.\n\n-- \nAda Lovelace")).toEqual(["Hi both,", "The numbers are in."]);
  });

  it("drops a trailing signature that matches the saved one, even without the -- line", () => {
    expect(labels("Hello there.\n\nAda Lovelace\nAnalytical Engines", "Ada Lovelace\nAnalytical Engines")).toEqual(["Hello there."]);
  });

  it("marks the greeting, short title lines and the parts that ask", () => {
    const parts = partsOf(fromText("Hi Ada,\n\nWhere Q3 landed\n\nRevenue was up.\n\nCould you send the deck by Friday?"), "");
    expect(parts.map((p) => [p.greeting, p.heading, p.ask])).toEqual([
      [true, false, false],
      [false, true, false],
      [false, false, false],
      [false, false, true],
    ]);
  });

  it("finds asking in Bosnian with letters like š at the edges", () => {
    expect(partsOf(fromText("Možeš li poslati izvještaj danas."), "")[0].ask).toBe(true);
  });

  it("shortens a long paragraph to its first words", () => {
    expect(labels("one two three four five six seven eight nine.")).toEqual(["one two three four five six seven…"]);
  });
});

describe("signature range", () => {
  it("runs from the -- line to the quote, leaving the 'wrote:' line to the quote, and names the sender", () => {
    const doc = fromText("Thanks!\n\n-- \nBest,\nAda Lovelace\nExample Ltd\n\nOn 1 Nov, Grace wrote:\n\n> Hi");
    const r = signatureRange(doc);
    expect(r?.name).toBe("Ada Lovelace");
    expect(doc.textBetween(r!.from, r!.to, "\n", "\n")).not.toContain("wrote:");
    expect(doc.textBetween(r!.from, r!.to, "\n", "\n")).toContain("Example Ltd");
  });

  it("is null without a -- line", () => {
    expect(signatureRange(fromText("Just text.\n\nAda"))).toBeNull();
  });
});
