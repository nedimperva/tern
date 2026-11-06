// The quiet headings in a list sorted by date (canvas "Tern polish, now and after", 10): the thread's Today and
// Yesterday, then the weekday for the rest of the week, then the month. Older mail would otherwise give a heading
// for every day.

type Dated = { date: number; followUp?: boolean };

const weekday = new Intl.DateTimeFormat(undefined, { weekday: "long" });
const month = new Intl.DateTimeFormat(undefined, { month: "long" });
const monthYear = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" });

const startOfDay = (ms: number) => new Date(ms).setHours(0, 0, 0, 0);

/** Which group a row falls in, as a number, so a long list compares rows without formatting dates. */
function groupKey(row: Dated, today: number): number {
  if (row.followUp) return -1;
  const ms = row.date * 1000;
  const days = Math.round((today - startOfDay(ms)) / 86_400_000);
  if (days <= 0) return 0;
  if (days < 7) return days;
  const d = new Date(ms);
  return 100 + d.getFullYear() * 12 + d.getMonth();
}

/** The heading a row falls under, at `now` (ms). */
export function dayGroup(row: Dated, now = Date.now()): string {
  const key = groupKey(row, startOfDay(now));
  if (key === -1) return "Follow-ups";
  if (key === 0) return "Today";
  if (key === 1) return "Yesterday";
  const d = new Date(row.date * 1000);
  if (key < 7) return weekday.format(d);
  return d.getFullYear() === new Date(now).getFullYear() ? month.format(d) : monthYear.format(d);
}

/** A heading over `row` when it starts a new group, else null. */
export function dayHeading(row: Dated, above: Dated | undefined, now = Date.now()): string | null {
  const today = startOfDay(now);
  if (above && groupKey(above, today) === groupKey(row, today)) return null;
  return dayGroup(row, now);
}
