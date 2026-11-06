import { describe, expect, it } from "vitest";
import { quotedName } from "../quote";

describe("quotedName", () => {
  it("takes the name before the address", () => {
    expect(quotedName("On Nov 6, 2026, 9:47 PM, Ada Lovelace <ada@example.com> wrote:")).toBe("Ada Lovelace");
  });
  it("takes the address when there is no name", () => {
    expect(quotedName("On Nov 6, 2026, 9:47 PM, <ada@example.com> wrote:")).toBe("ada@example.com");
  });
  it("takes a bare name", () => {
    expect(quotedName("On Mon, Grace Hopper wrote:")).toBe("Grace Hopper");
  });
});
