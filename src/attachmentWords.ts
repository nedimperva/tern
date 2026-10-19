/** Words that say a file goes with the message, in the languages Tern's people write in. Every list is checked
 * at once, so nobody picks a language. Each entry matches at the start of a word (`priložen` finds priložena,
 * priloženi); spaces match any run of spaces. Single short words that mean something else too stay out: Bosnian
 * "prilog" is also "contribution", so it counts only in phrases. */
const BUILT_IN = [
  // English
  "attached", "attaching", "attachment", "enclosed", "see the file", "find the file", "here's the file",
  "here is the file",
  // Bosnian, Croatian, Serbian (Latin and Cyrillic)
  "u prilogu", "u privitku", "prilažem", "priložen", "privitak", "prikačen", "prikačio", "prikačila", "zakačen",
  "šaljem prilog", "pogledaj prilog", "pogledajte prilog", "šaljem fajl", "šaljem datoteku",
  "у прилогу", "прилажем", "приложен", "прикачен",
  // German
  "anhang", "angehängt", "anbei", "im anhang",
  // French
  "pièce jointe", "pièces jointes", "ci-joint", "en pièce jointe", "joint le fichier",
  // Spanish, Portuguese, Italian
  "adjunto", "adjunta", "en el adjunto", "em anexo", "anexo", "segue anexo", "in allegato", "allegato", "allego",
  // Dutch
  "bijlage", "bijgevoegd",
  // Polish
  "w załączniku", "załącznik", "załączam",
  // Turkish
  "ekte", "ek olarak", "ekteki",
];

/** The words to look for: the built-in ones and the person's own (Settings → Compose). */
export function attachmentWords(own: string[] = []): string[] {
  return [...BUILT_IN, ...own.map((w) => w.trim()).filter(Boolean)];
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The first word in `text` that says something is attached, or null. Case and accents as typed by the person:
 * "Prilažem" and "prilažem" both count; "prilazem" (no accent) counts too, since many type without them. */
export function mentionsAttachment(text: string, words: string[]): string | null {
  const plain = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
  const haystack = plain(text);
  for (const word of words) {
    const pattern = plain(word).split(/\s+/).map(escape).join("\\s+");
    // Starts a word: nothing letter-like right before it.
    const m = new RegExp(`(?<![\\p{L}\\p{N}])${pattern}`, "u").exec(haystack);
    if (m) return word;
  }
  return null;
}

/** Public mail services: everyone on them is someone else, so "outside your organisation" means nothing there. */
const PUBLIC = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "msn.com", "yahoo.com", "ymail.com",
  "icloud.com", "me.com", "mac.com", "aol.com", "proton.me", "protonmail.com", "gmx.com", "gmx.net", "gmx.de",
  "web.de", "mail.com", "zoho.com", "fastmail.com", "hey.com", "yandex.com", "mail.ru",
]);

export const domainOf = (address: string) => address.slice(address.lastIndexOf("@") + 1).toLowerCase();

/** Whether `address` is outside the sender's organisation. Never for senders on a public mail service. */
export function outside(address: string, sender: string | undefined): boolean {
  if (!sender || !address.includes("@")) return false;
  const own = domainOf(sender);
  return !PUBLIC.has(own) && domainOf(address) !== own;
}
