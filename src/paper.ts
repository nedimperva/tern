// Paper trail (idea 115): what a receipt, an invoice, an order or a booking says, read on this computer from the
// mail's own text. Plain functions, unit-tested in src/test/paper.test.ts. Anything not found is left out; nothing
// is sent anywhere.

import { findCodes } from "./facts";
import { foldAt } from "./fold";

export type PaperKind = "Receipt" | "Invoice" | "Order" | "Booking" | "Payment" | "Subscription";
export type Paper = { kind: PaperKind; amount: number | null; currency: string | null; reference: string | null };

const REPLY_OR_FWD = /^\s*(re|fwd?|aw|wg|odg|sv|tr)\s*(\[\d+\])?\s*:/i;

// Subjects that mention billing words ("račun", "faktura", "order") without being a real billed/paid transaction:
// bank account statements, credit/loan/promo offers, overdue payment reminders, quotes, and account security mail.
const NOISE_SUBJECT =
  /izvod(\s+(po|sa))?\s+račun|mjesečni\s+izvod|dnevni\s+izvod|izvod\s+prometa|stanje\s+račun|promet\s+po\s+račun|bank\s+statement|account\s+statement|monthly\s+statement|e-?statement|kontoauszug|umsatzanzeige|izvod\s+otvorenih\s+stavki|opomen|podsjetnik|payment\s+reminder|overdue|past\s+due|istekl\p{L}*\s+(faktur|račun)|dospjel\p{L}*\s+(faktur|račun|obavez|dug)|neplaćen\p{L}*\s+(faktur|račun)|mahnung|zahlungserinnerung|otvorene\s+stavke|kartica\s+kupca|\bkredit(?!n\p{L}*\s+kartic)|loan\s+offer|pre-?approved|credit\s+(offer|limit|line)|specijalna\s+ponuda|popust\s+do|uštedite\s+do|save\s+up\s+to|nagradna\s+igra|cashback|\bponuda\b|predračun|profaktur|proforma|\bestimate\b|quotation|\bangebot\b|korisničk\p{L}*\s+račun|(google|apple|microsoft)\s+račun|sigurnost\s+račun|zaštit\p{L}*\s+račun|prijav\p{L}*\s+na\s+račun|verifikacij\p{L}*\s+račun|aktivacij\p{L}*\s+račun|otvorite\s+račun|pristup\s+račun|lozink|verification\s+code/iu;

// Opening prose that marks a payment-chasing email, bank statement, or credit ad rather than a real invoice/receipt.
const NOISE_BODY =
  /molim(o)?\s+vas\s+(za\s+)?uplat|uplatu\s+isteklih|isteklih\s+faktur|dospjelih\s+(faktur|račun|obavez)|neplaćenih\s+(faktur|račun)|otvorenih\s+stavki|molimo\s+da\s+izmirite|opomena\s+pred|podsjetnik\s+za\s+uplatu|overdue\s+(invoice|balance|payment)|past\s+due\s+(invoice|balance)|please\s+pay\s+(your\s+)?overdue|izvod\s+(po|sa)\s+račun|mjesečni\s+izvod\s+po\s+računu|stanje\s+na\s+računu|gotovinski\s+kredit|nenamjenski\s+kredit|stambeni\s+kredit|kreditna\s+linija|pre-?approved\s+(for\s+)?(a\s+)?(loan|credit)|ostvarite\s+kredit|odobren\p{L}*\s+(kredit|limit)/iu;

const KINDS: [RegExp, PaperKind][] = [
  [/invoice|faktur|rechnung|račun\s+za|račun\s*(br\.?|#|broj)|e-?račun|mjesečni\s+račun|bill\b/iu, "Invoice"],
  [/receipt|quittung|potvrda\s+o\s+(plaćanju|uplati)|fiskaln/iu, "Receipt"],
  [/subscription|renewal|pretplat/iu, "Subscription"],
  [/booking|reservation|ticket|rezervacij|\bkarta\b|\bkarte\b|boarding/iu, "Booking"],
  [/\border\b|narudžb|bestellung|shipped|poslan/iu, "Order"],
  [/payment|paid|potvrda\s+uplate|izvršena\s+uplata|plaćanj|zahlung/iu, "Payment"],
];

// Subject words strong enough to keep an attachment-bearing invoice/ticket even when the amount is inside the PDF.
const ATTACHED_PAPER = /invoice|faktur|rechnung|račun|receipt|quittung|ticket|\bkarta\b|boarding/iu;

// A currency's sign or code, as mail writes it, and the code it stands for.
const CURRENCIES: [RegExp, string][] = [
  [/^(€|eur|euro?s?)$/i, "EUR"],
  [/^(\$|usd|us\$)$/i, "USD"],
  [/^(£|gbp)$/i, "GBP"],
  [/^(km|bam|kм)$/i, "BAM"],
  [/^(kn|hrk)$/i, "HRK"],
  [/^(rsd|din\.?|дин)$/i, "RSD"],
  [/^(chf|fr\.)$/i, "CHF"],
];
// Prefix currencies can appear before the figure (€12, USD 40, BAM 24); suffix-only tokens like "din." and "kn"
// never precede a price (otherwise "DIN 933" hex bolts or "kN 200" kilonewtons read as RSD/HRK).
const PREFIX_CUR = "€|\\$|£|eur|usd|gbp|bam|hrk|rsd|chf";
const SUFFIX_CUR = "€|\\$|£|eur|usd|gbp|km|bam|kn|hrk|rsd|din\\.?(?!\\s*(?:\\d|en\\b|iso\\b))|chf";
const NUM = "(?:\\d{1,3}(?:[.,' ]\\d{3})*(?:[.,]\\d{1,2})?|\\d+(?:[.,]\\d{1,2})?)";
const AMOUNT = new RegExp(`(?<![\\p{L}\\d])(?:(${PREFIX_CUR})\\s?(${NUM})|(${NUM})\\s?(${SUFFIX_CUR}))(?![\\p{L}\\d])`, "giu");
const HAS_AMOUNT = new RegExp(`(?<![\\p{L}\\d])(?:(${PREFIX_CUR})\\s?(${NUM})|(${NUM})\\s?(${SUFFIX_CUR}))(?![\\p{L}\\d])`, "iu");
// The line that holds what was paid or is owed, before any other amount in the mail.
const TOTAL =
  /total|amount(\s+(due|paid|charged))?|sum\b|ukupn|iznos|za\s+(platiti|uplatu)|gesamt|betrag|to\s+pay|paid|due|charged|naplać|plaćeno/i;
const SUBTOTAL = /\b(sub-?total|međuzbir|neto|osnovica|tax|vat|pdv|shipping|delivery|dostav|discount|popust)\b/i;
// Amounts on lines describing credit limits, loan offers, balances, thresholds or overdue reminders are not spend.
const IGNORE_AMOUNT_LINE = new RegExp(
  `(?<![\\p{L}\\d])((?:do|od|iznad|preko|up\\s+to|over|above)\\s+(?:(?:${PREFIX_CUR})\\s?${NUM}|${NUM}\\s?(?:${SUFFIX_CUR}))|min(?:imum|\\.)?\\s|max(?:imum|imaln|\\.)?\\s|maksimaln|kredit(?!n\\p{L}*\\s+kartic)|\\bloan\\b|\\blimit\\b|pozajmic|kamat|odobren|raspoloživ|available\\s+balance|current\\s+balance|ending\\s+balance|opening\\s+balance|stanje\\s+račun|\\bsaldo\\b|dugovanj|istekl|dospjel|ušted|\\bsave\\s+up\\s+to|cashback|reward|bonus|free\\s+shipping|besplatn\\p{L}*\\s+dostav|u\\s+vrijednosti|\\bwin\\b|osvoj)`,
  "iu",
);

function currencyOf(word: string): string | null {
  const w = word.trim();
  // Exact-case SI unit "kN" (kilonewton) is a force measurement, not Croatian kuna.
  if (w === "kN") return null;
  return CURRENCIES.find(([re]) => re.test(w))?.[1] ?? null;
}

/** Strips quoted replies and signatures so old threads never contribute amounts. */
function ownText(text: string): string {
  const at = foldAt(text);
  return at < 0 ? text : text.slice(0, at);
}

/** "1.234,56", "1,234.56", "24,00", "19": the number, whichever mark is the decimal one. */
export function numberOf(raw: string): number {
  const s = raw.replace(/['\s]/g, "");
  const lastDot = s.lastIndexOf(".");
  const lastComma = s.lastIndexOf(",");
  const decimal = Math.max(lastDot, lastComma);
  // A mark followed by exactly three digits, with no other kind of mark after it, groups thousands.
  if (decimal < 0 || (/^\d{3}$/.test(s.slice(decimal + 1)) && (lastDot < 0 || lastComma < 0))) return Number(s.replace(/[.,]/g, ""));
  return Number(`${s.slice(0, decimal).replace(/[.,]/g, "")}.${s.slice(decimal + 1)}`);
}

/** The amount that matters: on a total's line (or straight after a Total label in a table), ignoring credit offers,
 * limits, balances and thresholds. Without a total line, only a clear amount near the top is taken. */
export function findAmount(text: string): { amount: number; currency: string } | null {
  const clean = ownText(text);
  const found: { amount: number; currency: string; total: boolean; opening: boolean }[] = [];
  let prev = "";
  let pos = 0;
  for (const line of clean.split(/\n/)) {
    const trimmed = line.trim();
    const start = pos;
    pos += line.length + 1;
    if (!trimmed) continue;
    const prevIgnored = prev.length <= 60 && IGNORE_AMOUNT_LINE.test(prev) && !HAS_AMOUNT.test(prev);
    const ignored = IGNORE_AMOUNT_LINE.test(trimmed) || prevIgnored;
    if (!ignored) {
      const prevTotal = prev.length <= 40 && TOTAL.test(prev) && !SUBTOTAL.test(prev) && !HAS_AMOUNT.test(prev);
      const isTotal = (TOTAL.test(trimmed) && !SUBTOTAL.test(trimmed)) || prevTotal;
      for (const m of trimmed.matchAll(AMOUNT)) {
        const rawCur = (m[1] ?? m[4] ?? "").trim();
        const rawNum = m[2] ?? m[3] ?? "";
        // Bare lowercase "150 km" outside a total line is distance, not Konvertibilna Marka ("150 KM" / "150,00 km").
        if (rawCur === "km" && !isTotal && !/[.,]\d{1,2}$/.test(rawNum)) continue;
        const currency = currencyOf(rawCur);
        const amount = numberOf(rawNum);
        if (!currency || !Number.isFinite(amount) || amount <= 0 || amount > 1_000_000) continue;
        found.push({ amount, currency, total: isTotal, opening: start < 900 });
      }
    }
    prev = trimmed;
  }
  const totals = found.filter((f) => f.total);
  if (totals.length) {
    const pick = totals.reduce((a, b) => (b.amount > a.amount ? b : a));
    return { amount: pick.amount, currency: pick.currency };
  }
  // Without an explicit total label, avoid grabbing a random big number from deep in a statement or promo footer.
  const opening = found.filter((f) => f.opening);
  const distinct = new Set(opening.map((f) => `${f.currency}:${f.amount}`));
  if (distinct.size === 0 || distinct.size > 2) return null;
  const pick = opening.reduce((a, b) => (b.amount > a.amount ? b : a));
  return { amount: pick.amount, currency: pick.currency };
}

/** What kind of paper a mail is, and what it says; null when it is not a real invoice, receipt, order or booking. */
export function readPaper(subject: string, text: string, hasAttachments = false): Paper | null {
  if (REPLY_OR_FWD.test(subject) || NOISE_SUBJECT.test(subject)) return null;
  const body = ownText(text);
  if (NOISE_BODY.test(`${subject}\n${body.slice(0, 900)}`)) return null;
  const subjectKind = KINDS.find(([re]) => re.test(subject))?.[1] ?? null;
  const kind = subjectKind ?? KINDS.find(([re]) => re.test(body.slice(0, 600)))?.[1] ?? null;
  if (!kind) return null;
  const money = findAmount(`${subject}\n${body}`);
  const code = findCodes(`${subject}\n${body}`).find((c) => c.label !== "Tracking" && c.label !== "PIN");
  if (!money) {
    // Without an amount in the text, keep only when the subject itself clearly names a paper with a ref or attachment.
    if (code && subjectKind) return { kind, amount: null, currency: null, reference: code.value };
    if (hasAttachments && ATTACHED_PAPER.test(subject)) return { kind, amount: null, currency: null, reference: null };
    return null;
  }
  return { kind, amount: money.amount, currency: money.currency, reference: code?.value ?? null };
}

/** An amount as people read it: "€11.00", "24,00 KM". */
export function moneyText(amount: number, currency: string): string {
  // Intl writes "BAM 24.00"; at home it is "24,00 KM".
  if (currency === "BAM") return `${amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} KM`;
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

/** The rows as CSV, for a spreadsheet or the accountant. */
export function toCsv(rows: { date: number; from: string; subject: string; paper: Paper }[]): string {
  const cell = (v: string | number | null) => {
    const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const day = (t: number) => {
    const d = new Date(t * 1000);
    return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
  };
  return [
    "Date,From,Subject,Kind,Amount,Currency,Reference",
    ...rows.map((r) =>
      [day(r.date), r.from, r.subject, r.paper.kind, r.paper.amount?.toFixed(2) ?? null, r.paper.currency, r.paper.reference].map(cell).join(","),
    ),
  ].join("\n");
}

/** Each currency's sum, largest first. */
export function sums(items: { paper: Paper }[]): [string, number][] {
  const sum = new Map<string, number>();
  for (const { paper } of items) if (paper.amount != null && paper.currency) sum.set(paper.currency, (sum.get(paper.currency) ?? 0) + paper.amount);
  return [...sum].sort((a, b) => b[1] - a[1]);
}

/** Sums as people read them: "€42.50 · 24,00 KM". */
export const sumsText = (items: { paper: Paper }[]) =>
  sums(items)
    .map(([c, n]) => moneyText(n, c))
    .join(" · ");

/** Senders who sent paper in at least three different months: a subscription, a rent, a monthly bill. */
export function repeating(items: { from: string; date: number }[]): Set<string> {
  const months = new Map<string, Set<string>>();
  for (const i of items) {
    const d = new Date(i.date * 1000);
    const seen = months.get(i.from) ?? new Set<string>();
    seen.add(`${d.getFullYear()}-${d.getMonth()}`);
    months.set(i.from, seen);
  }
  return new Set([...months].filter(([, m]) => m.size >= 3).map(([from]) => from));
}
