import { describe, expect, it } from "vitest";
import { wordDiff } from "../wordDiff";

describe("word diff", () => {
  it("marks what was taken out and what was put in", () => {
    const d = wordDiff("I think we could maybe meet on Friday.", "We should meet on Friday.")!;
    expect(d.filter((p) => p.kind === "added").map((p) => p.text.trim())).toEqual(["We should"]);
    expect(d.filter((p) => p.kind === "removed").map((p) => p.text.trim())).toEqual(["I think we could maybe"]);
    expect(d.map((p) => (p.kind === "removed" ? "" : p.text)).join("")).toBe("We should meet on Friday.");
  });

  it("leaves equal text alone", () => {
    expect(wordDiff("Same words.", "Same words.")).toEqual([{ text: "Same words.", kind: "same" }]);
  });
});
