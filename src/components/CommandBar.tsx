import { createMemo, createSignal, For } from "solid-js";

export type Command = { name: string; keys?: string; run: () => void };

/// Ctrl+K: every command, found by typing a few letters of it.
export function CommandBar(props: { commands: Command[]; onClose: () => void }) {
  const [query, setQuery] = createSignal("");
  const [index, setIndex] = createSignal(0);
  const matches = createMemo(() => {
    const q = query().toLowerCase();
    return props.commands.filter((c) => {
      let at = 0;
      const name = c.name.toLowerCase();
      for (const ch of q) {
        at = name.indexOf(ch, at) + 1;
        if (!at) return false;
      }
      return true;
    });
  });

  const run = (c?: Command) => {
    if (!c) return;
    props.onClose();
    c.run();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") props.onClose();
    else if (e.key === "ArrowDown") setIndex(Math.min(index() + 1, matches().length - 1));
    else if (e.key === "ArrowUp") setIndex(Math.max(index() - 1, 0));
    else if (e.key === "Enter") run(matches()[index()]);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <div class="overlay" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div class="command-bar">
        <input
          autofocus
          ref={(el) => queueMicrotask(() => el.focus())}
          placeholder="Type a command"
          value={query()}
          onInput={(e) => (setQuery(e.currentTarget.value), setIndex(0))}
          onKeyDown={onKeyDown}
        />
        <ul>
          <For each={matches()}>
            {(c, i) => (
              <li classList={{ active: i() === index() }} onMouseEnter={() => setIndex(i())} onMouseDown={() => run(c)}>
                <span>{c.name}</span>
                {c.keys && <kbd>{c.keys}</kbd>}
              </li>
            )}
          </For>
        </ul>
      </div>
    </div>
  );
}
