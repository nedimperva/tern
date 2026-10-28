// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { isDesigned, withoutTrackers } from "../mailview";

describe("withoutTrackers", () => {
  it("takes a 1x1 pixel out and counts the pictures left", () => {
    const html = '<p>Hi</p><img src="https://t.example/open.gif" width="1" height="1"><img src="https://cdn.example/a.png">';
    const out = withoutTrackers(html);
    expect(out.trackers).toBe(1);
    expect(out.images).toBe(1);
    expect(out.html).not.toContain("open.gif");
  });
  it("asks for http pictures over https", () => {
    const out = withoutTrackers('<img src="http://cdn.example/a.png" width="200">');
    expect(out.html).toContain('src="https://cdn.example/a.png"');
  });
  it("leaves mail without remote content alone", () => {
    expect(withoutTrackers("<p>plain</p>")).toEqual({ html: "<p>plain</p>", trackers: 0, images: 0 });
  });
});

describe("isDesigned", () => {
  it("tells a laid-out newsletter from a typed message", () => {
    expect(isDesigned("<p>Thanks, see you Friday.</p>")).toBe(false);
  });
});
