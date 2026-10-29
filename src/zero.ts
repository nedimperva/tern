// Inbox Zero: which scene shows today, and what the scenes count. The log is kept with the settings, on this
// computer only, so mail cleared in another app or on the phone isn't in it.

import { setSetting, settings } from "./settings";

export type SceneId =
  | "pole"
  | "flock"
  | "summers"
  | "moon"
  | "streak"
  | "horizon"
  | "colony"
  | "migration"
  | "dive"
  | "seasons"
  | "night"
  | "report";

/** The rotation, in order; one a day. Night shift takes over late in the evening instead of having a day. */
export const SCENES: { id: SceneId; name: string }[] = [
  { id: "pole", name: "Pole to pole" },
  { id: "flock", name: "Flock" },
  { id: "summers", name: "Two summers" },
  { id: "moon", name: "To the Moon and back" },
  { id: "streak", name: "Streak" },
  { id: "horizon", name: "Horizon" },
  { id: "colony", name: "Colony" },
  { id: "migration", name: "Your migration" },
  { id: "dive", name: "The dive" },
  { id: "seasons", name: "Seasons" },
];
export const NIGHT_SHIFT = { id: "night" as const, name: "Night shift" };
/** The week in mail; it takes Sundays instead of the rotation. */
export const TIDE_REPORT = { id: "report" as const, name: "The tide report" };

/** Days since 1 January 1970 in local time: the same scene all day, the next one tomorrow. */
export function localDay(now: Date) {
  return Math.floor((now.getTime() - now.getTimezoneOffset() * 60_000) / 86_400_000);
}

export function dayOfYear(now: Date) {
  return Math.floor((now.getTime() - new Date(now.getFullYear(), 0, 0).getTime()) / 86_400_000);
}

/** Late evening and the small hours. */
export const lateNight = (now: Date) => now.getHours() >= 22 || now.getHours() < 5;

/** Today's scene. A rotation through ten never shows one two days running. */
export function sceneFor(now: Date): SceneId {
  const pick = settings.zeroScene;
  if (pick === NIGHT_SHIFT.id || pick === TIDE_REPORT.id || SCENES.some((s) => s.id === pick)) return pick as SceneId;
  if (lateNight(now)) return "night";
  if (now.getDay() === 0) return "report";
  return SCENES[localDay(now) % SCENES.length].id;
}

const key = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

function update(change: (day: { cleared: number; zero: boolean }) => { cleared: number; zero: boolean }) {
  const today = key(new Date());
  const log = { ...settings.zeroLog };
  log[today] = change(log[today] ?? { cleared: 0, zero: false });
  // A bit over a year: the year's total and the week are all that is read.
  const keys = Object.keys(log).sort();
  for (const old of keys.slice(0, Math.max(0, keys.length - 400))) delete log[old];
  setSetting("zeroLog", log);
}

/** Conversations taken out of the inbox (archived, deleted, moved); an undo takes them off again. */
export function countCleared(n: number) {
  if (n) update((d) => ({ ...d, cleared: Math.max(0, d.cleared + n) }));
}

/** The inbox is empty now: today counts towards the streak. */
export function markZero() {
  if (!settings.zeroLog[key(new Date())]?.zero) update((d) => ({ ...d, zero: true }));
}

export const clearedToday = () => settings.zeroLog[key(new Date())]?.cleared ?? 0;

export function clearedThisYear() {
  const year = `${new Date().getFullYear()}-`;
  return Object.entries(settings.zeroLog).reduce((n, [k, d]) => (k.startsWith(year) ? n + d.cleared : n), 0);
}

/** Days in a row with Inbox Zero, ending today. */
export function streak() {
  let n = 0;
  const d = new Date();
  while (settings.zeroLog[key(d)]?.zero) {
    n++;
    d.setDate(d.getDate() - 1);
  }
  return Math.max(1, n);
}

/** This week, Monday first: which days reached zero, which didn't, which are still to come. */
export function thisWeek(now: Date) {
  const monday = new Date(now);
  monday.setDate(now.getDate() - ((now.getDay() + 6) % 7));
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    const isToday = key(d) === key(now);
    const future = d > now && !isToday;
    const done = !future && (isToday || !!settings.zeroLog[key(d)]?.zero);
    return { name: d.toLocaleDateString(undefined, { weekday: "short" }), done, future, isToday };
  });
}

