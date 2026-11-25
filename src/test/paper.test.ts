// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { findAmount, numberOf, readPaper, toCsv } from "../paper";

describe("paper trail", () => {
  it("reads numbers either way round", () => {
    expect(numberOf("1.234,56")).toBe(1234.56);
    expect(numberOf("1,234.56")).toBe(1234.56);
    expect(numberOf("24,00")).toBe(24);
    expect(numberOf("1,200")).toBe(1200);
    expect(numberOf("19")).toBe(19);
  });

  it("takes the total over the lines above it and reads table-split totals", () => {
    expect(findAmount("Flat white x2  €7.80\nCroissant  €3.20\nTotal: €11.00")).toEqual({ amount: 11, currency: "EUR" });
    expect(findAmount("Subtotal: €10.00\nVAT: €2.00\nTotal\n€12.00")).toEqual({ amount: 12, currency: "EUR" });
    expect(findAmount("Total paid: 24,00 KM")).toEqual({ amount: 24, currency: "BAM" });
    expect(findAmount("Amount due: $19.00")).toEqual({ amount: 19, currency: "USD" });
    expect(findAmount("Meet at 10:00 in room 4")).toBeNull();
  });

  it("ignores credit offers, limits, balances, promo caps and engineering standards/units", () => {
    expect(
      findAmount("Hvala na narudžbi.\nUkupno za platiti: 45,20 KM\n\nIskoristite gotovinski kredit do 100.000 KM!"),
    ).toEqual({ amount: 45.2, currency: "BAM" });
    expect(findAmount("Ostvarite gotovinski kredit do 100.000,00 KM uz najnižu kamatu.")).toBeNull();
    expect(findAmount("Raspoloživo stanje računa: 14.200,00 KM\nOdobreni limit: 50.000 KM")).toBeNull();
    expect(findAmount("naruči gore M16x50 DIN 933 8.8. kom 200 matica 200 i podloško 400")).toBeNull();
    expect(findAmount("M16 x 50 DIN 933 8.8, nosivost 200 kN, udaljenost 150 km")).toBeNull();
    expect(findAmount("Ukupno: 1.500,00 din.")).toEqual({ amount: 1500, currency: "RSD" });
  });

  it("knows a receipt, an invoice and a booking, and leaves other mail", () => {
    expect(readPaper("Your receipt from Corner Coffee", "Order number: CC-88231\nTotal: €11.00")).toEqual({
      kind: "Receipt",
      amount: 11,
      currency: "EUR",
      reference: "CC-88231",
    });
    expect(readPaper("Invoice INV-2026-1142 for November", "Amount due: $19.00")?.kind).toBe("Invoice");
    expect(readPaper("Your tickets: Sarajevo to Mostar", "Booking reference: RX4K9Q\nTotal paid: 24,00 KM")?.kind).toBe("Booking");
    expect(readPaper("Faktura 2026-041", "U prilogu dostavljamo fakturu za oktobar.", true)).toEqual({
      kind: "Invoice",
      amount: null,
      currency: null,
      reference: null,
    });
    expect(
      readPaper(
        "Mjesečni račun za oktobar",
        "Period od 01.10.2026 do 31.10.2026 — Ukupno za platiti do 15.11.2026: 45,00 KM",
      ),
    ).toEqual({
      kind: "Invoice",
      amount: 45,
      currency: "BAM",
      reference: null,
    });
    expect(readPaper("Your receipt from Apple (iOS App)", "Plaćeno kreditnom karticom: €9.99")).toEqual({
      kind: "Receipt",
      amount: 9.99,
      currency: "EUR",
      reference: null,
    });
    expect(readPaper("In order to plan the offsite", "See you Thursday")).toBeNull();
  });

  it("drops overdue payment reminders, bank statements, credit offers, replies and account security notices", () => {
    expect(
      readPaper("Uplata faktura", "Poštovani,\nMolim vas uplatu isteklih faktura u vrijednosti 30.000,00 KM.\nHvala"),
    ).toBeNull();
    expect(
      readPaper(
        "Mjesečni izvod po računu",
        "Vaš izvod po računu je u prilogu.\nSpecijalna ponuda: gotovinski kredit do 100.000 KM.",
      ),
    ).toBeNull();
    expect(
      readPaper("Re: Faktura 2026-041", "Hvala, plaćeno 1.250,00 KM\n\nOn 1 Nov, Ana wrote:\n> Ukupno: 1.250,00 KM"),
    ).toBeNull();
    expect(readPaper("Sigurnosno upozorenje za vaš Google račun", "Prijava na račun sa novog uređaja.")).toBeNull();
    expect(readPaper("Ponuda br. 44/2026", "Ukupno: 8.500,00 KM")).toBeNull();
  });

  it("writes CSV a spreadsheet opens", () => {
    const csv = toCsv([{ date: 1_790_000_000, from: "Shop, Ltd", subject: 'The "best" order', paper: { kind: "Order", amount: 18.5, currency: "EUR", reference: null } }]);
    expect(csv.split("\n")[1]).toBe('2026-09-21,"Shop, Ltd","The ""best"" order",Order,18.50,EUR,');
  });
});
