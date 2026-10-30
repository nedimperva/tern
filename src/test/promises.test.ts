// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { dueIn, promisesIn } from "../promises";

const at = Math.floor(new Date(2026, 9, 26, 10).getTime() / 1000);
const m = (id: number, fromAddr: string, fromName: string, bodyText: string) => ({ id, fromAddr, fromName, bodyText, snippet: "", date: at });
const mine = (a: string) => a === "me@x.com";

describe("promises in a conversation", () => {
  const thread = [
    m(1, "ana@x.com", "Ana Rossi", "Hi,\n\nCan you confirm the EU totals by Thursday?\n\nI will send the board pack on Friday.\n\nAna"),
    m(2, "me@x.com", "Me", "Sure. I'll check the numbers tomorrow morning.\n\nOn Mon, Ana wrote:\n> Can you confirm the EU totals?"),
  ];
  const found = promisesIn(thread, mine);

  it("splits what you owe from what is owed to you", () => {
    expect(found.filter((p) => p.yours).map((p) => [p.who, p.text])).toEqual([
      ["Ana", "Can you confirm the EU totals by Thursday?"],
      ["You", "I'll check the numbers tomorrow morning."],
    ]);
    expect(found.filter((p) => !p.yours).map((p) => [p.who, p.text])).toEqual([["Ana", "I will send the board pack on Friday."]]);
  });

  it("reads the day it is due and leaves quotes alone", () => {
    // Sent on Monday 26 October: "by Thursday" is the 29th, "on Friday" the 30th, "tomorrow" the 27th.
    expect(new Date(found[0].due! * 1000).getDate()).toBe(29);
    expect(new Date(found[1].due! * 1000).getDate()).toBe(30);
    expect(new Date(found[2].due! * 1000).getDate()).toBe(27);
    expect(dueIn("Whenever suits you.", at)).toBeNull();
    expect(found).toHaveLength(3);
    expect(new Set(found.map((p) => p.key)).size).toBe(3);
  });

  it("reads Bosnian words whole", () => {
    const bs = promisesIn(
      [
        m(3, "me@x.com", "Me", "Ovo je za pištolj, za pumpu koju ćemo koristiti za farbanje mosta na Ostrošcu."),
        m(4, "jasna@x.com", "Jasna", "Možeš li poslati konačan broj u četvrtak?\n\nPoslat ću ponudu sutra."),
      ],
      mine,
    );
    expect(bs.map((p) => [p.who, p.yours, p.text])).toEqual([
      ["Jasna", true, "Možeš li poslati konačan broj u četvrtak?"],
      ["Jasna", false, "Poslat ću ponudu sutra."],
    ]);
    // Sent on Monday 26 October: "u četvrtak" is the 29th.
    expect(new Date(bs[0].due! * 1000).getDate()).toBe(29);
  });

  it("leaves out what goes with the mail itself, and reads the joined future", () => {
    const bs = promisesIn(
      [
        m(5, "me@x.com", "Me", "Sve što trenutno mogu pročitati na njemu je Graco MAX WPR 4050, a u prilogu šaljem i sliku.\n\nUplatu šaljem odmah."),
        m(6, "gama@x.com", "GamaTrade", "Ok, poslacu sutra brzom postom.\n\nPozdrav iz ulice Titove, za jedinicu u Konjicu."),
      ],
      mine,
    );
    expect(bs.map((p) => [p.who, p.yours, p.text])).toEqual([
      ["You", true, "Uplatu šaljem odmah."],
      ["GamaTrade", false, "Ok, poslacu sutra brzom postom."],
    ]);
    expect(new Date(bs[1].due! * 1000).getDate()).toBe(27);
  });
});
