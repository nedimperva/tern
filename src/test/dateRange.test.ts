// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { monthGrid, rangeLabel, span } from "../dateRange";
import { repeating, sums } from "../paper";

const at = (y: number, m: number, d: number, h = 0) => new Date(y, m - 1, d, h);
const s = (d: Date) => Math.floor(d.getTime() / 1000);

describe("mail-date filter", () => {
  // Saturday 21 November 2026, mid-afternoon.
  const now = at(2026, 11, 21, 15);

  it("starts the week on Monday and the month on the 1st", () => {
    expect(span({ kind: "week" }, now).since).toBe(s(at(2026, 11, 16)));
    expect(span({ kind: "month" }, now).since).toBe(s(at(2026, 11, 1)));
    expect(span({ kind: "today" }, now).since).toBe(s(at(2026, 11, 21)));
  });

  it("gives last year as a closed span and twelve months from a month's start", () => {
    expect(span({ kind: "lastyear" }, now)).toEqual({ since: s(at(2025, 1, 1)), until: s(at(2026, 1, 1)) });
    expect(span({ kind: "12months" }, now).since).toBe(s(at(2025, 12, 1)));
  });

  it("keeps both picked days, in either order", () => {
    const r = span({ kind: "days", from: "2026-11-15", to: "2026-11-02" }, now);
    expect(r).toEqual({ since: s(at(2026, 11, 2)), until: s(at(2026, 11, 16)) });
    expect(rangeLabel({ kind: "days", from: "2026-11-02", to: "2026-11-02" }, now)).not.toContain("–");
  });

  it("takes two weeks either side of a mail", () => {
    const r = span({ kind: "around", at: s(at(2026, 11, 21, 9)) }, now);
    expect(r).toEqual({ since: s(at(2026, 11, 7)), until: s(at(2026, 12, 6)) });
  });

  it("lays a month out Monday first", () => {
    const weeks = monthGrid(2026, 10); // November 2026 starts on a Sunday.
    expect(weeks[0].slice(0, 6)).toEqual([null, null, null, null, null, null]);
    expect(weeks[0][6]?.getDate()).toBe(1);
    expect(weeks.flat().filter(Boolean)).toHaveLength(30);
  });
});

describe("paper sums and repeats", () => {
  it("adds each currency apart", () => {
    const p = (amount: number, currency: string) => ({ paper: { kind: "Receipt" as const, amount, currency, reference: null } });
    expect(sums([p(10, "EUR"), p(5, "USD"), p(2.5, "EUR")])).toEqual([["EUR", 12.5], ["USD", 5]]);
  });

  it("calls a sender repeating after three different months", () => {
    const d = (m: number, day = 1) => s(at(2026, m, day));
    const r = repeating([
      { from: "Cloud Host", date: d(9) },
      { from: "Cloud Host", date: d(10) },
      { from: "Cloud Host", date: d(11) },
      { from: "Bookshop", date: d(11, 2) },
      { from: "Bookshop", date: d(11, 20) },
      { from: "Bookshop", date: d(10) },
    ]);
    expect([...r]).toEqual(["Cloud Host"]);
  });
});
