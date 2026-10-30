// What a message repeats or signs off with, folded away behind "···" (docs/design/ui.md §4.2).

/** The header Outlook writes over the mail it quotes, in English and Bosnian/Croatian/Serbian, German, French. */
const HEADER_START = /^(From|Od|Von|De|Šalje):/i;
const OUTLOOK_HEADER = /^(From|Od|Von|De|Šalje):\s.{3,300}?\b(Sent|Poslano|Poslato|Gesendet|Envoyé|Date|Datum):\s/is;

/** A legal notice a company's mail server puts under every message ("NOTICE: … intended recipient …"), in English
 * and Bosnian/Croatian/Serbian. Replies carry each earlier copy, so they pile up. */
const NOTICE =
  /\b(intended recipient|contractual penalty|confidential(?:ity)? (?:notice|information)|is confidential|privileged|unauthori[sz]ed (?:copying|use|distribution|disclosure)|disclaimer|naznačeni primatelj|ugovornu kaznu|povjerljiv\w*|neovlašten\w* (?:kopiranje|korištenje|distribucija)|zaštićene zakonom)/i;

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
    const block = n.parentElement?.closest("p, div, td") ?? null;
    if (!block || block === doc.body) continue;
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
