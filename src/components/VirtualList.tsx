import { createEffect, createMemo, createSignal, For, type JSX, onCleanup, onMount } from "solid-js";

/// Draws only the rows in view (plus a few either side), so 50 rows or 50,000 cost the same.
export function VirtualList<T>(props: {
  items: T[];
  rowHeight: number;
  selected: number;
  /** What a screen reader calls the list. */
  label?: string;
  /** The id of the focused row's element, which a screen reader follows while the list has focus. */
  activeId?: string;
  onEnd?: () => void;
  /** A heading over this row, given the one above it ("Today", "Yesterday"): a quiet line that takes `headingHeight`. */
  heading?: (item: T, above: T | undefined) => string | null;
  headingHeight?: number;
  children: (item: T, index: () => number) => JSX.Element;
}) {
  let el!: HTMLDivElement;
  const [top, setTop] = createSignal(0);
  const [height, setHeight] = createSignal(800);
  const overscan = 8;

  onMount(() => {
    // Read on the next frame: drawing more rows inside the callback can resize the list in the same frame, and the
    // observer then reports a loop.
    const ro = new ResizeObserver(() => requestAnimationFrame(() => setHeight(el.clientHeight)));
    ro.observe(el);
    onCleanup(() => ro.disconnect());
  });

  // Where each row starts, and the headings among them. Without headings a row is at index × height, as before;
  // with them each heading pushes the rows under it down by its height.
  const layout = createMemo(() => {
    const items = props.items;
    const h = props.rowHeight;
    const hh = props.headingHeight ?? 32;
    const heading = props.heading;
    if (!heading) return { tops: null as Float64Array | null, heads: [] as { top: number; text: string }[], total: items.length * h };
    const tops = new Float64Array(items.length);
    const heads: { top: number; text: string }[] = [];
    let y = 0;
    for (let i = 0; i < items.length; i++) {
      const text = heading(items[i], items[i - 1]);
      if (text) {
        heads.push({ top: y, text });
        y += hh;
      }
      tops[i] = y;
      y += h;
    }
    return { tops, heads, total: y };
  });
  const rowTop = (i: number) => layout().tops?.[i] ?? i * props.rowHeight;
  /** The first row whose bottom is below `y`. */
  const rowAt = (y: number) => {
    const tops = layout().tops;
    if (!tops) return Math.floor(y / props.rowHeight);
    let lo = 0;
    let hi = tops.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (tops[mid] + props.rowHeight <= y) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };

  const range = createMemo(() => {
    const start = Math.max(0, rowAt(top()) - overscan);
    const end = Math.min(props.items.length, rowAt(top() + height()) + 1 + overscan);
    return { start, end };
  });
  const visible = createMemo(() => props.items.slice(range().start, range().end));
  const headsInView = createMemo(() => layout().heads.filter((x) => x.top + 64 >= top() - height() && x.top <= top() + height() * 2));

  // Keep the focused row inside the middle 60 % of the view (§5): a step past that band scrolls by that step, so
  // j/k never jump the list by more than a row.
  createEffect(() => {
    const h = props.rowHeight;
    const y = rowTop(props.selected);
    const band = el.clientHeight * 0.2;
    if (y < el.scrollTop + band) el.scrollTop = Math.max(0, y - band);
    else if (y + h > el.scrollTop + el.clientHeight - band) el.scrollTop = y + h - el.clientHeight + band;
  });

  const onScroll = () => {
    setTop(el.scrollTop);
    if (props.onEnd && el.scrollTop + el.clientHeight > el.scrollHeight - props.rowHeight * 50) props.onEnd();
  };

  return (
    <div
      ref={el}
      class="vlist"
      role="listbox"
      aria-label={props.label}
      aria-multiselectable="true"
      aria-activedescendant={props.activeId}
      tabIndex={0}
      onScroll={onScroll}
    >
      <div style={{ height: `${layout().total}px`, position: "relative" }}>
        <For each={headsInView()}>
          {(x) => (
            <div class="vhead" aria-hidden="true" style={{ transform: `translateY(${x.top}px)`, height: `${props.headingHeight ?? 32}px` }}>
              <span>{x.text}</span>
            </div>
          )}
        </For>
        <For each={visible()}>
          {(item, i) => {
            const index = () => range().start + i();
            return (
              <div class="vrow" style={{ transform: `translateY(${rowTop(index())}px)`, height: `${props.rowHeight}px` }}>
                {props.children(item, index)}
              </div>
            );
          }}
        </For>
      </div>
    </div>
  );
}
