import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { setSetting, settings } from "../settings";

/** "Save these people as a group" (idea 126): a name, and who is in it (everyone in the conversation but you, to
 * start). Typing the name in To or Cc then brings them all in. Kept in settings, on this computer. */
export function GroupDialog(props: { people: { email: string; name: string }[]; suggested: string; onClose: (saved?: string) => void }) {
  const [name, setName] = createSignal(props.suggested);
  const [out, setOut] = createSignal<string[]>([]);
  const [index, setIndex] = createSignal(0);
  const chosen = () => props.people.filter((p) => !out().includes(p.email)).map((p) => p.email);
  const same = () => settings.groups.find((g) => g.name.toLowerCase() === name().trim().toLowerCase());
  const toggle = (email: string) => setOut(out().includes(email) ? out().filter((e) => e !== email) : [...out(), email]);
  const save = () => {
    const n = name().trim();
    if (!n || !chosen().length) return;
    setSetting("groups", [...settings.groups.filter((g) => g !== same()), { name: n, emails: chosen() }]);
    props.onClose(n);
  };
  const onKeyDown = (e: KeyboardEvent) => {
    const n = props.people.length;
    if (e.key === "Escape") props.onClose();
    else if (e.key === "Enter") save();
    else if (e.key === "ArrowDown" && n) setIndex((index() + 1) % n);
    else if (e.key === "ArrowUp" && n) setIndex((index() - 1 + n) % n);
    else if (e.key === " " && e.ctrlKey && n) toggle(props.people[index()].email);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };
  onMount(() => window.addEventListener("keydown", onKeyDown, true));
  onCleanup(() => window.removeEventListener("keydown", onKeyDown, true));
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: a click beside the dialog closes it, as Esc does
    <div class="overlay" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div class="command-bar snooze group-dialog" role="dialog" aria-modal="true" aria-label="Save as a group">
        <div class="head">
          <span class="context">Group</span>
          <input
            ref={(el) => queueMicrotask(() => (el.focus(), el.select()))}
            placeholder="Name it, such as Design team"
            value={name()}
            onInput={(e) => setName(e.currentTarget.value)}
          />
        </div>
        <ul>
          <For each={props.people}>
            {(p, i) => (
              <li classList={{ active: i() === index(), off: out().includes(p.email) }} onMouseEnter={() => setIndex(i())} onMouseDown={(e) => (e.preventDefault(), toggle(p.email))}>
                <span class="label-name">
                  <span class="tick" aria-hidden="true">
                    {out().includes(p.email) ? "" : "✓"}
                  </span>
                  {p.name || p.email}
                  <Show when={p.name}>
                    <span class="addr">{p.email}</span>
                  </Show>
                </span>
              </li>
            )}
          </For>
        </ul>
        <p class="snooze-note">
          <Show when={same()} fallback={`${chosen().length === 1 ? "1 person" : `${chosen().length} people`}. Enter saves; type the name in To to bring them all in.`}>
            Enter replaces the group “{same()!.name}”.
          </Show>{" "}
          Click someone to leave them out.
        </p>
      </div>
    </div>
  );
}
