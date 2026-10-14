import { createSignal, onCleanup, onMount } from "solid-js";
import { keyStats, lastQuery } from "../perf";

/** Ctrl+Shift+P: key-to-paint times, the last list query, and frames a second. */
export function PerfOverlay() {
  const [fps, setFps] = createSignal(0);
  let frames = 0;
  let raf = 0;
  const count = () => {
    frames++;
    raf = requestAnimationFrame(count);
  };
  onMount(() => {
    raf = requestAnimationFrame(count);
    const timer = window.setInterval(() => (setFps(frames), (frames = 0)), 1000);
    onCleanup(() => (clearInterval(timer), cancelAnimationFrame(raf)));
  });
  const ms = (n: number) => `${n.toFixed(1)} ms`;
  return (
    <div class="perf" aria-hidden="true">
      <div>
        key → paint {ms(keyStats().last)} · p50 {ms(keyStats().p50)} · p95 {ms(keyStats().p95)} ({keyStats().count})
      </div>
      <div>
        list query {ms(lastQuery())} · {fps()} fps
      </div>
    </div>
  );
}
