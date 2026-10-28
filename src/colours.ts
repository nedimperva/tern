import type { Account } from "./api";
import { settings } from "./settings";

/** Account colours (docs/design/ui.md §2), in the order the accounts were added. */
export const ACCOUNT_COLOURS = ["#5b5bd6", "#2f9e6e", "#d0453f", "#c98a1b", "#0e9bb5", "#b24fb0", "#7a7f8a", "#e07a30"];
/** What a screen reader says for each of `ACCOUNT_COLOURS`. */
export const COLOUR_NAMES = ["Indigo", "Green", "Red", "Amber", "Teal", "Purple", "Grey", "Orange"];

/** An account's colour: the one picked for it in Settings, else the palette's in the order accounts were added. */
export const colourOf = (accounts: Account[], id: number) => {
  const picked = settings.accountColours[accounts.find((a) => a.id === id)?.email.toLowerCase() ?? ""];
  if (picked) return picked;
  const order = [...accounts].sort((a, b) => a.id - b.id).findIndex((a) => a.id === id);
  return ACCOUNT_COLOURS[Math.max(0, order) % ACCOUNT_COLOURS.length];
};

/** An account's initials for its avatar: from its name, else its address. */
export const accountInitials = (a: Account) => {
  const words = (a.displayName || a.email.split("@")[0]).split(/[\s._-]+/).filter(Boolean);
  return ((words[0]?.[0] ?? "") + (words.length > 1 ? words[words.length - 1][0] : "")).toUpperCase() || "?";
};

/** Gmail label colours don't come over IMAP, so each label gets one from its name: the same label, the same colour,
 * in rows, the conversation, the rail and the picker. */
export const labelColour = (name: string) => {
  let h = 2166136261;
  for (const ch of name) h = Math.imul(h ^ ch.codePointAt(0)!, 16777619);
  return ACCOUNT_COLOURS[(h >>> 0) % ACCOUNT_COLOURS.length];
};
