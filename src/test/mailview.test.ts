// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { designedFrame, fitFrame, isDesigned, withoutTrackers } from "../mailview";

describe("withoutTrackers", () => {
  it("takes a 1x1 pixel out and counts the pictures left", () => {
    const html = '<p>Hi</p><img src="https://t.example/open.gif" width="1" height="1"><img src="https://cdn.example/a.png">';
    const out = withoutTrackers(html);
    expect(out.trackers).toBe(1);
    expect(out.images).toBe(1);
    expect(out.html).not.toContain("open.gif");
  });
  it("asks for http pictures over https and drops loading=lazy so long newsletters size fully", () => {
    const out = withoutTrackers('<img src="http://cdn.example/a.png" width="200" loading="lazy">');
    expect(out.html).toContain('src="https://cdn.example/a.png"');
    expect(out.html).not.toContain('loading="lazy"');
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

describe("fitFrame", () => {
  it("keeps our height:auto guard after newsletter styles and uses scrollHeight when body rect is shorter", () => {
    const html = "<style>html,body{height:100%!important}</style><p>Long newsletter</p>";
    const out = designedFrame(html, true);
    expect(out.lastIndexOf("height:auto!important")).toBeGreaterThan(out.indexOf("height:100%!important"));

    const doc = document.implementation.createHTMLDocument("mail");
    doc.body.innerHTML = "<p>Long newsletter</p>";
    Object.defineProperty(doc.documentElement, "clientWidth", { value: 680, configurable: true });
    Object.defineProperty(doc.documentElement, "scrollWidth", { value: 680, configurable: true });
    Object.defineProperty(doc.body, "scrollWidth", { value: 680, configurable: true });
    Object.defineProperty(doc.body, "scrollHeight", { value: 4200, configurable: true });
    doc.body.getBoundingClientRect = () => ({ height: 150 }) as DOMRect;
    const frame = document.createElement("iframe");
    fitFrame(frame, doc);
    expect(frame.style.height).toBe("4200px");
    expect(doc.body.style.getPropertyValue("height")).toBe("auto");
    expect(doc.body.style.getPropertyPriority("height")).toBe("important");
  });
});
