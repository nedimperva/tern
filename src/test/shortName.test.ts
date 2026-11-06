import { describe, expect, it } from "vitest";
import { shortName } from "../keys";

describe("shortName", () => {
  it("drops what a name explains in brackets or after a colon", () => {
    expect(shortName("Done (archive)")).toBe("Done");
    expect(shortName("Read later (on the shelf: back to the inbox)")).toBe("Read later");
    expect(shortName("Start of the day: what waits on you")).toBe("Start of the day");
  });
  it("keeps a name with nothing to drop", () => {
    expect(shortName("Move to …")).toBe("Move to …");
    expect(shortName("Snooze")).toBe("Snooze");
  });
});
