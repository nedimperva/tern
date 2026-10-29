// What a message repeats or signs off with, folded away behind "···" (docs/design/ui.md §4.2).

/** The header Outlook writes over the mail it quotes, in English and Bosnian/Croatian/Serbian, German, French. */
const OUTLOOK_HEADER = /^(From|Od|Von|De|Šalje):\s.{3,300}?\b(Sent|Poslano|Poslato|Gesendet|Envoyé|Date|Datum):\s/is;

/** A legal notice a company's mail server puts under every message ("NOTICE: … intended recipient …"), in English
 * and Bosnian/Croatian/Serbian. Replies carry each earlier copy, so they pile up. */
const NOTICE =
  /\b(intended recipient|contractual penalty|confidential(?:ity)? (?:notice|information)|is confidential|privileged|unauthori[sz]ed (?:copying|use|distribution|disclosure)|disclaimer|naznačeni primatelj|ugovornu kaznu|povjerljiv\w*|neovlašten\w* (?:kopiranje|korištenje|distribucija)|zaštićene zakonom)/i;

/** A paragraph that is such a notice: long enough to be one, and saying what they say. */
export const isNotice = (text: string) => text.trim().length >= 60 && NOTICE.test(text);

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
    const signature = line === "--" && lines[i] === "-- ";
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
  // Outlook marks nothing: its quote starts with a "From: … Sent: …" block, and everything after that block in the
  // message (its siblings, and theirs on each level up) is the earlier mail.
  for (const el of doc.querySelectorAll("p, div")) {
    if (el.closest(".tern-quote") || el.querySelector("p, div")) continue;
    const text = (el.textContent ?? "").replace(/\u00a0/g, " ").trim();
    if (!OUTLOOK_HEADER.test(text) || !el.previousElementSibling && el.parentElement === doc.body) continue;
    for (let at: Element | null = el; at && at !== doc.body; at = at.parentElement) {
      if (at === el) at.classList.add("tern-quote");
      for (let next = at.nextElementSibling; next; next = next.nextElementSibling) next.classList.add("tern-quote");
    }
    break;
  }
  // Legal notices, wherever they are: the smallest block that holds one, never the whole message.
  for (const el of doc.querySelectorAll("p, div, td")) {
    if (el.querySelector("p, div, table, blockquote") || el === doc.body.firstElementChild) continue;
    if (isNotice((el.textContent ?? "").replace(/\u00a0/g, " "))) el.classList.add("tern-quote");
  }
  for (const p of doc.querySelectorAll("p")) {
    if (p.closest("blockquote") || (p.textContent ?? "").replace(/\u00a0/g, " ").trim() !== "--") continue;
    // Only a signature under words of the message's own, not one that is all there is.
    if (!p.previousElementSibling) continue;
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
