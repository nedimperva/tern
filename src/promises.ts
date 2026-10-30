// The companion's Promises: what the person owes in a conversation (what they said they'd do, what they were asked)
// and what is owed to them (what they asked, what others said they'd do). Found on this computer from the words,
// in English and Bosnian/Croatian/Serbian like the rest of `facts.ts`. Unit-tested in src/test/promises.test.ts.

import { findAsks } from "./facts";
import { foldAt } from "./fold";

type Message = { id: number; fromAddr: string; fromName: string; bodyText: string | null; snippet: string; date: number };

export type Pledge = {
  /** Stable across reloads, for ticking it off. */
  key: string;
  /** The person owes it (they said they would, or were asked); else it is owed to them. */
  yours: boolean;
  /** Who said it: "You", or the sender's first name. */
  who: string;
  text: string;
  message: number;
  /** When it is due, if the sentence names a day (Unix seconds). */
  due: number | null;
};

// Whole words by Unicode letters: `\b` takes š or č for a gap between words, so "Ostrošcu" would end in "cu".
// The future is also written joined ("poslaću", "poslacu" without the accent): only for verbs of doing something
// for someone, as "-cu" ends plenty of nouns ("ulicu", "jedinicu").
const WILL =
  /(?<![\p{L}\p{N}])(I'll|I will|I'm going to|I am going to|I can send|let me|we'll|we will|ću|cu|poslat ću|javit ću|šaljem|(?:posla|javi|uradi|dostavi|proslijedi|pogleda|provjeri|nazva|vrati|plati|uplati|spremi|pripremi|završi|zavrsi|sredi|potvrdi)(?:ću|cu|ćemo|cemo))(?![\p{L}\p{N}])/iu;
// What goes with this very mail ("u prilogu šaljem sliku", "attached is") is done as it is said, not owed.
const ATTACHED = /(?<![\p{L}\p{N}])(u prilogu|u privitku|prilažem|prilazem|attached|attaching|enclosed|please find)(?![\p{L}\p{N}])/iu;

function sentences(text: string) {
  return text
    .split(/\n+/)
    .flatMap((line) => line.replace(/\s+/g, " ").split(/(?<=[.?!])\s+(?=[\p{Lu}"„“(])/u))
    .map((s) => s.trim())
    .filter((s) => s.length >= 12 && s.length <= 220);
}

const own = (text: string) => {
  const at = foldAt(text);
  return at < 0 ? text : text.slice(0, at);
};

const DAYS: [RegExp, number][] = [
  [/^(sun|ned)/, 0], [/^(mon|pon)/, 1], [/^(tue|uto)/, 2], [/^(wed|sri)/, 3], [/^(thu|čet|cet)/, 4], [/^(fri|pet)/, 5], [/^(sat|sub)/, 6],
];
const DUE = /(?<![\p{L}\p{N}])(today|tonight|tomorrow|danas|sutra|end of (?:the )?week|(?:mon|tues|wednes|thurs|fri|satur|sun)day|ponedjeljak|utorak|srijed[au]|četvrtak|petak|subot[au]|nedjelj[au])(?![\p{L}\p{N}])/iu;

/** The day a sentence says it is due ("by Thursday", "tomorrow", "end of the week"), from when it was sent. */
export function dueIn(text: string, sentSeconds: number): number | null {
  const m = DUE.exec(text);
  if (!m) return null;
  const word = m[1].toLowerCase();
  const d = new Date(sentSeconds * 1000);
  d.setHours(0, 0, 0, 0);
  if (/^(tomorrow|sutra)/.test(word)) d.setDate(d.getDate() + 1);
  else if (!/^(today|tonight|danas)/.test(word)) {
    const day = word.startsWith("end of") ? 5 : DAYS.find(([re]) => re.test(word))?.[1];
    if (day === undefined) return null;
    d.setDate(d.getDate() + ((day - d.getDay() + 7) % 7 || 7));
  }
  return d.getTime() / 1000;
}

/** Small, stable text hash for keys. */
function hash(s: string) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

export function promisesIn(messages: Message[], mine: (addr: string) => boolean): Pledge[] {
  const out: Pledge[] = [];
  for (const m of messages) {
    const words = own(m.bodyText ?? m.snippet);
    const me = mine(m.fromAddr);
    const who = me ? "You" : (m.fromName || m.fromAddr).split(/[\s@]/)[0];
    const add = (text: string, yours: boolean) =>
      out.push({ key: `${m.id}:${hash(text)}`, yours, who, text, message: m.id, due: dueIn(text, m.date) });
    const asked = new Set(findAsks(words));
    for (const s of sentences(words)) {
      if (asked.has(s)) add(s, !me);
      else if (WILL.test(s) && !s.endsWith("?") && !ATTACHED.test(s)) add(s, me);
    }
  }
  return out;
}
