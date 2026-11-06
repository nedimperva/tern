import { describe, expect, it } from "vitest";
import { dayGroup, dayHeading } from "../listDays";

// Friday 6 Nov 2026, mid-afternoon, local time.
const now = new Date(2026, 10, 6, 15, 30).getTime();
const at = (y: number, m: number, d: number, h = 12) => ({ date: new Date(y, m, d, h).getTime() / 1000 });

describe("list day headings", () => {
  it("names today, yesterday, the week's days, then months", () => {
    expect(dayGroup(at(2026, 10, 6, 0), now)).toBe("Today");
    expect(dayGroup(at(2026, 10, 5, 23), now)).toBe("Yesterday");
    expect(dayGroup(at(2026, 10, 2), now)).toBe(new Intl.DateTimeFormat(undefined, { weekday: "long" }).format(new Date(2026, 10, 2)));
    expect(dayGroup(at(2026, 9, 20), now)).toBe(new Intl.DateTimeFormat(undefined, { month: "long" }).format(new Date(2026, 9, 20)));
    expect(dayGroup(at(2025, 11, 20), now)).toContain("2025");
  });

  it("gives a heading only where the group changes", () => {
    const a = at(2026, 10, 6, 14);
    const b = at(2026, 10, 6, 9);
    const c = at(2026, 10, 5, 9);
    expect(dayHeading(a, undefined, now)).toBe("Today");
    expect(dayHeading(b, a, now)).toBeNull();
    expect(dayHeading(c, b, now)).toBe("Yesterday");
  });

  it("keeps pinned follow-ups under their own heading", () => {
    const pinned = { ...at(2026, 9, 1), followUp: true };
    expect(dayHeading(pinned, undefined, now)).toBe("Follow-ups");
    expect(dayHeading(at(2026, 10, 6), pinned, now)).toBe("Today");
  });
});
