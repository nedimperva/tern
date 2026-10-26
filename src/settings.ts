// The person's settings: defaults here, changes kept by the engine (`settings` table) and applied at once.

import { createEffect, createRoot, createSignal } from "solid-js";
import { createStore } from "solid-js/store";
import { api } from "./api";

export type Settings = {
  /** "system" follows the desktop's light or dark. */
  theme: "system" | "light" | "dark";
  density: "dense" | "comfortable" | "spacious";
  /** "auto": beside the list in a wide window, over it in a narrow one. */
  openMode: "auto" | "split" | "full";
  /** How long a conversation stays open before it counts as read; -1 = only when marked by hand. */
  readAfterMs: number;
  /** Remote images in mail: blocked until asked for, or always loaded. */
  loadImages: "ask" | "always";
  /** In replies: the signature above the quoted message (as most people read it), or below it. */
  signatureBelow: boolean;
  /** Seconds a sent message waits before it goes, so Undo can stop it. */
  sendDelay: number;
  /** Senders whose remote images always load ("Always for this sender"), lowercase. */
  imagesFrom: string[];
  /** Closing the window leaves Tern running in the tray, syncing and notifying. */
  background: boolean;
  /** A notification when new mail reaches the inbox (read by the engine too). */
  notify: boolean;
  /** Notify for the inbox's Other split as well as Important (read by the engine). */
  notifyOther: boolean;
  /** Quiet hours, "HH:MM" local time; no notifications from one to the other. Empty: none (read by the engine). */
  quietFrom: string;
  quietTo: string;
  /** The inbox in two splits, Important and Other, rather than one list. */
  splitInbox: boolean;
  /** In dark mode, designed mail (newsletters, receipts) darkened like the rest, or left in its own colours. */
  darkMail: "darken" | "original";
  /** Company logos in place of initials, fetched from each sender's own website. Off: it tells them you read. */
  senderLogos: boolean;
  /** Before sending, warn when the text says something is attached and nothing is. */
  attachmentCheck: boolean;
  /** The person's own words for that, besides the built-in ones (src/attachmentWords.ts). */
  attachmentWords: string[];
  /** Inbox Zero's scene: "rotate" for a different one each day, or always the same one (src/zero.ts). */
  zeroScene: string;
  /** Per local day ("2026-10-20"): conversations cleared from the inbox in Tern, and whether it reached zero. */
  zeroLog: Record<string, { cleared: number; zero: boolean }>;
  /** Optional AI, read by the engine too, which refuses what it does not allow (tern_core::ai::AiSettings). */
  ai: AiSettings;
};

export type AiSettings = {
  enabled: boolean;
  model: string;
  summaries: boolean;
  writing: boolean;
  /** Addresses and phone numbers in mail become [email] and [phone] before it is sent. */
  redact: boolean;
  /** Tokens a UTC day may use; 0 for no limit. */
  dailyTokens: number;
  /** Accounts whose mail and drafts may be sent. */
  accounts: number[];
};

export const DEFAULTS: Settings = {
  theme: "system",
  density: "dense",
  openMode: "auto",
  readAfterMs: 1000,
  loadImages: "ask",
  imagesFrom: [],
  sendDelay: 5,
  signatureBelow: false,
  background: true,
  notify: true,
  notifyOther: false,
  quietFrom: "",
  quietTo: "",
  splitInbox: true,
  darkMail: "darken",
  senderLogos: false,
  attachmentCheck: true,
  attachmentWords: [],
  zeroScene: "rotate",
  zeroLog: {},
  ai: {
    enabled: false,
    model: "claude-opus-5-5",
    summaries: true,
    writing: true,
    redact: true,
    dailyTokens: 200_000,
    accounts: [],
  },
};

/** Whether AI may be offered for this feature on this account (the engine checks again). */
export const aiOn = (feature: "summaries" | "writing", accountId: number | undefined) =>
  settings.ai.enabled && settings.ai[feature] && accountId != null && settings.ai.accounts.includes(accountId);

export const ROW_HEIGHTS: Record<Settings["density"], number> = { dense: 36, comfortable: 44, spacious: 52 };

const [settings, setStore] = createStore<Settings>({ ...DEFAULTS });
export { settings };

/** Loads what was saved; until then the defaults apply. */
export async function loadSettings() {
  const saved = await api.settings();
  for (const key of Object.keys(DEFAULTS) as (keyof Settings)[]) {
    // AI settings gain fields over time; the ones saved before take the defaults.
    if (key === "ai" && key in saved) setStore("ai", { ...DEFAULTS.ai, ...(saved.ai as Partial<AiSettings>) });
    else if (key in saved) setStore(key, saved[key] as never);
  }
}

export function setSetting<K extends keyof Settings>(key: K, value: Settings[K]) {
  setStore(key, value as never);
  void api.setSetting(key, value);
}

const scheme = window.matchMedia("(prefers-color-scheme: dark)");
const [systemDark, setSystemDark] = createSignal(scheme.matches);
scheme.addEventListener("change", (e) => setSystemDark(e.matches));
/** Whether Tern is drawn dark now: the setting, or the desktop's when it follows the system. */
export const isDark = () => settings.theme === "dark" || (settings.theme === "system" && systemDark());

// The theme goes on <html>, where the tokens read it; "system" leaves it to prefers-color-scheme.
createRoot(() =>
  createEffect(() => {
    const root = document.documentElement;
    if (settings.theme === "system") delete root.dataset.theme;
    else root.dataset.theme = settings.theme;
    // The title bar too, or a dark Tern on a light Windows has a white bar on top.
    api.setWindowTheme(settings.theme === "system" ? null : settings.theme);
    root.dataset.density = settings.density;
  }),
);
