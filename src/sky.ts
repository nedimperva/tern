// Inbox Zero's sky: the part of the day, the season and the real phase of the moon. Plain functions, unit-tested
// in src/test/zero.test.ts.

/** The moon's age as a share of its 29.53-day cycle: 0 new, 0.5 full. From a known new moon (6 Jan 2000, 18:14
 * UTC); good to a few hours, plenty for a picture. */
export function moonPhase(at: Date) {
  const days = (at.getTime() - Date.UTC(2000, 0, 6, 18, 14)) / 86_400_000;
  const p = (days / 29.530588853) % 1;
  return p < 0 ? p + 1 : p;
}

/** The lit part of a moon at (cx, cy) as an SVG path: the outer edge on the lit side (right while waxing), back
 * along the terminator, an ellipse as wide as the cosine of the phase. */
export function moonPath(phase: number, cx: number, cy: number, r: number) {
  const k = Math.cos(2 * Math.PI * phase);
  const waxing = phase < 0.5;
  const bulgeRight = waxing ? k > 0 : k < 0;
  const rx = Math.max(0.01, Math.abs(k) * r);
  return `M${cx} ${cy - r} A${r} ${r} 0 0 ${waxing ? 1 : 0} ${cx} ${cy + r} A${rx.toFixed(2)} ${r} 0 0 ${bulgeRight ? 0 : 1} ${cx} ${cy - r} Z`;
}

/** The part of the day the sky shows. */
export function skyAt(at: Date): "dawn" | "day" | "dusk" | "night" {
  const h = at.getHours();
  if (h >= 19 || h < 6) return "night";
  if (h < 8) return "dawn";
  if (h >= 17) return "dusk";
  return "day";
}

/** December to February: snow on the water (the north's winter, where most of Tern's people are). */
export const winter = (at: Date) => [11, 0, 1].includes(at.getMonth());
