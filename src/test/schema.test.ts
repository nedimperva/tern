// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { fromHtml, toHtml, toText } from "../editor/schema";

describe("pictures in the compose editor", () => {
  it("keeps a picture named by Content-ID and writes it out as such", () => {
    const doc = fromHtml('<p>Look:</p><p><img src="cid:a1@tern" alt="shot.png"></p>');
    expect(toHtml(doc)).toMatch(/<img src="cid:a1@tern" alt="shot.png" style="max-width: ?100%;?">/);
    expect(toText(doc)).toBe("Look:\n\n[shot.png]");
  });

  it("drops a picture from a web page, as other pasted styling", () => {
    const doc = fromHtml('<p>From the web <img src="https://tracker.example/p.gif"></p>');
    expect(toHtml(doc)).not.toContain("<img");
  });
});
