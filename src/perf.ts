// Numbers that keep us honest (package 02): how long a key takes to show on screen, and how long list queries
// take. Kept for the overlay (Ctrl+Shift+P); in development a slow one is also logged.

import { createSignal } from "solid-js";

/** Targets from docs/PLAN.md: a keypress shows within 50 ms; a list page answers within 16 ms (one frame). */
const KEY_TARGET_MS = 50;
const QUERY_TARGET_MS = 16;

const keys: number[] = [];
const [keyStats, setKeyStats] = createSignal({ last: 0, p50: 0, p95: 0, count: 0 });
const [lastQuery, setLastQuery] = createSignal(0);
export { keyStats, lastQuery };

function percentile(sorted: number[], p: number) {
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : 0;
}

/**
 * Times a keypress to the paint that shows its effect: from the event's own timestamp to the first frame after
 * the handler ran (the callback of the second animation frame runs after that frame was painted).
 */
export function timeKey(e: KeyboardEvent) {
  const start = e.timeStamp;
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      const ms = performance.now() - start;
      keys.push(ms);
      if (keys.length > 500) keys.shift();
      const sorted = [...keys].sort((a, b) => a - b);
      setKeyStats({ last: ms, p50: percentile(sorted, 0.5), p95: percentile(sorted, 0.95), count: keys.length });
      if (import.meta.env.DEV && ms > KEY_TARGET_MS) console.warn(`key ${e.key} took ${ms.toFixed(1)} ms to show`);
    }),
  );
}

/** Times a list query, round trip to the engine included. Takes the call, not its promise, so work done before the
 * first await (the browser fake does it all there) is counted too. */
export async function timeQuery<T>(query: () => Promise<T>): Promise<T> {
  const start = performance.now();
  const result = await query();
  const ms = performance.now() - start;
  setLastQuery(ms);
  if (import.meta.env.DEV && ms > QUERY_TARGET_MS) console.warn(`list query took ${ms.toFixed(1)} ms`);
  return result;
}
