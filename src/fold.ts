// What a message repeats or signs off with, folded away behind "···" (docs/design/ui.md §4.2).

/** The header Outlook writes over the mail it quotes, in English and Bosnian/Croatian/Serbian, German, French. */
const HEADER_START = /^(From|Od|Von|De|Šalje):/i;
const OUTLOOK_HEADER = /^(From|Od|Von|De|Šalje):\s.{3,300}?\b(Sent|Poslano|Poslato|Gesendet|Envoyé|Date|Datum):\s/is;

/** A legal notice a company's mail server puts under every message ("NOTICE: … intended recipient …"), in English
 * and Bosnian/Croatian/Serbian. Replies carry each earlier copy, so they pile up. */
const NOTICE =
  /\b(intended recipient|contractual penalty|confidential(?:ity)? (?:notice|information)|is confidential|privileged|unauthori[sz]ed (?:copying|use|distribution|disclosure)|disclaimer|naznačeni primatelj|ugovornu kaznu|povjerljiv\w*|neovlašten\w* (?:kopiranje|korištenje|distribucija)|zaštićene zakonom)/i;

/** The most text a block can hold and still be folded as one piece: a wrapper around a whole mail is not a notice. */
const FOLD_BLOCK_MAX = 1500;

/** A paragraph that is such a notice: long enough to be one, and saying what they say. */
export const isNotice = (text: string) => text.trim().length >= 60 && NOTICE.test(text);

/** The words people sign off with, alone on a line, in the languages above. */
const SIGN_OFF =
  /^(s poštovanjem|s postovanjem|srdačan pozdrav|srdacan pozdrav|srdačno|srdacno|lijep pozdrav|lep pozdrav|pozdrav|pozdravi|lp|best regards|kind regards|warm regards|regards|best|cheers|thanks|many thanks|mit freundlichen grüßen|viele grüße|cordialement)[,.!]?$/i;

/** A signature's worth of lines from `from` on: one to twelve short ones, up to a quote. */
/** A line where the quote under a signature starts. */
const quoteStart = (l: string) => l.startsWith(">") || /^(On|Am|Le|Op) .{4,200}$/.test(l) || /^-{2,}\s*(Original|Forwarded)/i.test(l) || /^(From|Od|Von|De):\s/.test(l);

function shortTail(lines: string[], from: number): boolean {
  let n = 0;
  for (let j = from; j < lines.length; j++) {
    const l = lines[j].trim();
    if (quoteStart(l)) break;
    if (!l) continue;
    if (l.length > 90 || ++n > 12) return false;
  }
  return n > 0;
}

/** A folded signature said in one line ("Renato Šuster · Gama Trade d.o.o · Usora"), for the pill that opens it;
 * null when the fold starts with a quote instead. Phone numbers, addresses and links are left for the unfolded view. */
export function signatureLine(folded: string): string | null {
  const lines = folded
    .split("\n")
    .map((l) => l.replace(/ /g, " ").trim())
    .filter(Boolean);
  if (!lines.length || !(lines[0] === "--" || SIGN_OFF.test(lines[0]))) return null;
  const end = lines.findIndex((l, i) => i > 0 && quoteStart(l));
  const said = lines
    .slice(1, end < 0 ? undefined : end)
    .filter((l) => l !== "--" && !SIGN_OFF.test(l) && !/@|https?:|www\.|\d{4,}|^\+?[\d\s()/.-]{7,}$/.test(l) && l.length <= 48)
    .slice(0, 3)
    .map((l) => l.replace(/[,;]$/, ""));
  return said.length ? said.join(" · ") : null;
}

/** "On …, Ana Rossi <ana@x.org> wrote:" in the languages above; the middle holds the date and the name. */
const WROTE_LINE =
  /^(?:On|Am|Le|El|Il|Op|Den|W dniu|Dana|Dne)\s(.{2,300}?)\s*(?:wrote|schrieb|a écrit|escribió|ha scritto|schreef|skrev|napisał|je napisao|je napisala|napisao|napisala|napisal|napsal)\s*:?$/i;
/** An Outlook or forward header's lines: who, when, to whom, about what. */
const HEADER_LINE = /^(From|Od|Von|De|Šalje|Pošiljatelj|Sent|Date|Datum|Poslano|Poslato|Gesendet|Envoyé|To|Za|An|À|Prima|Cc|Kopija|Subject|Predmet|Betreff|Objet|Tema)\s*:\s*(.*)$/i;
const FROM_KEY = /^(From|Od|Von|De|Šalje|Pošiljatelj)$/i;
const SUBJECT_KEY = /^(Subject|Predmet|Betreff|Objet|Tema)$/i;

/** The name in "Ana Rossi <ana@x.org>", "Ana Rossi [mailto:ana@x.org]" or "ana@x.org": the address when that is all. */
function nameOf(who: string): string {
  const addr = who.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/)?.[0] ?? "";
  const name = who
    .replace(/<[^>]*>|\[mailto:[^\]]*\]|\([^)]*@[^)]*\)/gi, "")
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, "")
    .replace(/["'“”]/g, "")
    .trim()
    .replace(/[,;:]$/, "")
    .trim();
  return name || addr;
}

/** The sender in the middle of an "On … wrote:" line, its date taken off the front: after the time when it says
 * one ("…, 3 Nov 2025 at 10:04 Ana Rossi"), else after the last comma ("On Mon, Ana"). */
function wroteName(middle: string): string {
  const before = middle.includes("<") ? middle.slice(0, middle.indexOf("<")) : middle;
  const times = [...before.matchAll(/\d{1,2}[:.]\d{2}(?::\d{2})?(?:\s?[AaPp]\.?[Mm]\.?)?(?:\s?(?:[A-Z]{2,5}|[+-]\d{4}))?,?/g)];
  const last = times.at(-1);
  let name = last ? before.slice((last.index ?? 0) + last[0].length) : before.slice(before.lastIndexOf(",") + 1);
  // Thunderbird says the date alone before the comma ("03/11/2025 10:04, Ana"); what is left must not be a date.
  if (/\d{4}/.test(name)) name = "";
  name = nameOf(name);
  return name || nameOf(middle);
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max).replace(/\s+\S*$/, "")}…` : text);

/** What a folded quote holds, so its "···" pill can say whose mail it is: the sender from the "On … wrote:" line
 * or the From: of Outlook's or a forward's header, and the quoted mail's first words (its subject when it has
 * none). Null when the fold holds no quote. */
export function quoteOf(folded: string): { who: string; said: string } | null {
  const lines = folded
    .split("\n")
    .map((l) => l.replace(/\u00a0/g, " ").trim())
    // Outlook's header can arrive as one line ("From: Ana Sent: Monday To: Tom Subject: Offer").
    .flatMap((l) => (HEADER_START.test(l) && OUTLOOK_HEADER.test(l) ? l.split(/\s+(?=(?:Sent|Poslano|Poslato|Gesendet|Envoyé|Date|Datum|To|Za|An|À|Prima|Cc|Subject|Predmet|Betreff|Objet|Tema):\s)/) : [l]));
  let who = "";
  let subject = "";
  let start = -1;
  for (let i = 0; i < lines.length && start < 0; i++) {
    const l = lines[i];
    const wrote = l.match(WROTE_LINE) ?? (/^(On|Am|Le) /.test(l) ? `${l} ${lines[i + 1] ?? ""}`.match(WROTE_LINE) : null);
    if (wrote) {
      who = wroteName(wrote[1]);
      start = wrote[0].length > l.length ? i + 2 : i + 1;
      continue;
    }
    const head = l.match(HEADER_LINE);
    if (head && FROM_KEY.test(head[1]) && HEADER_LINE.test(lines[i + 1] ?? "")) {
      who = nameOf(head[2]);
      let j = i;
      for (; j < lines.length && HEADER_LINE.test(lines[j]); j++) {
        const h = lines[j].match(HEADER_LINE);
        if (h && SUBJECT_KEY.test(h[1])) subject = h[2].trim();
      }
      start = j;
      continue;
    }
    if (l.startsWith(">")) start = i;
  }
  if (start < 0) return null;
  const words: string[] = [];
  for (const raw of lines.slice(start)) {
    const l = raw.replace(/^(>\s?)+/, "").trim();
    // The quote's own quote, or its signature, ends its words.
    if (WROTE_LINE.test(l) || /^-{2,}\s*(Original|Forwarded)/i.test(l) || l === "--" || (words.length && SIGN_OFF.test(l))) break;
    if (/^-{2,}\s*(Original|Forwarded)/i.test(raw) || HEADER_LINE.test(l)) continue;
    if (l) words.push(l);
    if (words.join(" ").length > 90) break;
  }
  const said = clip(words.join(" ").replace(/\s+/g, " "), 60) || subject;
  if (!who && !said) return null;
  return { who, said };
}

/** The quote pill's words, as compose's own quote pill says them: "“Thanks for the offer…” · Ana Rossi’s message". */
export function quoteLabel(q: { who: string; said: string }): string {
  if (q.who && q.said) return `“${q.said}” · ${q.who}’s message`;
  return q.who ? `${q.who}’s message` : `“${q.said}”`;
}

/** A greeting alone on the first line ("Hi Ana,", "Poštovani,", "Dear all,"), which a one-line preview can do without. */
const GREETING =
  /^(hi|hello|hey|dear|good (morning|afternoon|evening)|poštovani|poštovana|poštovanje|postovani|postovana|postovanje|dragi|draga|zdravo|ćao|cao|pozdrav|dobar dan|dobro jutro|hallo|liebe|lieber|sehr geehrte\w*|guten tag|bonjour|salut)\b[^.?!\n]{0,30}[,!]?$/i;

/** The text without its first line when that is only a greeting, so a preview starts at what the mail says. */
export function withoutGreeting(text: string): string {
  const t = text.trimStart();
  const end = t.indexOf("\n");
  if (end < 0) return text;
  return GREETING.test(t.slice(0, end).trim()) && t.slice(end).trim() ? t.slice(end + 1) : text;
}

/** Where in a plain-text body the quoted reply or the signature starts, so it can be folded; -1 if nowhere. */
export function foldAt(text: string): number {
  const lines = text.split("\n");
  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trimEnd();
    const next = lines[i + 1]?.trim() ?? "";
    const quoteHeader =
      /^(On|Am|Le|El|Il|Op|Den|W dniu) .{4,200}(wrote|schrieb|a écrit|escribió|ha scritto|schreef|skrev|napisał):$/i.test(line) ||
      (/^On .{4,200}$/.test(line) && /^.{0,80}wrote:$/.test(next));
    const original = /^-{2,}\s*(Original Message|Forwarded message|Ursprüngliche Nachricht)\s*-{2,}$/i.test(line);
    const outlook = /^(From|Von|De):\s.+/.test(line) && /^(Sent|Gesendet|Envoyé|Date):\s/.test(next);
    const quoted = line.startsWith(">") && lines.slice(i).filter((l) => l.trim()).every((l) => l.startsWith(">"));
    // "-- " by the book; a bare "--", or a sign-off ("Srdačan pozdrav"), when only a few short lines follow it.
    const signature = (line === "--" && (lines[i] === "-- " || shortTail(lines, i + 1))) || (offset > 0 && SIGN_OFF.test(line) && shortTail(lines, i + 1));
    const sentFrom = /^Sent from my \w+/i.test(line) && i >= lines.length - 3;
    // A notice starts a fold too, unless it is all the message says.
    const notice = offset > 0 && isNotice(line);
    if (quoteHeader || original || outlook || quoted || signature || sentFrom || notice) {
      // Keep the blank lines before it with the visible part out of the fold.
      return text.slice(0, offset).trimEnd().length;
    }
    offset += lines[i].length + 1;
  }
  return -1;
}

const WROTE = /(wrote|napisao|napisala|schrieb|a écrit|escribió|ha scritto|schreef|skrev|napisał):\s*$/i;

/** Marks (class "tern-quote") what the known mail apps' classes don't: a quote that is a plain <blockquote> after
 * an "On … wrote:" line, as Tern itself wrote them before 1.6 and some apps still do, with that line; and a "--"
 * signature line with everything after it at its level. Call before HTML_FOLD_SELECTOR is used. */
export function markQuotes(doc: Document) {
  for (const q of doc.querySelectorAll("blockquote")) {
    if (q.parentElement?.closest("blockquote")) continue;
    const before = q.previousElementSibling;
    if (before && WROTE.test(before.textContent?.trim() ?? "")) {
      q.classList.add("tern-quote");
      before.classList.add("tern-quote");
    }
  }
  // Outlook's header and legal notices are found from the text, once through it: asking every block about the
  // blocks inside it took time by the square of the mail's size, and a big newsletter opened noticeably slower.
  const walker = doc.createTreeWalker(doc.body ?? doc, NodeFilter.SHOW_TEXT);
  let outlook: Element | null = null;
  const notices = new Set<Element>();
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const data = (n as Text).data;
    // A mail's styles and scripts are not its words, whatever they happen to contain.
    if (n.parentElement?.closest("style, script")) continue;
    const block = n.parentElement?.closest("p, div, td") ?? null;
    if (!block || block === doc.body) continue;
    // A notice in a newsletter's footer can sit straight in its outer wrapper, which holds the whole mail: folding
    // that folds everything. Only a block of its own size counts; the notice's own element is tried first.
    if (NOTICE.test(data) && (block.textContent?.length ?? 0) > FOLD_BLOCK_MAX) {
      const own = n.parentElement;
      if (own && own !== doc.body && (own.textContent?.length ?? 0) <= FOLD_BLOCK_MAX && isNotice((own.textContent ?? "").replace(/ /g, " "))) notices.add(own);
      continue;
    }
    if (!outlook && HEADER_START.test(data.trimStart())) {
      const text = (block.textContent ?? "").replace(/\u00a0/g, " ").trim();
      if (OUTLOOK_HEADER.test(text) && !block.closest(".tern-quote") && (block.previousElementSibling || block.parentElement !== doc.body))
        outlook = block;
    }
    if (NOTICE.test(data) && !notices.has(block) && block !== doc.body?.firstElementChild && isNotice((block.textContent ?? "").replace(/\u00a0/g, " ")))
      notices.add(block);
  }
  // Everything after Outlook's "From: … Sent: …" block in the message (its siblings, and theirs on each level up)
  // is the earlier mail.
  for (let at: Element | null = outlook; at && at !== doc.body; at = at.parentElement) {
    if (at === outlook) at.classList.add("tern-quote");
    for (let next = at.nextElementSibling; next; next = next.nextElementSibling) next.classList.add("tern-quote");
  }
  for (const el of notices) el.classList.add("tern-quote");
  for (const p of doc.querySelectorAll("p")) {
    if (p.closest("blockquote") || (p.textContent ?? "").replace(/\u00a0/g, " ").trim() !== "--") continue;
    // Only a signature under words of the message's own, not one that is all there is.
    if (!p.previousElementSibling) continue;
    p.classList.add("tern-sig");
    for (let at: Element | null = p; at; at = at.nextElementSibling) at.classList.add("tern-quote");
    break;
  }
}

/** CSS that hides quoted replies and signatures inside mail HTML while <html> has the "tern-fold" class. */
export const HTML_FOLD_CSS = `
.tern-fold .tern-quote, .tern-fold .gmail_quote, .tern-fold .gmail_signature, .tern-fold blockquote[type="cite"],
.tern-fold .moz-cite-prefix, .tern-fold .yahoo_quoted, .tern-fold #divRplyFwdMsg, .tern-fold #divRplyFwdMsg ~ *,
.tern-fold #appendonsend ~ *, .tern-fold .protonmail_quote { display: none !important; }`;

export const HTML_FOLD_SELECTOR =
  '.tern-quote, .gmail_quote, .gmail_signature, blockquote[type="cite"], .moz-cite-prefix, .yahoo_quoted, #divRplyFwdMsg, #appendonsend, .protonmail_quote';
