import { describe, expect, it } from "vitest";
import { hitWords, litPieces } from "../hits";

describe("hitWords", () => {
  it("keeps words and phrases, drops filters, left-out words and OR", () => {
    expect(hitWords('invoice from:ada "quarterly report" -paid lunch OR dinner is:unread a')).toEqual([
      "invoice",
      "quarterly report",
      "lunch",
      "dinner",
    ]);
  });
});

describe("litPieces", () => {
  it("marks where a word starts, any case", () => {
    expect(litPieces("Invoice for the invoices", ["inv"])).toEqual([{ hit: "Inv" }, "oice for the ", { hit: "inv" }, "oices"]);
  });
  it("does not mark inside a word", () => {
    expect(litPieces("brainvoice", ["inv"])).toEqual(["brainvoice"]);
  });
  it("leaves the text whole with nothing to look for", () => {
    expect(litPieces("text", [])).toEqual(["text"]);
  });
  it("takes words with regex characters literally", () => {
    expect(litPieces("c++ and c", ["c++"])).toEqual([{ hit: "c++" }, " and c"]);
  });
});
