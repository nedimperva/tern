import { ACTION_WORDS } from "./mailview";

// What a message holds, for the column beside it (docs/design/ui.md §4.2a): when, where, what it asks of the
// person, codes to copy and its links. Found on this computer from the message's own words; nothing is sent.
// English and Bosnian/Croatian/Serbian words, as that is the mail Tern sees most; anything not found is left out.

export type When = { at: number; end: number | null; allDay: boolean };
export type Code = { label: string; value: string };
export type Link = { text: string; href: string; host: string };
export type Facts = { when: When | null; where: string | null; asks: string[]; codes: Code[]; links: Link[] };

const MONTHS: [RegExp, number][] = [
  [/^jan/, 0], [/^feb/, 1], [/^mar/, 2], [/^apr/, 3], [/^ma[yj]/, 4], [/^jun/, 5],
  [/^jul/, 6], [/^(aug|avg)/, 7], [/^sep/, 8], [/^o[ck]t/, 9], [/^nov/, 10], [/^dec/, 11],
];
const MONTH = "(jan|feb|mar|apr|ma[yj]|jun|jul|aug|avg|sep|o[ck]t|nov|dec)[a-zčćšžđ]*\\.?";
const DAY_MONTH = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\.?\\s+(?:of\\s+)?${MONTH}(?:,?\\s+(\\d{4}))?`, "giu");
const MONTH_DAY = new RegExp(`\\b${MONTH}\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s+(\\d{4}))?`, "giu");
const NUMERIC = /\b(\d{1,2})\.\s?(\d{1,2})\.\s?(\d{4})\b/g;
const WEEKDAY = /\b(?:next\s+|on\s+|u\s+|ovaj\s+|ove\s+|iduć[ia]\s+|sljedeć[ia]\s+)?(mon|tue|wed|thu|fri|sat|sun|ponedjelj|utor|srijed|četvrt|petak|petk|subot|nedjelj)[a-zčćšžđ]*/giu;
const WEEKDAYS: [RegExp, number][] = [
  [/^(sun|nedjelj)/, 0], [/^(mon|ponedjelj)/, 1], [/^(tue|utor)/, 2], [/^(wed|srijed)/, 3],
  [/^(thu|četvrt)/, 4], [/^(fri|pet)/, 5], [/^(sat|subot)/, 6],
];
// "14:30", "14.30", "3pm"; not the "20.10" of a date like 20.10.2026.
const TIME = /(?<![\d.])([01]?\d|2[0-3])[:.]([0-5]\d)(?!\d|\.\d)(?:\s*(am|pm))?|\b(1[0-2]|[1-9])\s?(am|pm)\b/gi;
const RANGE = /^\s*(?:-|–|—|to|until|till|do|in)?\s*$/i;

function monthOf(word: string): number {
  return MONTHS.find(([re]) => re.test(word.toLowerCase()))?.[1] ?? -1;
}

/** A day with no year said: this year's, or next year's when this year's is long gone. */
function dayFrom(year: number | null, month: number, day: number, sent: Date): Date | null {
  if (month < 0 || day < 1 || day > 31) return null;
  if (year) return new Date(year, month, day);
  const d = new Date(sent.getFullYear(), month, day);
  if (d.getTime() < sent.getTime() - 60 * 86_400_000) d.setFullYear(d.getFullYear() + 1);
  return d;
}

type Found = { date: Date; index: number; end: number };

function findDay(text: string, sent: Date): Found | null {
  const found: Found[] = [];
  for (const m of text.matchAll(DAY_MONTH)) {
    const d = dayFrom(m[3] ? Number(m[3]) : null, monthOf(m[2]), Number(m[1]), sent);
    if (d) found.push({ date: d, index: m.index!, end: m.index! + m[0].length });
  }
  for (const m of text.matchAll(MONTH_DAY)) {
    const d = dayFrom(m[3] ? Number(m[3]) : null, monthOf(m[1]), Number(m[2]), sent);
    if (d) found.push({ date: d, index: m.index!, end: m.index! + m[0].length });
  }
  for (const m of text.matchAll(NUMERIC)) {
    const d = dayFrom(Number(m[3]), Number(m[2]) - 1, Number(m[1]), sent);
    if (d) found.push({ date: d, index: m.index!, end: m.index! + m[0].length });
  }
  found.sort((a, b) => a.index - b.index);
  return found.find((f) => f.date.getTime() >= startOf(sent) - 86_400_000) ?? null;
}

/** "Thursday at 14:00": the next such day after the mail was sent, only with a time beside it. */
function findWeekday(text: string, sent: Date): Found | null {
  for (const m of text.matchAll(WEEKDAY)) {
    const day = WEEKDAYS.find(([re]) => re.test(m[1].toLowerCase()))?.[1];
    if (day === undefined) continue;
    const after = text.slice(m.index! + m[0].length, m.index! + m[0].length + 24);
    if (!new RegExp(TIME.source, "i").test(after)) continue;
    const d = new Date(startOf(sent));
    d.setDate(d.getDate() + ((day - d.getDay() + 7) % 7 || 7));
    return { date: d, index: m.index!, end: m.index! + m[0].length };
  }
  return null;
}

function startOf(d: Date): number {
  return new Date(d).setHours(0, 0, 0, 0);
}

function minutesOf(m: RegExpMatchArray): number {
  let h = Number(m[1] ?? m[4]);
  const mins = Number(m[2] ?? 0);
  const half = (m[3] ?? m[5])?.toLowerCase();
  if (half === "pm" && h < 12) h += 12;
  if (half === "am" && h === 12) h = 0;
  return h * 60 + mins;
}

/** The first day the mail names, from the day it was sent on, with the times said near it. */
export function findWhen(text: string, sentSeconds: number): When | null {
  const sent = new Date(sentSeconds * 1000);
  const day = findDay(text, sent) ?? findWeekday(text, sent);
  if (!day) return null;
  // Times in the same stretch of text: up to 60 characters either side of the day.
  const near = text.slice(Math.max(0, day.index - 60), day.end + 60);
  const times = [...near.matchAll(TIME)];
  const at = new Date(day.date);
  if (!times.length) return { at: at.getTime() / 1000, end: null, allDay: true };
  const first = times[0];
  at.setMinutes(minutesOf(first));
  let end: number | null = null;
  const second = times[1];
  if (second && RANGE.test(near.slice(first.index! + first[0].length, second.index!))) {
    const e = new Date(day.date);
    e.setMinutes(minutesOf(second));
    if (e > at) end = e.getTime() / 1000;
  }
  return { at: at.getTime() / 1000, end, allDay: false };
}

const STREET =
  /(?:\b\d{1,5}\s+[\p{Lu}][\p{L}'.-]*(?:\s+[\p{Lu}][\p{L}'.-]*)*\s+(?:street|st\.|road|rd\.|avenue|ave\.|lane|way|boulevard|blvd\.|drive|place|square)|\b[\p{Lu}][\p{L}'.-]*(?:\s+[\p{Lu}][\p{L}'.-]*)*\s+(?:ulica|cesta|trg|put|street|road|avenue|lane|boulevard)\s+\d{1,4}[a-z]?|\b(?:ul\.|ulica)\s+[\p{Lu}][\p{L}'.-]*(?:\s+[\p{L}'.-]+){0,3}\s+(?:\d{1,4}[a-z]?|bb)|\b[\p{Lu}][\p{L}]*(?:straat|gracht|weg|laan|plein|straße|strasse|gasse|platz|kade)\s+\d{1,4}[a-z]?)(?:,\s*\d{4,5})?(?:,?\s*[\p{Lu}][\p{L}-]+(?:\s+[\p{Lu}][\p{L}-]+)?)?/u;

/** A street address, as written. */
export function findWhere(text: string): string | null {
  return STREET.exec(text)?.[0].replace(/\s+/g, " ").trim() ?? null;
}

// Whole words by Unicode letters, as `\b` finds no edge after the š of "možeš".
const ASKING = /(?<![\p{L}\p{N}])(you|your|can|could|would|will|please|li|možeš|možete|mozes|mozete|molim|trebate|trebaš|da li)(?![\p{L}\p{N}])/iu;

/** Questions put to the person, and their "please"s: at most three, in order. */
export function findAsks(text: string): string[] {
  // A line break ends a sentence too: a line that ends in a link has no full stop.
  const sentences = text
    .split(/\n+/)
    .flatMap((line) => line.replace(/\s+/g, " ").split(/(?<=[.?!])\s+(?=[\p{Lu}"„“(])/u))
    .map((s) => s.trim());
  return sentences
    .filter((s) => s.length >= 12 && s.length <= 220 && ((s.endsWith("?") && ASKING.test(s)) || /^(please|molim)\b/i.test(s)))
    .slice(0, 3);
}

const CODE_WORDS =
  /\b(code|kod|pin|booking|reservation|rezervacij\w*|reference|ref\.?|order|narudžb\w*|tracking|confirmation|potvrd\w*|invoice|račun\w*|ticket)\b(?:\s+(?:number|no\.?|nr\.?|id|code|broj|kod|is|je|:))*\s*[:#]?\s*([A-Z0-9][A-Z0-9-]{3,24})\b/giu;
const LABELS: [RegExp, string][] = [
  [/^(booking|reservation|rezerv)/i, "Booking"], [/^(order|narudž)/i, "Order"], [/^tracking/i, "Tracking"],
  [/^(confirmation|potvrd)/i, "Confirmation"], [/^(invoice|račun)/i, "Invoice"], [/^ticket/i, "Ticket"],
  [/^(reference|ref)/i, "Reference"], [/^pin/i, "PIN"],
];

/** Codes to copy: booking and order numbers, tracking numbers, sign-in codes. */
export function findCodes(text: string): Code[] {
  const out: Code[] = [];
  for (const m of text.matchAll(CODE_WORDS)) {
    const value = m[2];
    // A code has a digit and no small letters; years and times are not codes.
    if (!/\d/.test(value) || /[a-z]/.test(value) || /^(19|20)\d\d$/.test(value) || out.some((c) => c.value === value)) continue;
    out.push({ label: LABELS.find(([re]) => re.test(m[1]))?.[1] ?? "Code", value });
    if (out.length === 3) break;
  }
  return out;
}

const NOT_A_LINK = /unsubscribe|odjav|preferences|manage your|view (it )?in (your )?browser|web version|privacy|terms/i;
const SOCIAL = /(^|\.)(facebook|twitter|x|instagram|linkedin|youtube|tiktok|pinterest)\.com$/i;

/** An address without what only tracks the click (utm_…, ref, fbclid), for telling two links apart. */
function plainUrl(url: URL): string {
  const u = new URL(url);
  for (const k of [...u.searchParams.keys()]) if (/^(utm_|mc_|ref$|fbclid$|gclid$|_hs)/i.test(k)) u.searchParams.delete(k);
  u.hash = "";
  return u.toString().replace(/\/$/, "");
}

/** The links worth opening: each says what it is (not "Read more" or "Add to Reader", not a picture with no words,
 * not the footer's unsubscribe, privacy or social links), each once by its words and by its address. */
export function findLinks(html: string | null, text: string, limit = 6): Link[] {
  const out: Link[] = [];
  const seen = new Set<string>();
  const fromHtml = !!html;
  const add = (href: string, label: string, repeated = false) => {
    let url: URL;
    try {
      url = new URL(href);
    } catch {
      return;
    }
    if (!/^https?:$/.test(url.protocol) || SOCIAL.test(url.hostname) || NOT_A_LINK.test(label) || NOT_A_LINK.test(href)) return;
    // Mail pads its words with invisible characters (zero-width joiners, soft hyphens) around icons.
    // biome-ignore lint/suspicious/noMisleadingCharacterClass: each invisible character goes on its own, the combining one too
    const words = label.replace(/[\u00ad\u034f\u200b-\u200f\u2060\ufeff]/g, "").replace(/\s+/g, " ").trim();
    if (repeated || ACTION_WORDS.test(words)) return;
    // In HTML mail, a link whose words are an address is a picture's or a raw one: it says nothing more.
    if (fromHtml && !/\s/.test(words) && /[./]/.test(words)) return;
    const host = url.hostname.replace(/^www\./, "");
    const shown = words && words !== href && words.length <= 90 ? words : host + url.pathname.replace(/\/$/, "");
    const plain = plainUrl(url);
    if (seen.has(plain) || seen.has(shown.toLowerCase())) return;
    seen.add(plain).add(shown.toLowerCase());
    out.push({ text: shown, href, host });
  };
  if (html) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const anchors = [...doc.querySelectorAll("a[href]")].map((a) => ({
      href: a.getAttribute("href")!,
      // A picture link's alt text stands in for its words; one with neither says nothing.
      label: (a.textContent?.trim() || a.querySelector("img")?.getAttribute("alt") || "").replace(/\s+/g, " "),
    }));
    // Words used for links to different places ("Add article to Reader" under every article) name none of them.
    const places = new Map<string, Set<string>>();
    for (const a of anchors) {
      let place = a.href;
      try {
        place = plainUrl(new URL(a.href));
      } catch {
        // Not an address; counted as written.
      }
      const key = a.label.toLowerCase();
      places.set(key, (places.get(key) ?? new Set()).add(place));
    }
    for (const a of anchors) {
      if (a.label) add(a.href, a.label, (places.get(a.label.toLowerCase())?.size ?? 0) > 1);
      if (out.length >= limit) return out;
    }
    return out;
  }
  // Addresses written out in the words, linked or not.
  for (const m of text.matchAll(/https?:\/\/[^\s<>"')\]]+/g)) {
    if (out.length >= limit) break;
    add(m[0].replace(/[.,;:]$/, ""), "");
  }
  return out;
}

/** Everything the column shows for one message. `text` is its new words only (no quote, no signature). */
export function factsOf(text: string, html: string | null, sentSeconds: number, linkLimit = 6): Facts {
  return {
    when: findWhen(text, sentSeconds),
    where: findWhere(text),
    asks: findAsks(text),
    codes: findCodes(text),
    links: findLinks(html, text, linkLimit),
  };
}

export const anyFact = (f: Facts) => !!(f.when || f.where || f.asks.length || f.codes.length || f.links.length);
