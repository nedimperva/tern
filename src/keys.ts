// One table of keys for the whole app (docs/design/ui.md §5). Each binding names its key, the context it works in,
// and what it does; the command palette lists the same table, so every key can be found there.

/** Where the keyboard is: the conversation list, or an open conversation. */
export type Context = "list" | "conversation";

export type Binding = {
  /** As `keyName` writes it: "j", "J" (Shift+J), "Ctrl+k", "Enter", or a chord "g i". */
  keys: string;
  name: string;
  /** Works only here; anywhere when left out. */
  context?: Context;
  run: () => unknown;
  /** Left out of the palette (arrow-key twins of letter keys and the like). */
  hidden?: boolean;
};

/** A keydown as bindings name it. Shift shows in the letter's case ("J"), so it is only spelt out with Ctrl. */
export function keyName(e: KeyboardEvent): string {
  const key = e.key.length === 1 && (e.ctrlKey || e.metaKey) ? e.key.toLowerCase() : e.key;
  if (e.ctrlKey || e.metaKey) return `Ctrl+${e.shiftKey && key.length === 1 ? key.toUpperCase() : key}`;
  return key;
}

/** How a binding's keys read on a keycap: "Shift J", "Ctrl K", "G then I". */
export function keyLabel(keys: string): string {
  if (keys.includes(" ")) return keys.split(" ").map((k) => k.toUpperCase()).join(" then ");
  const [mod, key] = keys.startsWith("Ctrl+") ? ["Ctrl ", keys.slice(5)] : ["", keys];
  const shift = key.length === 1 && key !== key.toLowerCase() ? "Shift " : "";
  const names: Record<string, string> = { ArrowDown: "↓", ArrowUp: "↑", Escape: "Esc", "\\": "\\" };
  return `${mod}${shift}${names[key] ?? (key.length === 1 ? key.toUpperCase() : key)}`;
}

/** Whether the event comes from somewhere typing happens, where single keys must not act. */
export function typing(e: KeyboardEvent): boolean {
  const t = e.target;
  if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement) return true;
  return t instanceof HTMLElement && t.isContentEditable;
}

/**
 * A keydown handler for `bindings`. Chords: after a key that starts one ("g"), the next key completes it; anything
 * else cancels it. Bindings for the current context win over context-free ones with the same key.
 */
export function keyHandler(bindings: () => Binding[], context: () => Context, blocked: () => boolean) {
  let pending = "";
  return (e: KeyboardEvent) => {
    const name = keyName(e);
    const all = bindings();
    // Ctrl+K opens the palette from anywhere, the search field included; everything else waits while a dialog is
    // open or someone is typing (Ctrl+A there selects the text, not every conversation).
    if (name !== "Ctrl+k" && (blocked() || typing(e))) return;
    if (["Shift", "Control", "Alt", "Meta"].includes(e.key)) return;
    const keys = pending ? `${pending} ${name}` : name;
    pending = "";
    const fits = (b: Binding) => b.keys === keys && (!b.context || b.context === context());
    const found = all.find((b) => fits(b) && b.context) ?? all.find((b) => fits(b));
    if (found) {
      e.preventDefault();
      found.run();
      return;
    }
    if (all.some((b) => b.keys.startsWith(`${name} `))) {
      pending = name;
      e.preventDefault();
    }
  };
}
