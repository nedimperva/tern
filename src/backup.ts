// Tern's setup as one file, to move it to another computer or keep a copy (Settings → Backup). The person picks
// the parts. Accounts are named by address, never by Tern's ids, which differ from one computer to the next.
// Secrets (accounts with their passwords, AI keys, the Todoist token) stay in the system keyring unless ticked;
// then the engine adds them and seals the file with a passphrase (tern_core::backup), so they never pass through
// the window.

import type { Account, Signature, Snippet } from "./api";
import { DEFAULTS, type Settings } from "./settings";

/** What only means something on this computer: when the person was last here, what showed today, the streak. */
const LOCAL: (keyof Settings)[] = ["lastSeen", "dayShown", "zeroLog"];

/** The parts of a backup that are not secret. "senders", "notes" and "styles" live in the engine's database. */
export type Part = "settings" | "snippets" | "signatures" | "senders" | "notes" | "styles";
export const PARTS: Part[] = ["settings", "snippets", "signatures", "senders", "notes", "styles"];

/** What the engine keeps of the person's setup outside settings (tern_core::backup::Data). */
export type BackupData = {
  senders?: { account: string; addr: string; state: string }[];
  notes?: { email: string; body: string }[];
  styles?: { account: string; note: string; samples: number }[];
};

export type Backup = {
  tern: "settings";
  version: 1;
  exported: string;
  /** The parts the person picked; files from before 2.3 have none (see `partsOf`). */
  parts?: Part[];
  settings: Partial<Settings>;
  /** The accounts AI may read, by address (`ai.accounts` holds ids). */
  aiAccounts: string[];
  snippets: { shortcut: string; name: string; body: string; subject: string | null; cc: string[]; account: string | null }[];
  signatures: { account: string; name: string; body: string; html: string | null; custom: boolean; forNew: boolean; forReply: boolean }[];
} & BackupData;

const emailOf = (accounts: Account[], id: number | null) => accounts.find((a) => a.id === id)?.email.toLowerCase() ?? null;

export function makeBackup(
  from: { settings: Settings; accounts: Account[]; snippets: Snippet[]; signatures: Signature[]; data?: BackupData; parts?: Part[] },
  now = new Date(),
): Backup {
  const { settings, accounts } = from;
  const parts = PARTS.filter((p) => (from.parts ?? PARTS).includes(p));
  const has = (p: Part) => parts.includes(p);
  const kept = Object.fromEntries(Object.entries(settings).filter(([k]) => !LOCAL.includes(k as keyof Settings))) as Partial<Settings>;
  const b: Backup = {
    tern: "settings",
    version: 1,
    exported: now.toISOString(),
    parts,
    settings: has("settings") ? { ...kept, ai: { ...settings.ai, accounts: [] } } : {},
    aiAccounts: has("settings") ? settings.ai.accounts.flatMap((id) => emailOf(accounts, id) ?? []) : [],
    snippets: has("snippets")
      ? from.snippets.map((s) => ({ shortcut: s.shortcut, name: s.name, body: s.body, subject: s.subject, cc: s.cc, account: emailOf(accounts, s.accountId) }))
      : [],
    signatures: has("signatures")
      ? from.signatures.flatMap((s) => {
          const account = emailOf(accounts, s.accountId);
          return account ? [{ account, name: s.name, body: s.body, html: s.html, custom: !!s.custom, forNew: s.forNew, forReply: s.forReply }] : [];
        })
      : [],
  };
  if (has("senders")) b.senders = from.data?.senders ?? [];
  if (has("notes")) b.notes = from.data?.notes ?? [];
  if (has("styles")) b.styles = from.data?.styles ?? [];
  return b;
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
  if (b?.tern !== "settings" || typeof b.settings !== "object" || b.settings === null) throw new Error("That file isn't Tern settings.");
  if (b.version !== 1) throw new Error("That file comes from a newer Tern. Update Tern, then import it.");
  const list = <T>(v: T[] | undefined) => (Array.isArray(v) ? v : undefined);
  return {
    ...b,
    parts: Array.isArray(b.parts) ? b.parts.filter((p) => PARTS.includes(p)) : undefined,
    aiAccounts: list(b.aiAccounts) ?? [],
    snippets: list(b.snippets) ?? [],
    signatures: list(b.signatures) ?? [],
    senders: list(b.senders),
    notes: list(b.notes),
    styles: list(b.styles),
  } as Backup;
}

/** The parts a file holds. One from before the picker always had settings, and snippets and signatures when there
 * were any. */
export function partsOf(b: Backup): Part[] {
  if (b.parts) return b.parts;
  return PARTS.filter((p) =>
    p === "settings" ? true : p === "snippets" ? b.snippets.length > 0 : p === "signatures" ? b.signatures.length > 0 : b[p] !== undefined,
  );
}

/** How many of each part a backup holds, for the picker; settings count as one. */
export function countOf(b: Backup, p: Part): number {
  if (p === "settings") return 1;
  return b[p]?.length ?? 0;
}

/** The database parts of a backup that were picked, for the engine to restore. */
export function dataFrom(b: Backup, picked: Part[]): BackupData {
  const out: BackupData = {};
  if (picked.includes("senders") && b.senders) out.senders = b.senders;
  if (picked.includes("notes") && b.notes) out.notes = b.notes;
  if (picked.includes("styles") && b.styles) out.styles = b.styles;
  return out;
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
    // An object setting (Todoist, AI, colours) keeps the defaults for what the file lacks.
    out[key] = typeof fallback === "object" && !Array.isArray(fallback) ? { ...fallback, ...(value as object) } : value;
  }
  if (out.ai) {
    const ids = backup.aiAccounts.flatMap((e) => accounts.find((a) => a.email.toLowerCase() === e.toLowerCase())?.id ?? []);
    out.ai = { ...DEFAULTS.ai, ...(out.ai as Settings["ai"]), accounts: ids };
  }
  return out as Partial<Settings>;
}
