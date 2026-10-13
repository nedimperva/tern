import { createEffect, createMemo, createSignal, For, JSX, onCleanup, onMount } from "solid-js";

/// Draws only the rows in view (plus a few either side), so 50 rows or 50,000 cost the same.
export function VirtualList<T>(props: {
  items: T[];
  rowHeight: number;
  selected: number;
  onEnd?: () => void;
  children: (item: T, index: () => number) => JSX.Element;
}) {
  let el!: HTMLDivElement;
  const [top, setTop] = createSignal(0);
  const [height, setHeight] = createSignal(800);
  const overscan = 8;

  onMount(() => {
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
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

  // Keep the selected row on screen when the keyboard moves it.
  createEffect(() => {
    const y = props.selected * props.rowHeight;
    if (y < el.scrollTop) el.scrollTop = y;
    else if (y + props.rowHeight > el.scrollTop + el.clientHeight) el.scrollTop = y + props.rowHeight - el.clientHeight;
  });

  const onScroll = () => {
    setTop(el.scrollTop);
    if (props.onEnd && el.scrollTop + el.clientHeight > el.scrollHeight - props.rowHeight * 20) props.onEnd();
  };

  return (
    <div ref={el} class="vlist" onScroll={onScroll}>
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
