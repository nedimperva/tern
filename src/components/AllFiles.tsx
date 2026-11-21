// All files (idea 108): every attachment received or sent, newest first, by kind and by name. Space shows one in
// Tern's viewer, Enter opens its mail. Read from this computer; nothing is downloaded until a file is shown.

import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { api, type PersonFile } from "../api";
import { open } from "../app/conversation";
import { asRow } from "../app/rows";
import { setFilesOpen, setViewing, viewing } from "../app/state";
import { KINDS, kindOf } from "./Companion";
import { when } from "./ConversationRow";

const kb = (n: number) => (n > 1_000_000 ? `${(n / 1_000_000).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1000))} kB`);

export function AllFiles() {
  const [files, setFiles] = createSignal<PersonFile[] | null>(null);
  const [typed, setTyped] = createSignal("");
  const [kind, setKind] = createSignal("all");
  const [index, setIndex] = createSignal(0);
  void api.allFiles().then(setFiles, () => setFiles([]));
  const kinds = createMemo(() => {
    const n = new Map<string, number>();
    for (const f of files() ?? []) n.set(kindOf(f.name, f.mime)[1], (n.get(kindOf(f.name, f.mime)[1]) ?? 0) + 1);
    return [...n].sort((a, b) => b[1] - a[1]);
  });
  const shown = createMemo(() => {
    const words = typed().trim().toLowerCase().split(/\s+/).filter(Boolean);
    return (files() ?? []).filter(
      (f) =>
        (kind() === "all" || kindOf(f.name, f.mime)[1] === kind()) &&
        words.every((w) => `${f.name} ${f.from} ${f.subject}`.toLowerCase().includes(w)),
    );
  });
  const close = () => setFilesOpen(false);
  const show = async (f: PersonFile | undefined) => {
    if (!f) return;
    try {
      const m = (await api.thread(f.messageId)).find((x) => x.id === f.messageId);
      if (m) setViewing({ message: m, index: f.index });
    } catch {
      // A message that left since the list opened is skipped.
    }
  };
  const openMail = async (f: PersonFile | undefined) => {
    if (!f) return;
    try {
      const m = (await api.messageRows([f.messageId]))[0];
      if (!m) return;
      setViewing(null);
      close();
      void open(asRow(m), false);
    } catch {
      // A message that left since the list opened is skipped.
    }
  };
  let list!: HTMLDivElement;
  const point = (i: number) => {
    setIndex(Math.max(0, Math.min(shown().length - 1, i)));
    list.querySelector(`[data-i="${index()}"]`)?.scrollIntoView({ block: "nearest" });
  };
  const onKey = (e: KeyboardEvent) => {
    if (viewing()) return;
    const typing = e.target instanceof HTMLInputElement;
    if (e.key === "Escape") close();
    else if (e.key === "ArrowDown") point(index() + 1);
    else if (e.key === "ArrowUp") point(index() - 1);
    else if (e.key === "Enter") void openMail(shown()[index()]);
    else if (e.key === " " && (!typing || !typed())) void show(shown()[index()]);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };
  onMount(() => window.addEventListener("keydown", onKey, true));
  onCleanup(() => window.removeEventListener("keydown", onKey, true));

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: a click beside the dialog closes it, as Esc does
    <div class="overlay" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div class="all-files" role="dialog" aria-modal="true" aria-label="All files">
        <header>
          <h2>Files</h2>
          <input
            ref={(el) => queueMicrotask(() => el.focus())}
            placeholder="Find a file by name, sender or subject"
            value={typed()}
            onInput={(e) => (setTyped(e.currentTarget.value), setIndex(0))}
          />
          <button type="button" class="close" onClick={close} aria-label="Close">
            <kbd>Esc</kbd>
          </button>
        </header>
        <Show when={kinds().length > 1}>
          <fieldset class="kinds" aria-label="Kind of file">
            <button type="button" aria-pressed={kind() === "all"} onClick={() => (setKind("all"), setIndex(0))}>
              All {files()?.length}
            </button>
            <For each={kinds()}>
              {([k, n]) => (
                <button type="button" aria-pressed={kind() === k} onClick={() => (setKind(k), setIndex(0))}>
                  {KINDS[k]} {n}
                </button>
              )}
            </For>
          </fieldset>
        </Show>
        <div class="rows" ref={list} role="listbox" aria-label="Files">
          <Show when={files()} fallback={<p class="quiet">Reading your mail…</p>}>
            <For each={shown()} fallback={<p class="quiet">{files()!.length ? "No file by those words." : "No files in your mail yet."}</p>}>
              {(f, i) => {
                const [tag, tint] = kindOf(f.name, f.mime);
                return (
                  // biome-ignore lint/a11y/useFocusableInteractive: the keys stay in the search field, which points here
                  <div
                    class="file"
                    role="option"
                    data-i={i()}
                    aria-selected={i() === index()}
                    classList={{ active: i() === index() }}
                    onMouseEnter={() => setIndex(i())}
                    onMouseDown={() => void show(f)}
                    onDblClick={() => void openMail(f)}
                  >
                    <span class={`tile ${tint}`}>{tag}</span>
                    <span class="what">
                      <span class="name">{f.name}</span>
                      <span class="quiet">
                        {f.mine ? "You sent it" : f.from} · {f.subject || "(no subject)"}
                      </span>
                    </span>
                    <span class="size">{kb(f.size)}</span>
                    <span class="date">{when(f.date)}</span>
                  </div>
                );
              }}
            </For>
          </Show>
        </div>
        <footer>
          <span>
            <kbd>Space</kbd> show it · <kbd>Enter</kbd> open its mail
          </span>
          <span class="quiet">Files in Trash and Spam are left out.</span>
        </footer>
      </div>
    </div>
  );
}
