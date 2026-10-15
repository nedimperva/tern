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
  /** Each account's signature, by account id. Plain text for now. */
  signatures: Record<string, string>;
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
  /** The inbox in two splits, Important and Other, rather than one list. */
  splitInbox: boolean;
  /** In dark mode, designed mail (newsletters, receipts) darkened like the rest, or left in its own colours. */
  darkMail: "darken" | "original";
};

export const DEFAULTS: Settings = {
  theme: "system",
  density: "dense",
  openMode: "auto",
  readAfterMs: 1000,
  loadImages: "ask",
  imagesFrom: [],
  sendDelay: 5,
  signatures: {},
  signatureBelow: false,
  background: true,
  notify: true,
  splitInbox: true,
  darkMail: "darken",
};

export const ROW_HEIGHTS: Record<Settings["density"], number> = { dense: 36, comfortable: 44, spacious: 52 };

const [settings, setStore] = createStore<Settings>({ ...DEFAULTS });
export { settings };

/** Loads what was saved; until then the defaults apply. */
export async function loadSettings() {
  const saved = await api.settings();
  for (const key of Object.keys(DEFAULTS) as (keyof Settings)[]) {
    if (key in saved) setStore(key, saved[key] as never);
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
    root.dataset.density = settings.density;
  }),
);
