// Small helpers for keyboard and screen reader use that several components share.

/** Arrow keys move the choice in a group of role="radio" buttons, as they do in a native radio group. Put it on the
 * group's onKeyDown; give the checked radio tabIndex 0 and the others -1, so Tab enters the group once. */
export function radioKeys(e: KeyboardEvent) {
  const step = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 }[e.key];
  if (!step) return;
  const radios = [...(e.currentTarget as HTMLElement).querySelectorAll<HTMLElement>('[role="radio"]')];
  const at = radios.indexOf(document.activeElement as HTMLElement);
  if (at < 0) return;
  e.preventDefault();
  e.stopPropagation();
  const next = radios[(at + step + radios.length) % radios.length];
  next.focus();
  next.click();
}
