import { batch, createMemo, createSignal, For, Show } from "solid-js";

export type Command = {
  name: string;
  keys?: string;
  group?: string;
  run?: () => void;
  /** A command that needs a choice ("Move to …"): Enter or Tab shows these instead, under its name. */
  args?: () => Command[];
};

/**
 * How well `query` matches `text`, and where: a prefix beats letters that start words ("gti" → "Go To Inbox"),
 * which beat letters anywhere in order. Null when the letters are not all there.
 */
export function fuzzy(text: string, query: string): { score: number; at: number[] } | null {
  const t = text.toLowerCase();
  const q = query.toLowerCase().replace(/\s+/g, "");
  if (!q) return { score: 0, at: [] };
  if (t.startsWith(q)) return { score: 3000 - t.length, at: [...q].map((_, i) => i) };
  // Each letter starts a word, or carries on straight after the letter before it.
  const wordStart = (i: number) => i === 0 || /[\s\-/—(.]/.test(t[i - 1]);
  let at: number[] = [];
  let next = 0;
  for (let i = 0; i < t.length && next < q.length; i++) {
    const follows = at.length > 0 && at[at.length - 1] === i - 1;
    if (t[i] === q[next] && (wordStart(i) || follows)) {
      at.push(i);
      next++;
    }
  }
  if (next === q.length) return { score: 2000 - t.length, at };
  at = [];
  next = 0;
  for (let i = 0; i < t.length && next < q.length; i++) {
    if (t[i] === q[next]) {
      at.push(i);
      next++;
    }
  }
  if (next < q.length) return null;
  return { score: 1000 - (at[at.length - 1] - at[0]) - t.length / 10, at };
}

const RECENT_KEY = "tern.palette.recent";

/** The last commands run, newest first. Kept in this window's storage; losing it costs nothing. */
function recent(): string[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
  } catch {
    return [];
  }
}

function remember(name: string) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify([name, ...recent().filter((n) => n !== name)].slice(0, 8)));
  } catch {
    // Private storage off: the palette works, it just forgets.
  }
}

/** Shows `text` with the matched letters marked. */
function Marked(props: { text: string; at: number[] }) {
  const set = () => new Set(props.at);
  return (
    <span>
      <For each={[...props.text]}>{(ch, i) => (set().has(i()) ? <mark>{ch}</mark> : ch)}</For>
    </span>
  );
}

/** Ctrl+K: every command, found by typing a few letters of it (docs/design/ui.md §4.3). */
export function CommandBar(props: { commands: Command[]; onClose: () => void; /** Open in this command's choices. */ start?: string }) {
  const [query, setQuery] = createSignal("");
  const [index, setIndex] = createSignal(0);
  // The command whose choices are showing, if any (argument mode, §4.3).
  const [parent, setParent] = createSignal<Command | null>(props.commands.find((c) => c.name === props.start && c.args) ?? null);
  const remembered = recent();
  const list = () => parent()?.args?.() ?? props.commands;

  const matches = createMemo(() => {
    const q = query().trim();
    if (parent() && !q) return list().map((c) => ({ c, at: [] as number[], group: "" }));
    if (!q) {
      // Recent first, then everything in its group's order.
      const byName = new Map(list().map((c) => [c.name, c]));
      const first = remembered.flatMap((n) => byName.get(n) ?? []).map((c) => ({ c, at: [], group: "Recent" }));
      const rest = list()
        .filter((c) => !remembered.includes(c.name))
        .map((c) => ({ c, at: [] as number[], group: c.group ?? "Actions" }));
      return [...first, ...rest];
    }
    return list()
      .flatMap((c) => {
        const m = fuzzy(c.name, q);
        // A command run before gets a little ahead of an equal match.
        return m ? [{ c, at: m.at, group: "", score: m.score + (remembered.includes(c.name) ? 50 : 0) }] : [];
      })
      .sort((a, b) => b.score - a.score);
  });

  const enter = (c: Command) => {
    remember(c.name);
    batch(() => (setParent(c), setQuery(""), setIndex(0)));
  };

  const run = (c?: Command) => {
    if (!c) return;
    if (c.args) return enter(c);
    if (!parent()) remember(c.name);
    props.onClose();
    c.run?.();
  };

  let rowsEl!: HTMLUListElement;
  /** The highlighted row in sight after an arrow key, its group's heading too when it is the group's first. */
  const reveal = () =>
    queueMicrotask(() => {
      const row = rowsEl.querySelector<HTMLElement>("li.active");
      const head = row?.previousElementSibling;
      if (head?.classList.contains("group")) head.scrollIntoView({ block: "nearest" });
      row?.scrollIntoView({ block: "nearest" });
    });

  const onKeyDown = (e: KeyboardEvent) => {
    // Esc steps back out of a command's choices before it closes the palette.
    if (e.key === "Escape") parent() && !props.start ? batch(() => (setParent(null), setQuery(""), setIndex(0))) : props.onClose();
    else if (e.key === "Tab" && matches()[index()]?.c.args) enter(matches()[index()].c);
    else if (e.key === "ArrowDown" || (e.key === "n" && e.ctrlKey)) (setIndex(Math.min(index() + 1, matches().length - 1)), reveal());
    else if (e.key === "ArrowUp" || (e.key === "p" && e.ctrlKey)) (setIndex(Math.max(index() - 1, 0)), reveal());
    else if (e.key === "Enter") run(matches()[index()]?.c);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: a click beside the dialog closes it, as Esc does
    <div class="overlay" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div class="command-bar" role="dialog" aria-modal="true" aria-label="Commands">
        <div class="head">
          <Show when={parent()}>
            <span class="context">{parent()!.name.replace(/ …$/, "")}</span>
          </Show>
          <input
            ref={(el) => queueMicrotask(() => el.focus())}
            placeholder={parent() ? "Choose" : "Type a command"}
            value={query()}
            onInput={(e) => (setQuery(e.currentTarget.value), setIndex(0))}
            onKeyDown={onKeyDown}
          />
        </div>
        <ul ref={rowsEl}>
          <For each={matches()} fallback={<li class="none">No command matches</li>}>
            {(m, i) => (
              <>
                <Show when={m.group && m.group !== matches()[i() - 1]?.group}>
                  <li class="group">{m.group}</li>
                </Show>
                <li
                  classList={{ active: i() === index() }}
                  onMouseEnter={() => setIndex(i())}
                  onMouseDown={() => run(m.c)}
                >
                  <Marked text={m.c.name} at={m.at} />
                  <Show when={m.c.keys}>
                    <span class="caps">
                      <For each={m.c.keys!.split(" then ")}>
                        {(part, k) => (
                          <>
                            <Show when={k() > 0}>
                              <span class="then">then</span>
                            </Show>
                            <kbd>{part}</kbd>
                          </>
                        )}
                      </For>
                    </span>
                  </Show>
                </li>
              </>
            )}
          </For>
        </ul>
      </div>
    </div>
  );
}
