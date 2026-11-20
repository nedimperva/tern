// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { Signature } from "../api";
import { fromText, toText } from "../editor/schema";
import { customSignatureDoc, findSignature, signatureBodyText, signaturePlace, withSignature } from "../signature";

const sig = (body: string, more: Partial<Signature> = {}): Signature => ({
  id: 1,
  accountId: 1,
  name: "Short",
  body,
  html: null,
  forNew: true,
  forReply: true,
  ...more,
});

describe("compose signature helpers", () => {
  it("wraps a per-email custom signature with the -- separator", () => {
    const doc = customSignatureDoc("Cheers,\nNedim (from Amsterdam)\n");
    expect(toText(doc)).toBe("-- \nCheers,\nNedim (from Amsterdam)");
  });

  it("reads the signature body back out of a document without the quote or -- line", () => {
    const start = withSignature("Thanks Ada!", "\n\nOn 1 Nov, Ada wrote:\n> See you there", sig("Best,\nNedim"), false);
    const doc = fromText(start.body);
    expect(signatureBodyText(doc)).toBe("Best,\nNedim");
    expect(findSignature(doc, sig("Best,\nNedim"))).not.toBeNull();
  });

  it("returns null when a document has no signature", () => {
    expect(signatureBodyText(fromText("Hello world"))).toBeNull();
  });

  it("places a new signature above the quote unless signatureBelow is set", () => {
    const doc = fromText("Thanks!\n\nOn 1 Nov, Ada wrote:\n\n> Hi");
    expect(signaturePlace(doc, false)).toBeLessThan(doc.content.size);
    expect(signaturePlace(doc, true)).toBe(doc.content.size);
  });
});
