// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { Signature } from "../api";
import { codeAsHtml, htmlSource } from "../htmlSignature";

const sig = (body: string, more: Partial<Signature> = {}): Signature => ({
  id: 1,
  accountId: 1,
  name: "Work",
  body,
  html: null,
  forNew: true,
  forReply: true,
  ...more,
});

const table = `<table cellpadding="0" style="font-family:Arial">\n\n<tr>\n<td><b>Nedim Perva</b><br>Officer</td>\n</tr>\n</table>\n`;

describe("htmlSource", () => {
  it("knows HTML code from a generator", () => {
    expect(htmlSource(`\n${table}`)).toBe(table.trim());
    expect(htmlSource('<div style="color:#333">Ada<br>Engines</div>')).not.toBeNull();
  });

  it("leaves words alone, even with a bracket in them", () => {
    expect(htmlSource("Ada Lovelace\nAnalytical Engines Ltd")).toBeNull();
    expect(htmlSource("Ada <ada@example.com>")).toBeNull();
    expect(htmlSource("<3 Ada")).toBeNull();
    expect(htmlSource("<table> is where we meet")).toBeNull();
  });
});

describe("codeAsHtml", () => {
  it("makes a signature written as code an HTML one, with a text version", () => {
    const out = codeAsHtml(sig(table));
    expect(out.custom).toBe(true);
    expect(out.html).toBe(table.trim());
    expect(out.body).toBe("Nedim Perva\nOfficer");
  });

  it("keeps signatures that are words or already have formatting", () => {
    const words = sig("Ada");
    expect(codeAsHtml(words)).toBe(words);
    const formatted = sig("Ada", { html: "<p><b>Ada</b></p>" });
    expect(codeAsHtml(formatted)).toBe(formatted);
    const pasted = sig("Ada", { html: table, custom: true });
    expect(codeAsHtml(pasted)).toBe(pasted);
  });
});
