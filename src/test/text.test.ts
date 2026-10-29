// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { mentionsAttachment, outside } from "../attachmentWords";
import { findAsks, findCodes, findWhere } from "../facts";
import { foldAt, markQuotes } from "../fold";
import { keyLabel } from "../keys";

describe("foldAt", () => {
  it("folds a quoted reply from its header line", () => {
    const text = "Sounds good.\n\nOn Mon, 3 Mar 2025, Ana wrote:\n> Lunch?";
    expect(text.slice(0, foldAt(text))).toBe("Sounds good.");
  });
  it("folds a signature after '-- '", () => {
    const text = "See you.\n-- \nAda";
    expect(text.slice(0, foldAt(text))).toBe("See you.");
  });
  it("finds nothing in a plain message", () => {
    expect(foldAt("Just a note.\nNothing quoted.")).toBe(-1);
  });
});

describe("facts", () => {
  it("finds asks put to the person", () => {
    expect(findAsks("Hi. Can you bring the Q3 deck? Thanks.")).toEqual(["Can you bring the Q3 deck?"]);
  });
  it("finds codes, not years", () => {
    expect(findCodes("Your booking code is QX7-44K, made in 2026.")).toEqual([{ label: "Booking", value: "QX7-44K" }]);
  });
  it("finds a street address", () => {
    expect(findWhere("We meet at Studio 4, Keizersgracht 120, Amsterdam. Lunch is on us.")).toBe(
      "Keizersgracht 120, Amsterdam",
    );
  });
});

describe("attachments", () => {
  it("hears 'attached' with or without accents", () => {
    expect(mentionsAttachment("Prilazem ugovor", ["prilažem"])).toBe("prilažem");
    expect(mentionsAttachment("Nothing here", ["attached"])).toBeNull();
  });
  it("calls an address outside only for an organisation's own domain", () => {
    expect(outside("bob@other.com", "ana@firm.com")).toBe(true);
    expect(outside("bob@firm.com", "ana@firm.com")).toBe(false);
    expect(outside("bob@other.com", "ana@gmail.com")).toBe(false);
  });
});

describe("keyLabel", () => {
  it("spells keys as on a keycap", () => {
    expect(keyLabel("g i")).toBe("G then I");
    expect(keyLabel("U")).toBe("Shift U");
    expect(keyLabel("Ctrl+k")).toBe("Ctrl K");
    expect(keyLabel("Escape")).toBe("Esc");
  });
});

describe("markQuotes", () => {
  const doc = (html: string) => new DOMParser().parseFromString(html, "text/html");
  const marked = (d: Document) => [...d.querySelectorAll(".tern-quote")].map((e) => e.textContent?.slice(0, 12));

  it("folds a plain quote after its wrote line, and a signature with what follows", () => {
    const d = doc(
      `<p>Plaćeno.</p><p>--</p><p>S poštovanjem, Nedim</p><p>On Oct 27, 2026, Nedim wrote:</p><blockquote><p>Molim vas</p><blockquote><p>older</p></blockquote></blockquote>`,
    );
    markQuotes(d);
    expect(marked(d)).toEqual(["--", "S poštovanje", "On Oct 27, 2", "Molim vasold"]);
    expect(d.querySelector("p")?.classList.contains("tern-quote")).toBe(false);
  });

  it("leaves a quote without a wrote line, and a message that is only a signature", () => {
    const d = doc(`<p>--</p><p>Ana</p><blockquote><p>a cited line</p></blockquote>`);
    markQuotes(d);
    expect(marked(d)).toEqual([]);
  });
});
