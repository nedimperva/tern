import { describe, expect, it } from "vitest";
import { filesOf, middleCut } from "../files";

describe("a message's files", () => {
  it("leaves out the pictures its HTML shows, keeping each file's index", () => {
    const m = {
      bodyHtml: '<p>Hi</p><img src="cid:image002.jpg@01DD5657.62C60130">',
      attachments: [
        { name: "image002.jpg", mime: "image/jpeg", size: 3122 },
        { name: "TROŠKOVI.pdf", mime: "application/pdf", size: 105924 },
        { name: "photo.jpg", mime: "image/jpeg", size: 900000 },
      ],
    };
    expect(filesOf(m).map((f) => [f.file.name, f.index])).toEqual([
      ["TROŠKOVI.pdf", 1],
      ["photo.jpg", 2],
    ]);
  });
});

describe("middleCut", () => {
  it("keeps short names whole", () => {
    expect(middleCut("Budget.xlsx")).toBe("Budget.xlsx");
  });
  it("keeps the end and the extension of a long name", () => {
    const cut = middleCut("Q3 offer for Analytical Engines - final v2.pdf", 32);
    expect(cut.length).toBeLessThanOrEqual(32);
    expect(cut.endsWith("final v2.pdf")).toBe(true);
    expect(cut).toContain("…");
  });
});
