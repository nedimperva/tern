// What a message repeats or signs off with, folded away behind "···" (docs/design/ui.md §4.2).

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
    if (quoteHeader || original || outlook || quoted || signature || sentFrom) {
      // Keep the blank lines before it with the visible part out of the fold.
      return text.slice(0, offset).trimEnd().length;
    }
    offset += lines[i].length + 1;
  }
  return -1;
}

/** CSS that hides quoted replies and signatures inside mail HTML while <html> has the "tern-fold" class. */
export const HTML_FOLD_CSS = `
.tern-fold .gmail_quote, .tern-fold .gmail_signature, .tern-fold blockquote[type="cite"],
.tern-fold .moz-cite-prefix, .tern-fold .yahoo_quoted, .tern-fold #divRplyFwdMsg, .tern-fold #divRplyFwdMsg ~ *,
.tern-fold #appendonsend ~ *, .tern-fold .protonmail_quote { display: none !important; }`;

export const HTML_FOLD_SELECTOR =
  '.gmail_quote, .gmail_signature, blockquote[type="cite"], .moz-cite-prefix, .yahoo_quoted, #divRplyFwdMsg, #appendonsend, .protonmail_quote';
