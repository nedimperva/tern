import { describe, expect, it } from "vitest";
import { moonPath, moonPhase, skyAt } from "../sky";

describe("the moon", () => {
  it("is full on a known full moon and new on a known new moon", () => {
    expect(moonPhase(new Date(Date.UTC(2024, 0, 25, 17, 54)))).toBeCloseTo(0.5, 1);
    const fresh = moonPhase(new Date(Date.UTC(2024, 0, 11, 11, 57)));
    expect(Math.min(fresh, 1 - fresh)).toBeLessThan(0.02);
  });

  it("lights the right side while waxing and the left while waning", () => {
    expect(moonPath(0.1, 50, 50, 10)).toContain("A10 10 0 0 1 50 60");
    expect(moonPath(0.9, 50, 50, 10)).toContain("A10 10 0 0 0 50 60");
  });
});

describe("the sky", () => {
  it("follows the hour", () => {
    const at = (h: number) => skyAt(new Date(2026, 9, 29, h));
    expect([at(5), at(7), at(12), at(18), at(22)]).toEqual(["night", "dawn", "day", "dusk", "night"]);
  });
});
