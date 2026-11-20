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

  it("takes the total over the lines above it", () => {
    expect(findAmount("Flat white x2  €7.80\nCroissant  €3.20\nTotal: €11.00")).toEqual({ amount: 11, currency: "EUR" });
    expect(findAmount("Total paid: 24,00 KM")).toEqual({ amount: 24, currency: "BAM" });
    expect(findAmount("Amount due: $19.00")).toEqual({ amount: 19, currency: "USD" });
    expect(findAmount("Meet at 10:00 in room 4")).toBeNull();
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
    expect(readPaper("In order to plan the offsite", "See you Thursday")).toBeNull();
  });

  it("writes CSV a spreadsheet opens", () => {
    const csv = toCsv([{ date: 1_790_000_000, from: "Shop, Ltd", subject: 'The "best" order', paper: { kind: "Order", amount: 18.5, currency: "EUR", reference: null } }]);
    expect(csv.split("\n")[1]).toBe('2026-09-21,"Shop, Ltd","The ""best"" order",Order,18.50,EUR,');
  });
});
