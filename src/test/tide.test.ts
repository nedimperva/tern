import { describe, expect, it } from "vitest";
import { weekReport, weekStart } from "../tide";

const at = (y: number, m: number, d: number, h = 10) => Math.floor(new Date(y, m - 1, d, h).getTime() / 1000);

describe("the tide report", () => {
  const sunday = new Date(2026, 10, 1, 9);

  it("counts the seven days ending today", () => {
    const arrived = [at(2026, 10, 26), at(2026, 10, 26, 15), at(2026, 10, 27), at(2026, 11, 1), at(2026, 10, 25)];
    const log = { "2026-10-26": { cleared: 4, zero: true }, "2026-10-30": { cleared: 2, zero: false } };
    const r = weekReport(arrived, log, sunday);
    expect(r.days.map((d) => d.came)).toEqual([2, 1, 0, 0, 0, 0, 1]);
    expect(r.came).toBe(4);
    expect(r.cleared).toBe(6);
    expect(r.zeroDays).toBe(1);
    expect(r.days[6].today).toBe(true);
  });

  it("names the earliest of the quietest days", () => {
    const r = weekReport([at(2026, 10, 26), at(2026, 10, 27)], {}, sunday);
    expect(r.quietest).toBe(r.days[2]);
  });

  it("asks from midnight six days back", () => {
    expect(new Date(weekStart(sunday) * 1000).getDate()).toBe(26);
  });
});
