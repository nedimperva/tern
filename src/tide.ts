// The tide report (Inbox Zero on Sundays): the week's mail by day, from when each message arrived (`arrivals`) and
// what was cleared in Tern (the Inbox Zero log). Plain functions, unit-tested in src/test/tide.test.ts.

export type DayLog = Record<string, { cleared: number; zero: boolean }>;

export type ReportDay = { name: string; came: number; cleared: number; zero: boolean; today: boolean };
export type Report = { days: ReportDay[]; came: number; cleared: number; zeroDays: number; quietest: ReportDay };

const key = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** The start of the report's first day, six days before today, as Unix seconds: what to ask `arrivals` from. */
export function weekStart(now: Date) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - 6);
  return Math.floor(d.getTime() / 1000);
}

/** The seven days ending today. The quietest is the day with the least mail, today aside (it isn't over); ties go
 * to the earlier day. */
export function weekReport(arrived: number[], log: DayLog, now: Date): Report {
  const days: (ReportDay & { key: string })[] = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(now);
    d.setHours(12, 0, 0, 0);
    d.setDate(d.getDate() - 6 + i);
    const k = key(d);
    return {
      key: k,
      name: d.toLocaleDateString(undefined, { weekday: "long" }),
      came: 0,
      cleared: log[k]?.cleared ?? 0,
      zero: !!log[k]?.zero,
      today: i === 6,
    };
  });
  const index = new Map(days.map((d, i) => [d.key, i]));
  for (const seconds of arrived) {
    const i = index.get(key(new Date(seconds * 1000)));
    if (i !== undefined) days[i].came++;
  }
  const quietest = days.slice(0, 6).reduce((q, d) => (d.came < q.came ? d : q), days[0]);
  return {
    days,
    came: days.reduce((n, d) => n + d.came, 0),
    cleared: days.reduce((n, d) => n + d.cleared, 0),
    zeroDays: days.filter((d) => d.zero).length,
    quietest,
  };
}
