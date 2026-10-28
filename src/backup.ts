// Settings, snippets and signatures as one file, to move them to another computer or keep a copy (Settings →
// Backup). Accounts are named by address, never by Tern's ids, which differ from one computer to the next.
// Passwords and AI keys stay in the system keyring and are never in the file.

import type { Account, Signature, Snippet } from "./api";
import { DEFAULTS, type Settings } from "./settings";

/** What only means something on this computer: when the person was last here, what showed today, the streak. */
const LOCAL: (keyof Settings)[] = ["lastSeen", "dayShown", "lineHidden", "zeroLog"];

export type Backup = {
  tern: "settings";
  version: 1;
  exported: string;
  settings: Partial<Settings>;
  /** The accounts AI may read, by address (`ai.accounts` holds ids). */
  aiAccounts: string[];
  snippets: { shortcut: string; name: string; body: string; subject: string | null; cc: string[]; account: string | null }[];
  signatures: { account: string; name: string; body: string; html: string | null; custom: boolean; forNew: boolean; forReply: boolean }[];
};

const emailOf = (accounts: Account[], id: number | null) => accounts.find((a) => a.id === id)?.email.toLowerCase() ?? null;

export function makeBackup(settings: Settings, accounts: Account[], snippets: Snippet[], signatures: Signature[], now = new Date()): Backup {
  const kept = Object.fromEntries(Object.entries(settings).filter(([k]) => !LOCAL.includes(k as keyof Settings))) as Partial<Settings>;
  return {
    tern: "settings",
    version: 1,
    exported: now.toISOString(),
    settings: { ...kept, ai: { ...settings.ai, accounts: [] } },
    aiAccounts: settings.ai.accounts.flatMap((id) => emailOf(accounts, id) ?? []),
    snippets: snippets.map((s) => ({ shortcut: s.shortcut, name: s.name, body: s.body, subject: s.subject, cc: s.cc, account: emailOf(accounts, s.accountId) })),
    signatures: signatures.flatMap((s) => {
      const account = emailOf(accounts, s.accountId);
      return account ? [{ account, name: s.name, body: s.body, html: s.html, custom: !!s.custom, forNew: s.forNew, forReply: s.forReply }] : [];
    }),
  };
}

/** The file's contents as a backup, or why not. */
export function readBackup(text: string): Backup {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("That file isn't Tern settings.");
  }
  const b = data as Partial<Backup>;
  if (!b || b.tern !== "settings" || typeof b.settings !== "object") throw new Error("That file isn't Tern settings.");
  if (b.version !== 1) throw new Error("That file comes from a newer Tern. Update Tern, then import it.");
  return { ...b, aiAccounts: b.aiAccounts ?? [], snippets: b.snippets ?? [], signatures: b.signatures ?? [] } as Backup;
}

/** The settings from a backup that may be taken: known names, with values of the right kind. AI keeps its
 * defaults for fields the file lacks, and the accounts it may read are this computer's ones the file names. */
export function settingsFrom(backup: Backup, accounts: Account[]): Partial<Settings> {
  const out: Partial<Record<keyof Settings, unknown>> = {};
  for (const [key, value] of Object.entries(backup.settings) as [keyof Settings, unknown][]) {
    const fallback = DEFAULTS[key];
    if (fallback === undefined || LOCAL.includes(key)) continue;
    const sameKind = Array.isArray(fallback) ? Array.isArray(value) : typeof value === typeof fallback && value !== null;
    if (!sameKind) continue;
    out[key] = value;
  }
  if (out.ai) {
    const ids = backup.aiAccounts.flatMap((e) => accounts.find((a) => a.email.toLowerCase() === e.toLowerCase())?.id ?? []);
    out.ai = { ...DEFAULTS.ai, ...(out.ai as Settings["ai"]), accounts: ids };
  }
  return out as Partial<Settings>;
}
