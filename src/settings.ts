// The person's settings: defaults here, changes kept by the engine (`settings` table) and applied at once.

import { createEffect, createRoot, createSignal } from "solid-js";
import { createStore } from "solid-js/store";
import { api, type AiProvider } from "./api";

export type Settings = {
  /** The mood: "system" picks Dawn or Dusk from the desktop's light or dark; "light" is Dawn, "dark" Dusk, "sea"
   * Night Sea, and "omarchy" follows the Omarchy theme (Linux), or the system without one. */
  theme: "system" | "light" | "dark" | "sea" | "omarchy";
  density: "dense" | "comfortable" | "spacious";
  /** The sidebar (accounts and folders) stays open beside the list in a wide enough window. */
  sidebar: boolean;
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
  /** A soft wing beat when mail leaves the outbox. */
  wingBeat: boolean;
  /** Quiet hours, "HH:MM" local time; no notifications from one to the other. Empty: none (read by the engine). */
  quietFrom: string;
  quietTo: string;
  /** The inbox in two splits, Important and Other, rather than one list. */
  splitInbox: boolean;
  /** The column beside a conversation is shown (`i` hides it until shown again). */
  readingColumn: boolean;
  /** The column beside a conversation: when, where, what is asked, codes and links found in the newest message. */
  readingFacts: boolean;
  /** Newsletters (designed mail from a list) open in reading view. */
  newsletterReading: boolean;
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
  /** The start of the day: the morning screen on a day's first open and the line above the inbox, only the
   * line, or neither. */
  dayStart: "screen" | "line" | "off";
  /** When the person was last here (Unix seconds): the start of the day counts from it. */
  lastSeen: number;
  /** The local day the morning screen last showed ("2026-10-26"), so it shows once a day. */
  dayShown: string;
  /** The local day the line above the inbox was put away. */
  lineHidden: string;
  /** Searches kept in the rail and the command palette, as typed. */
  savedSearches: string[];
  /** Colours picked for accounts, by address (lowercase), in place of the palette's (src/colours.ts). */
  accountColours: Record<string, string>;
  /** What each account notifies for, by address (lowercase); one not here follows `notify` and `notifyOther`
   * (read by the engine). */
  notifyAccounts: Record<string, NotifyMode>;
  /** Optional AI, read by the engine too, which refuses what it does not allow (tern_core::ai::AiSettings). */
  ai: AiSettings;
};

export type NotifyMode = "off" | "important" | "all";

export type AiSettings = {
  enabled: boolean;
  /** The provider and model a feature uses when none is picked for it. */
  provider: AiProvider;
  model: string;
  /** The model each feature uses, from any provider with a key (see `aiRoute`). */
  uses: Partial<Record<AiFeatureKey, AiRoute>>;
  /** Providers agreed to receive mail; empty in settings from before there were several (then `provider`). */
  agreed: AiProvider[];
  summaries: boolean;
  writing: boolean;
  /** Suggested replies in a conversation. */
  replies: boolean;
  /** Write with AI and suggested replies follow the account's style note, once one is learned. */
  voice: boolean;
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
  sidebar: true,
  openMode: "auto",
  readAfterMs: 1000,
  loadImages: "ask",
  imagesFrom: [],
  sendDelay: 5,
  signatureBelow: false,
  background: true,
  notify: true,
  wingBeat: false,
  notifyOther: false,
  quietFrom: "",
  quietTo: "",
  splitInbox: true,
  darkMail: "darken",
  readingColumn: true,
  readingFacts: true,
  newsletterReading: true,
  senderLogos: false,
  attachmentCheck: true,
  attachmentWords: [],
  zeroScene: "rotate",
  zeroLog: {},
  dayStart: "screen",
  lastSeen: 0,
  dayShown: "",
  lineHidden: "",
  savedSearches: [],
  accountColours: {},
  notifyAccounts: {},
  ai: {
    enabled: false,
    provider: "anthropic",
    model: "claude-opus-5-5",
    uses: {},
    agreed: [],
    summaries: true,
    writing: true,
    replies: true,
    voice: true,
    redact: true,
    dailyTokens: 200_000,
    accounts: [],
  },
};

export type AiFeatureKey = "summaries" | "replies" | "writing" | "style";
export type AiRoute = { provider: AiProvider; model: string };

/** Each provider's quick, cheap model, for the short everyday work. Matches `Provider::small_model`. */
const SMALL_MODEL: Record<AiProvider, string> = {
  anthropic: "claude-haiku-5-5",
  openai: "gpt-6-luna",
  gemini: "gemini-flash-latest",
};

/** The model a feature uses: the one picked for it, else the default provider's (its small model for summaries
 * and replies). Matches `ai::route` in the engine. */
export function aiRoute(s: AiSettings, feature: AiFeatureKey): AiRoute {
  const picked = s.uses[feature];
  if (picked) return picked;
  return feature === "summaries" || feature === "replies"
    ? { provider: s.provider, model: SMALL_MODEL[s.provider] }
    : { provider: s.provider, model: s.model };
}

/** Whether AI may be offered for this feature on this account (the engine checks again). */
export const aiOn = (feature: "summaries" | "writing" | "replies", accountId: number | undefined) =>
  settings.ai.enabled && settings.ai[feature] && accountId != null && settings.ai.accounts.includes(accountId);

/** Beside an open conversation a row takes two lines (names and date, then the subject): this much taller. */
export const SPLIT_ROW_EXTRA = 20;

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

/** Inside the quiet hours (Settings → Notifications), when sounds keep quiet too. */
export function quietNow(at = new Date()) {
  const { quietFrom: from, quietTo: to } = settings;
  if (!from || !to) return false;
  const now = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
  return from <= to ? now >= from && now < to : now >= from || now < to;
}

export function setSetting<K extends keyof Settings>(key: K, value: Settings[K]) {
  setStore(key, value as never);
  void api.setSetting(key, value);
}

const scheme = window.matchMedia("(prefers-color-scheme: dark)");
const [systemDark, setSystemDark] = createSignal(scheme.matches);
scheme.addEventListener("change", (e) => setSystemDark(e.matches));
const [omarchy, setOmarchy] = createSignal<Record<string, string> | null>(null);
void api.omarchyTheme().then(setOmarchy, () => {});
api.onOmarchyTheme(setOmarchy);
/** Whether there is an Omarchy theme to follow, so the choice is only offered where it does something. */
export const omarchyAvailable = () => omarchy() !== null;

/** The Omarchy colours while following them; without Omarchy the mood falls back to the system's. */
const following = () => (settings.theme === "omarchy" ? omarchy() : null);

/** Whether Tern is drawn dark now: the mood, or the desktop's when it follows the system. */
export const isDark = () => {
  const o = following();
  if (o) return o.mode !== "light";
  return settings.theme === "dark" || settings.theme === "sea" || (settings.theme !== "light" && systemDark());
};

/** Omarchy's colours on Tern's tokens, the way its own T3 Code template maps them: the sidebar on
 * `dark_background`, borders from `muted`, the rest mixed so text keeps its contrast. */
function omarchyTokens(o: Record<string, string>): Record<string, string> {
  const bg = o.background;
  const fg = o.foreground;
  const accent = o.accent ?? o.blue ?? fg;
  const muted = o.muted ?? `color-mix(in srgb, ${fg} 30%, ${bg})`;
  const mix = (a: string, b: string, pct: number) => `color-mix(in srgb, ${a} ${pct}%, ${b})`;
  return {
    "--bg-0": bg,
    "--bg-1": o.dark_background ?? bg,
    "--bg-2": mix(fg, o.dark_background ?? bg, 7),
    "--bg-3": o.selection ?? mix(fg, bg, 14),
    "--fg-0": o.bright_foreground ?? fg,
    "--fg-1": fg,
    "--fg-2": mix(fg, bg, 75),
    "--line": mix(muted, bg, 40),
    "--line-strong": muted,
    "--card": mix(fg, bg, 4),
    "--soft": mix(fg, bg, 4),
    "--soft-hover": mix(fg, bg, 8),
    "--accent": accent,
    "--accent-fg": light(accent) ? "#111111" : "#ffffff",
    "--accent-soft": mix(accent, bg, 18),
    "--ok": o.green ?? "#3fbf85",
    "--ok-soft": mix(o.green ?? "#3fbf85", bg, 15),
    "--warn": o.yellow ?? "#e0a63a",
    "--warn-soft": mix(o.yellow ?? "#e0a63a", bg, 15),
    "--warn-fg": mix(o.yellow ?? "#e0a63a", fg, 70),
    "--danger": o.red ?? "#ef6b66",
    "--star": o.yellow ?? "#f2c94c",
    "--tip": o.bright_foreground ?? fg,
    "--tip-fg": bg,
  };
}

/** Whether dark text reads better than white on this colour (relative luminance past the midpoint). */
function light(hex: string) {
  const c = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255);
  const [r, g, b] = c.map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.179;
}

let painted: string[] = [];

// The mood goes on <html>, where the tokens read it: data-theme is light or dark (every dark rule keys on it) and
// data-mood names Night Sea or Omarchy. "system" leaves the theme to prefers-color-scheme.
createRoot(() =>
  createEffect(() => {
    const root = document.documentElement;
    const o = following();
    const mood = settings.theme === "omarchy" && !o ? "system" : settings.theme;
    if (mood === "system") delete root.dataset.theme;
    else root.dataset.theme = isDark() ? "dark" : "light";
    if (mood === "sea" || mood === "omarchy") root.dataset.mood = mood;
    else delete root.dataset.mood;
    for (const name of painted) root.style.removeProperty(name);
    const tokens = o ? omarchyTokens(o) : {};
    for (const [name, value] of Object.entries(tokens)) root.style.setProperty(name, value);
    painted = Object.keys(tokens);
    // The title bar too, or a dark Tern on a light Windows has a white bar on top.
    api.setWindowTheme(mood === "system" ? null : isDark() ? "dark" : "light");
    root.dataset.density = settings.density;
  }),
);
