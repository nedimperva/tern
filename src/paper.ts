// Paper trail (idea 115): what a receipt, an invoice, an order or a booking says, read on this computer from the
// mail's own text. Plain functions, unit-tested in src/test/paper.test.ts. Anything not found is left out; nothing
// is sent anywhere.

import { findCodes } from "./facts";

export type PaperKind = "Receipt" | "Invoice" | "Order" | "Booking" | "Payment" | "Subscription";
export type Paper = { kind: PaperKind; amount: number | null; currency: string | null; reference: string | null };

const KINDS: [RegExp, PaperKind][] = [
  [/invoice|faktur|rechnung|račun za|bill\b/i, "Invoice"],
  [/receipt|quittung|potvrda o (plaćanju|uplati)|fiskaln/i, "Receipt"],
  [/subscription|renewal|pretplat/i, "Subscription"],
  [/booking|reservation|ticket|rezervacij|karta|karte|boarding/i, "Booking"],
  [/order|narudžb|bestellung|shipped|poslan/i, "Order"],
  [/payment|paid|uplat|plaćanj|zahlung|račun/i, "Payment"],
];

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
const CUR = "€|\\$|£|eur|usd|gbp|km|bam|kn|hrk|rsd|din\\.?|chf";
const NUM = "\\d{1,3}(?:[.,' ]\\d{3})*(?:[.,]\\d{1,2})?|\\d+(?:[.,]\\d{1,2})?";
const AMOUNT = new RegExp(`(?<![\\p{L}\\d])(?:(${CUR})\\s?(${NUM})|(${NUM})\\s?(${CUR}))(?![\\p{L}\\d])`, "giu");
// The line that holds what was paid or is owed, before any other amount in the mail.
const TOTAL = /total|amount|sum|ukupn|iznos|za (platiti|uplatu)|gesamt|betrag|to pay|paid|due|charged|naplać/i;

function currencyOf(word: string): string | null {
  return CURRENCIES.find(([re]) => re.test(word.trim()))?.[1] ?? null;
}

/** "1.234,56", "1,234.56", "24,00", "19": the number, whichever mark is the decimal one. */
export function numberOf(raw: string): number {
  const s = raw.replace(/['\s]/g, "");
  const lastDot = s.lastIndexOf(".");
  const lastComma = s.lastIndexOf(",");
  const decimal = Math.max(lastDot, lastComma);
  // A mark followed by exactly three digits, with no other kind of mark after it, groups thousands.
  if (decimal < 0 || /^\d{3}$/.test(s.slice(decimal + 1)) && (lastDot < 0 || lastComma < 0)) return Number(s.replace(/[.,]/g, ""));
  return Number(`${s.slice(0, decimal).replace(/[.,]/g, "")}.${s.slice(decimal + 1)}`);
}

/** The amount that matters: on a total's line, else the largest in the mail. */
export function findAmount(text: string): { amount: number; currency: string } | null {
  const found: { amount: number; currency: string; total: boolean }[] = [];
  for (const line of text.split(/\n/)) {
    for (const m of line.matchAll(AMOUNT)) {
      const currency = currencyOf(m[1] ?? m[4] ?? "");
      const amount = numberOf(m[2] ?? m[3] ?? "");
      if (!currency || !Number.isFinite(amount) || amount <= 0 || amount > 1_000_000) continue;
      found.push({ amount, currency, total: TOTAL.test(line) });
    }
  }
  const totals = found.filter((f) => f.total);
  const pick = (totals.length ? totals : found).reduce<(typeof found)[number] | null>((a, b) => (!a || b.amount > a.amount ? b : a), null);
  return pick && { amount: pick.amount, currency: pick.currency };
}

/** What kind of paper a mail is, and what it says; null when it has no amount and no reference (not paper). */
export function readPaper(subject: string, text: string): Paper | null {
  const kind = KINDS.find(([re]) => re.test(subject))?.[1] ?? KINDS.find(([re]) => re.test(text.slice(0, 600)))?.[1];
  if (!kind) return null;
  const money = findAmount(`${subject}\n${text}`);
  const code = findCodes(`${subject}\n${text}`).find((c) => c.label !== "Tracking" && c.label !== "PIN");
  if (!money && !code) return null;
  return { kind, amount: money?.amount ?? null, currency: money?.currency ?? null, reference: code?.value ?? null };
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
