// Files (idea 108, a screen since 2026-11-21, board "Files and Paper trail screens", A): every file received or
// sent, in the place of the list and the open mail, by day like the mail list. Chips filter by mail date, sender,
// kind, received or sent, size and account; the picked file shows beside the list with the mail it came in, or the
// files lay out as a grid. Read from this computer: nothing downloads until a file is shown, opened or saved.

import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import { api, type MessageRow, type PersonFile } from "../api";
import { open } from "../app/conversation";
import { asRow } from "../app/rows";
import { accounts, docked, openRow, setFilesOpen, setViewing, toggleSidebar, viewing } from "../app/state";
import { type DateRange, rangeLabel, span } from "../dateRange";
import { dayHeading } from "../listDays";
import { setSetting, settings } from "../settings";
import { KINDS, kindOf } from "./Companion";
import { when } from "./ConversationRow";
import { Chip, Choices, chipOpen, DatePanel, Ticks } from "./Filters";
import { Icon } from "./Icon";

const kb = (n: number) => (n > 1_000_000 ? `${(n / 1_000_000).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1000))} kB`);
const SIZES = [
  { value: "any", label: "Any size", min: 0 },
  { value: "1", label: "Over 1 MB", min: 1_000_000 },
  { value: "10", label: "Over 10 MB", min: 10_000_000 },
];
const WAYS = [
  { value: "all", label: "Received and sent" },
  { value: "received", label: "Received" },
  { value: "sent", label: "Sent by me" },
];
const kindOfFile = (f: PersonFile) => kindOf(f.name, f.mime);
/** "Ada Lovelace", "Ada Lovelace, Grace Hopper", "Ada Lovelace and 2 more". */
const names = (picked: string[]) => (picked.length <= 2 ? picked.join(", ") : `${picked[0]} and ${picked.length - 1} more`);

export function FilesScreen() {
  const [range, setRange] = createSignal<DateRange>({ kind: "any" });
  const [files, setFiles] = createSignal<PersonFile[] | null>(null);
  const [from, setFrom] = createSignal<string[]>([]);
  const [kinds, setKinds] = createSignal<string[]>([]);
  const [way, setWay] = createSignal("all");
  const [size, setSize] = createSignal("any");
  const [account, setAccount] = createSignal("all");
  const [typed, setTyped] = createSignal("");
  const [index, setIndex] = createSignal(0);
  const grid = () => settings.filesView === "grid";

  // The date is asked of the engine, so a month long ago is reached past the newest few thousand files.
  createEffect(
    on(range, (r) => {
      const { since, until } = span(r);
      setFiles(null);
      void api.allFiles(since, until).then(setFiles, () => setFiles([]));
    }),
  );

  /** Everything but the filter being counted, so a chip's counts say what picking it would show. */
  const passes = (f: PersonFile, skip?: "from" | "kind") => {
    if (skip !== "from" && from().length && !from().includes(f.mine ? "You" : f.from)) return false;
    if (skip !== "kind" && kinds().length && !kinds().includes(kindOfFile(f)[1])) return false;
    if (way() === "received" && f.mine) return false;
    if (way() === "sent" && !f.mine) return false;
    if (f.size < (SIZES.find((s) => s.value === size())?.min ?? 0)) return false;
    if (account() !== "all" && String(f.accountId) !== account()) return false;
    const words = typed().trim().toLowerCase().split(/\s+/).filter(Boolean);
    return words.every((w) => `${f.name} ${f.from} ${f.subject}`.toLowerCase().includes(w));
  };
  const shown = createMemo(() => (files() ?? []).filter((f) => passes(f)));
  const count = (skip: "from" | "kind", of: (f: PersonFile) => string) => {
    const n = new Map<string, number>();
    for (const f of files() ?? []) if (passes(f, skip)) n.set(of(f), (n.get(of(f)) ?? 0) + 1);
    return [...n].sort((a, b) => b[1] - a[1]);
  };
  const senders = createMemo(() => count("from", (f) => (f.mine ? "You" : f.from)).map(([v, c]) => ({ value: v, label: v === "You" ? "You (sent by me)" : v, count: c })));
  const kindCounts = createMemo(() => count("kind", (f) => kindOfFile(f)[1]).map(([v, c]) => ({ value: v, label: KINDS[v] ?? v, count: c })));
  const anySet = () => range().kind !== "any" || from().length > 0 || kinds().length > 0 || way() !== "all" || size() !== "any" || account() !== "all";
  const clearAll = () => (setRange({ kind: "any" }), setFrom([]), setKinds([]), setWay("all"), setSize("any"), setAccount("all"));
  // A changed filter starts at the top.
  createEffect(on([shown], () => setIndex(0), { defer: true }));

  const picked = () => shown()[index()];
  const close = () => setFilesOpen(false);
  const show = async (f: PersonFile | undefined) => {
    if (!f) return;
    try {
      const m = (await api.thread(f.messageId)).find((x) => x.id === f.messageId);
      if (m) setViewing({ message: m, index: f.index });
    } catch {
      // A message that left since the screen opened is skipped.
    }
  };
  const openMail = async (f: PersonFile | undefined) => {
    if (!f) return;
    try {
      const m = (await api.messageRows([f.messageId]))[0];
      if (!m) return;
      close();
      void open(asRow(m), false);
    } catch {
      // As above.
    }
  };

  let list!: HTMLDivElement;
  let search!: HTMLInputElement;
  /** Cards in a row of the grid, for ↑ and ↓. */
  const across = () => (grid() ? Math.max(1, Math.round(list.clientWidth / 196)) : 1);
  const point = (i: number) => {
    setIndex(Math.max(0, Math.min(shown().length - 1, i)));
    list.querySelector(`[data-i="${index()}"]`)?.scrollIntoView({ block: "nearest" });
  };
  const onKey = (e: KeyboardEvent) => {
    if (viewing() || chipOpen()) return;
    const typing = e.target instanceof HTMLInputElement;
    if (e.key === "Escape") {
      if (typing && typed()) setTyped("");
      else close();
    } else if (e.key === "ArrowDown") point(index() + across());
    else if (e.key === "ArrowUp") point(index() - across());
    else if (e.key === "ArrowRight" && grid() && !typing) point(index() + 1);
    else if (e.key === "ArrowLeft" && grid() && !typing) point(index() - 1);
    else if (e.key === "Enter") void openMail(picked());
    else if (e.key === " " && (!typing || !typed())) void show(picked());
    else if (e.key === "/" && !typing) search.focus();
    else return;
    e.preventDefault();
    e.stopPropagation();
  };
  onMount(() => window.addEventListener("keydown", onKey, true));
  onCleanup(() => window.removeEventListener("keydown", onKey, true));

  return (
    <section class="tool-screen files-screen" aria-label="Files">
      <header class="screen-head" data-tauri-drag-region="deep">
        <Show when={!docked()}>
          <button type="button" class="icon-button" onClick={toggleSidebar} title="Show the sidebar (Ctrl+\)" aria-label="Show the sidebar">
            <Icon name="panel-left" size={17} />
          </button>
        </Show>
        <button type="button" class="icon-button" onClick={close} title="Back to the mail (Esc)" aria-label="Back to the mail">
          <Icon name="arrow-left" size={17} />
        </button>
        <h1>Files</h1>
        <span class="count">
          {files() === null ? "" : shown().length === files()!.length ? shown().length.toLocaleString() : `${shown().length.toLocaleString()} of ${files()!.length.toLocaleString()}`}
        </span>
        <span class="spacer" />
        <label class="screen-find">
          <Icon name="search" size={14} />
          <input ref={search} placeholder="Find by name, sender or subject" value={typed()} onInput={(e) => setTyped(e.currentTarget.value)} aria-label="Find a file" />
          <kbd>/</kbd>
        </label>
        <div class="view-switch">
          <button type="button" aria-pressed={!grid()} class="icon-button" classList={{ on: !grid() }} onClick={() => setSetting("filesView", "list")} title="A list with a preview" aria-label="List">
            <Icon name="list" size={16} />
          </button>
          <button type="button" aria-pressed={grid()} class="icon-button" classList={{ on: grid() }} onClick={() => setSetting("filesView", "grid")} title="A grid of cards" aria-label="Grid">
            <Icon name="grid" size={16} />
          </button>
        </div>
      </header>

      <div class="screen-chips">
        <Chip label={rangeLabel(range())} icon="calendar" set={range().kind !== "any"} onClear={() => setRange({ kind: "any" })}>
          {(done) => <DatePanel value={range()} onChange={setRange} presets={["any", "today", "week", "month", "3months", "year", "lastyear"]} around={openRow()?.date ?? null} close={done} />}
        </Chip>
        <Chip label={from().length ? `From ${names(from())}` : "From anyone"} set={from().length > 0} onClear={() => setFrom([])}>
          {() => <Ticks items={senders()} picked={from()} onChange={setFrom} find="Find a person" />}
        </Chip>
        <Chip label={kinds().length ? kinds().map((k) => KINDS[k] ?? k).join(", ") : "Any kind"} set={kinds().length > 0} onClear={() => setKinds([])}>
          {() => <Ticks items={kindCounts()} picked={kinds()} onChange={setKinds} />}
        </Chip>
        <Chip label={WAYS.find((w) => w.value === way())!.label} set={way() !== "all"} onClear={() => setWay("all")}>
          {(done) => <Choices items={WAYS} value={way()} onChange={(v) => (setWay(v), done())} />}
        </Chip>
        <Chip label={SIZES.find((s) => s.value === size())!.label} set={size() !== "any"} onClear={() => setSize("any")}>
          {(done) => <Choices items={SIZES} value={size()} onChange={(v) => (setSize(v), done())} />}
        </Chip>
        <Show when={accounts().length > 1}>
          <Chip
            label={account() === "all" ? "All accounts" : (accounts().find((a) => String(a.id) === account())?.email ?? "An account")}
            set={account() !== "all"}
            onClear={() => setAccount("all")}
          >
            {(done) => (
              <Choices
                items={[{ value: "all", label: "All accounts" }, ...accounts().map((a) => ({ value: String(a.id), label: a.email }))]}
                value={account()}
                onChange={(v) => (setAccount(v), done())}
              />
            )}
          </Chip>
        </Show>
        <Show when={anySet()}>
          <button type="button" class="link clear" onClick={clearAll}>
            Clear
          </button>
        </Show>
      </div>

      <div class="screen-body" classList={{ grid: grid() }}>
        <div class="screen-list" ref={list} role="listbox" aria-label="Files">
          <Show when={files()} fallback={<p class="quiet empty">Reading your mail…</p>}>
            <Show
              when={shown().length}
              fallback={
                <p class="quiet empty">
                  {files()!.length ? "No file matches these filters." : range().kind === "any" ? "No files in your mail yet." : `No files in ${rangeLabel(range()).toLowerCase()}.`}
                </p>
              }
            >
              <Show when={grid()} fallback={<FileRows files={shown()} index={index()} onPoint={setIndex} onShow={show} onOpen={openMail} />}>
                <FileGrid files={shown()} index={index()} onPoint={setIndex} onShow={show} onOpen={openMail} />
              </Show>
            </Show>
          </Show>
        </div>
        <Show when={!grid() && picked()} keyed>
          {(f) => <Preview file={f} others={(files() ?? []).filter((x) => x.messageId === f.messageId && x.index !== f.index)} onShow={show} onOpen={openMail} />}
        </Show>
      </div>

      <footer class="screen-foot">
        <span>
          <kbd>↑</kbd> <kbd>↓</kbd> move · <kbd>Space</kbd> show it · <kbd>Enter</kbd> open its mail · <kbd>Esc</kbd> back to the mail
        </span>
        <span class="quiet">Files in Trash and Spam are left out.</span>
      </footer>
    </section>
  );
}

type Rows = { files: PersonFile[]; index: number; onPoint: (i: number) => void; onShow: (f: PersonFile) => void; onOpen: (f: PersonFile) => void };

function Tile(props: { file: PersonFile; big?: boolean }) {
  const kind = () => kindOfFile(props.file);
  return (
    <span class={`file-tile ${kind()[1]}`} classList={{ big: props.big }}>
      {kind()[0]}
    </span>
  );
}

function FileRows(props: Rows) {
  return (
    <For each={props.files}>
      {(f, i) => (
        <>
          <Show when={dayHeading(f, props.files[i() - 1])}>{(h) => <h3 class="day">{h()}</h3>}</Show>
          {/* biome-ignore lint/a11y/useFocusableInteractive: the keys stay with the screen, which points here */}
          <div
            class="file-row"
            role="option"
            data-i={i()}
            aria-selected={i() === props.index}
            classList={{ active: i() === props.index }}
            onMouseDown={() => props.onPoint(i())}
            onDblClick={() => props.onShow(f)}
          >
            <Tile file={f} />
            <span class="what">
              <span class="name">{f.name}</span>
              <span class="sub">
                {f.mine ? "You sent it" : f.from} · {f.subject || "(no subject)"}
              </span>
            </span>
            <span class="size">{kb(f.size)}</span>
            <span class="date">{when(f.date)}</span>
          </div>
        </>
      )}
    </For>
  );
}

/** A picture's own image once it is on this computer; never downloads (the card shows the badge until then). */
function Thumb(props: { file: PersonFile; big?: boolean }) {
  const [src, setSrc] = createSignal<string | null>(null);
  let box!: HTMLSpanElement;
  onMount(() => {
    if (kindOfFile(props.file)[1] !== "image") return;
    // Asked only once the card scrolls into view: a grid of hundreds of pictures reads a few at a time.
    const seen = new IntersectionObserver((e) => {
      if (!e.some((x) => x.isIntersecting)) return;
      seen.disconnect();
      void api.attachmentPreview(props.file.messageId, props.file.index).then(setSrc, () => {});
    });
    seen.observe(box);
    onCleanup(() => seen.disconnect());
  });
  return (
    <span class="thumb" ref={box}>
      <Show when={src()} fallback={<Tile file={props.file} big />}>
        {(s) => <img src={s()} alt="" />}
      </Show>
    </span>
  );
}

function FileGrid(props: Rows) {
  return (
    <For each={props.files}>
      {(f, i) => (
        <>
          <Show when={dayHeading(f, props.files[i() - 1])}>{(h) => <h3 class="day">{h()}</h3>}</Show>
          {/* biome-ignore lint/a11y/useFocusableInteractive: the keys stay with the screen, which points here */}
          <div
            class="gallery-card"
            role="option"
            data-i={i()}
            aria-selected={i() === props.index}
            classList={{ active: i() === props.index }}
            onMouseDown={() => props.onPoint(i())}
            onDblClick={() => props.onShow(f)}
          >
            <Thumb file={f} />
            <span class="name">{f.name}</span>
            <span class="sub">
              {f.mine ? "You" : f.from} · {when(f.date)}
            </span>
          </div>
        </>
      )}
    </For>
  );
}

const longDate = new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });

/** The picked file large, what to do with it, and the mail it came in. */
function Preview(props: { file: PersonFile; others: PersonFile[]; onShow: (f: PersonFile) => void; onOpen: (f: PersonFile) => void }) {
  const [row, setRow] = createSignal<MessageRow | null>(null);
  void api.messageRows([props.file.messageId]).then((r) => setRow(r[0] ?? null), () => {});
  const f = props.file;
  return (
    <aside class="file-preview" aria-label="The picked file">
      <button type="button" class="stage" onClick={() => props.onShow(f)} title="Show it (Space)" aria-label={`Show ${f.name}`}>
        <Thumb file={f} big />
      </button>
      <div class="about">
        <Tile file={f} />
        <div class="what">
          <div class="name">{f.name}</div>
          <div class="sub">
            {kb(f.size)} · {longDate.format(new Date(f.date * 1000))}
          </div>
        </div>
      </div>
      <div class="actions">
        <button type="button" class="primary" onClick={() => props.onShow(f)}>
          Show
        </button>
        <button type="button" onClick={() => void api.openAttachment(f.messageId, f.index)}>
          <Icon name="external-link" size={14} /> Open
        </button>
        <button type="button" onClick={() => void api.saveAttachment(f.messageId, f.index)}>
          <Icon name="download" size={14} /> Save
        </button>
        <button type="button" onClick={() => props.onOpen(f)}>
          <Icon name="mail" size={14} /> Show its mail
        </button>
      </div>
      <div class="from-mail">
        <div class="label">From the mail</div>
        <div class="subject">{f.subject || "(no subject)"}</div>
        <div class="sub">
          {f.mine ? "You sent it" : `${f.from} to you`} · {when(f.date)}
        </div>
        <Show when={row()?.snippet}>{(s) => <p class="snippet">{s()}</p>}</Show>
        <Show when={props.others.length}>
          <div class="others">
            <For each={props.others}>
              {(o) => (
                <button type="button" class="other" onClick={() => props.onShow(o)} title="Show it">
                  <Tile file={o} />
                  <span>{o.name}</span>
                </button>
              )}
            </For>
          </div>
        </Show>
      </div>
    </aside>
  );
}
