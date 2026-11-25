// The mail-date filter of the Files and Paper trail screens: a few named spans, days picked on a calendar, or the
// weeks around a mail. Plain functions over local time, unit-tested in src/test/dateRange.test.ts.

export type Preset = "any" | "today" | "week" | "month" | "3months" | "12months" | "year" | "lastyear";
export type DateRange =
  | { kind: Preset }
  /** Whole days, as local dates "YYYY-MM-DD", both ends kept. */
  | { kind: "days"; from: string; to: string }
  /** Two weeks either side of a mail's date (seconds). */
  | { kind: "around"; at: number };

export const PRESETS: { kind: Preset; label: string }[] = [
  { kind: "any", label: "Any time" },
  { kind: "today", label: "Today" },
  { kind: "week", label: "This week" },
  { kind: "month", label: "This month" },
  { kind: "3months", label: "Last 3 months" },
  { kind: "12months", label: "Last 12 months" },
  { kind: "year", label: "This year" },
  { kind: "lastyear", label: "Last year" },
];

const AROUND_DAYS = 14;
/** Far enough past any mail's date, and still a whole number the engine reads as an i64. */
const NEVER = 4_102_444_800; // 2100-01-01

const seconds = (d: Date) => Math.floor(d.getTime() / 1000);
const dayStart = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
/** "2026-11-02" as local midnight. */
export const parseDay = (s: string) => {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
};
/** Local midnight as "2026-11-02". */
export const dayKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** The span in seconds, `since` kept and `until` left out. */
export function span(r: DateRange, now = new Date()): { since: number; until: number } {
  const today = dayStart(now);
  switch (r.kind) {
    case "any":
      return { since: 0, until: NEVER };
    case "today":
      return { since: seconds(today), until: NEVER };
    case "week": {
      // Weeks start on Monday.
      const back = (today.getDay() + 6) % 7;
      return { since: seconds(new Date(today.getFullYear(), today.getMonth(), today.getDate() - back)), until: NEVER };
    }
    case "month":
      return { since: seconds(new Date(today.getFullYear(), today.getMonth(), 1)), until: NEVER };
    case "3months":
      return { since: seconds(new Date(today.getFullYear(), today.getMonth() - 3, today.getDate())), until: NEVER };
    case "12months":
      return { since: seconds(new Date(today.getFullYear(), today.getMonth() - 11, 1)), until: NEVER };
    case "year":
      return { since: seconds(new Date(today.getFullYear(), 0, 1)), until: NEVER };
    case "lastyear":
      return { since: seconds(new Date(today.getFullYear() - 1, 0, 1)), until: seconds(new Date(today.getFullYear(), 0, 1)) };
    case "days": {
      const [a, b] = [parseDay(r.from), parseDay(r.to)].sort((x, y) => x.getTime() - y.getTime());
      return { since: seconds(a), until: seconds(new Date(b.getFullYear(), b.getMonth(), b.getDate() + 1)) };
    }
    case "around": {
      const at = dayStart(new Date(r.at * 1000));
      return {
        since: seconds(new Date(at.getFullYear(), at.getMonth(), at.getDate() - AROUND_DAYS)),
        until: seconds(new Date(at.getFullYear(), at.getMonth(), at.getDate() + AROUND_DAYS + 1)),
      };
    }
  }
}

const short = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });
const shortYear = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" });

/** What the chip says: "Last 3 months", "2 Nov – 15 Nov", "Around 21 Nov". */
export function rangeLabel(r: DateRange, now = new Date()): string {
  if (r.kind === "days") {
    const [a, b] = [parseDay(r.from), parseDay(r.to)].sort((x, y) => x.getTime() - y.getTime());
    const f = a.getFullYear() === now.getFullYear() && b.getFullYear() === now.getFullYear() ? short : shortYear;
    return a.getTime() === b.getTime() ? f.format(a) : `${f.format(a)} – ${f.format(b)}`;
  }
  if (r.kind === "around") return `Around ${short.format(new Date(r.at * 1000))}`;
  return PRESETS.find((p) => p.kind === r.kind)?.label ?? "Any time";
}

/** The weeks of a month for a calendar, Monday first: each cell a local date, or null before the 1st. */
export function monthGrid(year: number, month: number): (Date | null)[][] {
  const first = new Date(year, month, 1);
  const lead = (first.getDay() + 6) % 7;
  const days = new Date(year, month + 1, 0).getDate();
  const cells: (Date | null)[] = [...Array(lead).fill(null), ...Array.from({ length: days }, (_, i) => new Date(year, month, i + 1))];
  const weeks: (Date | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}
