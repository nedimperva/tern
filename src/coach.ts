// The keyboard coach (idea 136): after the third click on something that has a key, one quiet line says the key.
// Never twice for one key; Settings → General turns it off. Keys pressed are remembered so the shortcut sheet can
// lift the ones never tried.

import type { Binding } from "./keys";
import { keyLabel } from "./keys";
import { setSetting, settings } from "./settings";

const CLICKS = 3;

/** A key was pressed: remembered once, for the shortcut sheet. */
export function noteKey(keys: string) {
  if (!keys || settings.keysUsed.includes(keys)) return;
  setSetting("keysUsed", [...settings.keysUsed, keys]);
}

/** The key a clicked control names: a keycap inside it, else "(E)" or "(Ctrl+.)" at the end of its label. */
export function keyOfControl(el: Element): string | null {
  const cap = el.querySelector("kbd")?.textContent?.trim();
  if (cap) return cap;
  const said = [el.getAttribute("title"), el.getAttribute("aria-label"), el.getAttribute("data-tip")].find((t) => t && /\(([^()]{1,12})\)\s*$/.test(t));
  return said?.match(/\(([^()]{1,12})\)\s*$/)?.[1].trim() ?? null;
}

/** How a label reads when compared: "Ctrl+." and "Ctrl ." and "ctrl ." are one key. */
const plain = (label: string) => label.replace(/\+/g, " ").replace(/\s+/g, " ").trim().toLowerCase();

/** The binding a control's key label stands for, if any. Letters compare by case: "E" on a keycap is Shift E only
 * when the binding says so, since keycaps show capitals. */
export function bindingFor(label: string, all: Binding[]): Binding | undefined {
  const want = plain(label);
  return all.find((b) => b.keys && !b.hidden && plain(keyLabel(b.keys)) === want) ?? all.find((b) => b.keys && b.keys.toLowerCase() === want);
}

/** Counts clicks on controls with a key; on the third, `tell` gets the line to show. Returns the listener's undo. */
export function watchClicks(all: () => Binding[], tell: (text: string) => void): () => void {
  const onClick = (e: MouseEvent) => {
    if (!settings.keyTips || e.detail === 0) return; // detail 0: Enter or Space on a focused button, not a click
    const el = e.target instanceof Element ? e.target.closest("button, [role=menuitem], [role=tab], a[href]") : null;
    if (!el) return;
    const label = keyOfControl(el);
    const b = label ? bindingFor(label, all()) : undefined;
    if (!b || settings.keyTipsTold.includes(b.keys) || settings.keysUsed.includes(b.keys)) return;
    const n = (settings.keyClicks[b.keys] ?? 0) + 1;
    if (n < CLICKS) return setSetting("keyClicks", { ...settings.keyClicks, [b.keys]: n });
    const { [b.keys]: _, ...rest } = settings.keyClicks;
    setSetting("keyClicks", rest);
    setSetting("keyTipsTold", [...settings.keyTipsTold, b.keys]);
    tell(`Next time, ${keyLabel(b.keys)} does this`);
  };
  document.addEventListener("click", onClick, true);
  return () => document.removeEventListener("click", onClick, true);
}
