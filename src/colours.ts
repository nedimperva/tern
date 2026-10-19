import type { Account } from "./api";

/** Account colours (docs/design/ui.md §2), in the order the accounts were added. */
export const ACCOUNT_COLOURS = ["#5b5bd6", "#2f9e6e", "#d0453f", "#c98a1b", "#0e9bb5", "#b24fb0", "#7a7f8a", "#e07a30"];

export const colourOf = (accounts: Account[], id: number) => {
  const order = [...accounts].sort((a, b) => a.id - b.id).findIndex((a) => a.id === id);
  return ACCOUNT_COLOURS[Math.max(0, order) % ACCOUNT_COLOURS.length];
};
