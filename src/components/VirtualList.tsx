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

  const range = createMemo(() => {
    const h = props.rowHeight;
    const start = Math.max(0, Math.floor(top() / h) - overscan);
    const end = Math.min(props.items.length, Math.ceil((top() + height()) / h) + overscan);
    return { start, end };
  });
  const visible = createMemo(() => props.items.slice(range().start, range().end));

  // Keep the focused row inside the middle 60 % of the view (§5): a step past that band scrolls by that step, so
  // j/k never jump the list by more than a row.
  createEffect(() => {
    const h = props.rowHeight;
    const y = props.selected * h;
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
      <div style={{ height: `${props.items.length * props.rowHeight}px`, position: "relative" }}>
        <For each={visible()}>
          {(item, i) => {
            const index = () => range().start + i();
            return (
              <div class="vrow" style={{ transform: `translateY(${index() * props.rowHeight}px)`, height: `${props.rowHeight}px` }}>
                {props.children(item, index)}
              </div>
            );
          }}
        </For>
      </div>
    </div>
  );
}
