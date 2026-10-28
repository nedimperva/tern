// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { Account, Signature, Snippet } from "../api";
import { makeBackup, readBackup, settingsFrom } from "../backup";
import { DEFAULTS } from "../settings";

// settings.ts watches the desktop's dark mode as it loads; jsdom has no matchMedia.
vi.hoisted(() => {
  window.matchMedia = (() => ({ matches: false, addEventListener() {} })) as never;
});

const account = (id: number, email: string) => ({ id, email, displayName: "" }) as Account;
const here = [account(1, "ada@example.com"), account(2, "Ada@Work.example")];
const snippet: Snippet = { id: 4, shortcut: "thx", name: "Thanks", body: "Thanks!", accountId: 2, subject: null, cc: [], used: 9, lastUsed: 1 };
const signature: Signature = { id: 7, accountId: 1, name: "Main", body: "Ada", html: null, forNew: true, forReply: false };

describe("settings backup", () => {
  it("names accounts by address and leaves out what only this computer knows", () => {
    const settings = { ...DEFAULTS, lastSeen: 123, savedSearches: ["is:unread"], ai: { ...DEFAULTS.ai, accounts: [2] } };
    const b = makeBackup(settings, here, [snippet], [signature], new Date(0));
    expect(b.settings.lastSeen).toBeUndefined();
    expect(b.settings.savedSearches).toEqual(["is:unread"]);
    expect(b.aiAccounts).toEqual(["ada@work.example"]);
    expect(b.snippets[0]).toEqual({ shortcut: "thx", name: "Thanks", body: "Thanks!", subject: null, cc: [], account: "ada@work.example" });
    expect(b.signatures[0]).toMatchObject({ account: "ada@example.com", forNew: true });
    expect(JSON.stringify(b)).not.toContain('"used"');
  });

  it("reads back only known settings of the right kind, with this computer's accounts", () => {
    const b = makeBackup({ ...DEFAULTS, ai: { ...DEFAULTS.ai, enabled: true, accounts: [2] } }, here, [], []);
    b.settings = { ...b.settings, sendDelay: "lots" as never, theme: "dark", unknown: 1 } as never;
    const elsewhere = [account(5, "ada@work.example")];
    const taken = settingsFrom(readBackup(JSON.stringify(b)), elsewhere);
    expect(taken.theme).toBe("dark");
    expect("sendDelay" in taken).toBe(false);
    expect("unknown" in taken).toBe(false);
    expect(taken.ai).toMatchObject({ enabled: true, accounts: [5] });
  });

  it("says when a file is not Tern settings", () => {
    expect(() => readBackup("{}")).toThrow("isn't Tern settings");
    expect(() => readBackup("not json")).toThrow("isn't Tern settings");
    expect(() => readBackup('{"tern":"settings","version":2,"settings":{}}')).toThrow("newer Tern");
  });
});
