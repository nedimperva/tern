// Paper trail (idea 115, a screen since 2026-11-21, board "Files and Paper trail screens", A): receipts, invoices,
// orders and bookings from the last twelve months as a ledger, in the place of the list and the open mail. On top,
// the picked month's total and a bar for each month; chips filter by date, kind, sender, currency, amount and
// papers that come every month; the rows group by month or by sender. Read on this computer from the mail's own
// words; Export CSV gives what is shown to a spreadsheet or an accountant.

import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import { api, type MessageRow } from "../api";
import { open } from "../app/conversation";
import { asRow } from "../app/rows";
import { docked, setPaperOpen, toggleSidebar } from "../app/state";
import { showToast } from "../app/toast";
import { type DateRange, rangeLabel, span } from "../dateRange";
import { moneyText, type Paper, readPaper, repeating, sums, sumsText, toCsv } from "../paper";
import { setSetting, settings } from "../settings";
import { when } from "./ConversationRow";
import { Chip, Choices, chipOpen, DatePanel, Ticks } from "./Filters";
import { Icon } from "./Icon";

type Item = { row: MessageRow; paper: Paper; from: string };

const MONTHS = 12;
const monthKey = (seconds: number) => {
  const d = new Date(seconds * 1000);
  return d.getFullYear() * 12 + d.getMonth();
};
const monthLong = new Intl.DateTimeFormat(undefined, { month: "long" });
const monthLongYear = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" });
const monthShort = new Intl.DateTimeFormat(undefined, { month: "short" });
const ofKey = (k: number) => new Date(Math.floor(k / 12), k % 12, 1);
const monthName = (k: number) => (Math.floor(k / 12) === new Date().getFullYear() ? monthLong : monthLongYear).format(ofKey(k));
const AMOUNTS = [
  { value: "any", label: "Any amount" },
  { value: "known", label: "With an amount" },
  { value: "none", label: "Without an amount" },
  { value: "100", label: "100 or more" },
  { value: "1000", label: "1,000 or more" },
];

export function PaperScreen() {
  const [items, setItems] = createSignal<Item[] | null>(null);
  const [range, setRange] = createSignal<DateRange>({ kind: "12months" });
  /** A month picked on the chart, as year * 12 + month; it narrows the date filter. */
  const [month, setMonth] = createSignal<number | null>(null);
  const [kinds, setKinds] = createSignal<string[]>([]);
  const [from, setFrom] = createSignal<string[]>([]);
  const [currencies, setCurrencies] = createSignal<string[]>([]);
  const [amount, setAmount] = createSignal("any");
  const [repeatsOnly, setRepeatsOnly] = createSignal(false);
  const [typed, setTyped] = createSignal("");
  const [index, setIndex] = createSignal(0);
  const bySender = () => settings.paperBy === "sender";

  // The last twelve months are read once; every filter works on them.
  const year = span({ kind: "12months" });
  void api.paperCandidates(year.since).then(
    (found) =>
      setItems(
        found.flatMap(([row, text]) => {
          const paper = readPaper(row.subject, text);
          return paper ? [{ row, paper, from: row.fromName || row.fromAddr }] : [];
        }),
      ),
    () => setItems([]),
  );
  const repeats = createMemo(() => repeating((items() ?? []).map((i) => ({ from: i.from, date: i.row.date }))));
  const dates = () => {
    const m = month();
    if (m !== null) return { since: ofKey(m).getTime() / 1000, until: ofKey(m + 1).getTime() / 1000 };
    return span(range());
  };
  type Skip = "date" | "kind" | "from" | "currency";
  const passes = (i: Item, skip?: Skip) => {
    if (skip !== "date") {
      const w = dates();
      if (i.row.date < w.since || i.row.date >= w.until) return false;
    }
    if (skip !== "kind" && kinds().length && !kinds().includes(i.paper.kind)) return false;
    if (skip !== "from" && from().length && !from().includes(i.from)) return false;
    if (skip !== "currency" && currencies().length && !currencies().includes(i.paper.currency ?? "")) return false;
    const a = i.paper.amount;
    if (amount() === "known" && a == null) return false;
    if (amount() === "none" && a != null) return false;
    if ((amount() === "100" || amount() === "1000") && (a == null || a < Number(amount()))) return false;
    if (repeatsOnly() && !repeats().has(i.from)) return false;
    const words = typed().trim().toLowerCase().split(/\s+/).filter(Boolean);
    return words.every((w) => `${i.from} ${i.row.fromAddr} ${i.row.subject} ${i.paper.reference ?? ""}`.toLowerCase().includes(w));
  };
  const shown = createMemo(() => (items() ?? []).filter((i) => passes(i)));
  const count = (skip: Skip, of: (i: Item) => string) => {
    const n = new Map<string, number>();
    for (const i of items() ?? []) if (passes(i, skip) && of(i)) n.set(of(i), (n.get(of(i)) ?? 0) + 1);
    return [...n].sort((a, b) => b[1] - a[1]).map(([value, c]) => ({ value, label: value, count: c }));
  };
  const kindCounts = createMemo(() => count("kind", (i) => i.paper.kind).map((k) => ({ ...k, label: `${k.value}s` })));
  const senderCounts = createMemo(() => count("from", (i) => i.from));
  const currencyCounts = createMemo(() => count("currency", (i) => i.paper.currency ?? ""));

  /** The groups the rows fall in: months newest first, or senders by what they came to. */
  const groups = createMemo(() => {
    const out = new Map<string | number, Item[]>();
    for (const i of shown()) {
      const k = bySender() ? i.from : monthKey(i.row.date);
      out.set(k, [...(out.get(k) ?? []), i]);
    }
    const list = [...out].map(([k, rows]) => ({ title: typeof k === "number" ? monthName(k) : k, rows }));
    if (bySender()) list.sort((a, b) => (sums(b.rows)[0]?.[1] ?? 0) - (sums(a.rows)[0]?.[1] ?? 0) || b.rows.length - a.rows.length);
    let n = 0;
    return list.map((g) => ({ ...g, first: (n += g.rows.length) - g.rows.length }));
  });
  /** The rows in the order they are drawn, for the arrows. */
  const flat = createMemo(() => groups().flatMap((g) => g.rows));
  createEffect(on(flat, () => setIndex(0), { defer: true }));

  // The chart: the year's main currency, a bar a month, whatever the other filters leave.
  const chartItems = createMemo(() => (items() ?? []).filter((i) => passes(i, "date")));
  const mainCurrency = createMemo(() => sums(chartItems())[0]?.[0] ?? null);
  const bars = createMemo(() => {
    const now = monthKey(Date.now() / 1000);
    return Array.from({ length: MONTHS }, (_, n) => {
      const k = now - (MONTHS - 1) + n;
      const rows = chartItems().filter((i) => monthKey(i.row.date) === k);
      const main = rows.filter((i) => i.paper.currency === mainCurrency()).reduce((s, i) => s + (i.paper.amount ?? 0), 0);
      return { k, rows, main };
    });
  });
  const top = createMemo(() => Math.max(1, ...bars().map((b) => b.main)));
  /** What the shown rows come to, under the month or span they are from. */
  const headline = createMemo(() => {
    const m = month();
    return { title: m === null ? rangeLabel(range()) : monthName(m), all: sums(shown()), count: shown().length };
  });

  const close = () => setPaperOpen(false);
  const openMail = (i: Item | undefined) => {
    if (!i) return;
    close();
    void open(asRow(i.row), false);
  };
  const exportCsv = async () => {
    const csv = toCsv(flat().map((i) => ({ date: i.row.date, from: i.from, subject: i.row.subject, paper: i.paper })));
    try {
      if (await api.saveText("Export the paper trail", "paper-trail.csv", csv)) showToast(`Saved ${flat().length} rows as CSV`, []);
    } catch (e) {
      showToast(String(e), []);
    }
  };
  const anySet = () =>
    range().kind !== "12months" || month() !== null || kinds().length > 0 || from().length > 0 || currencies().length > 0 || amount() !== "any" || repeatsOnly();
  const clearAll = () =>
    (setRange({ kind: "12months" }), setMonth(null), setKinds([]), setFrom([]), setCurrencies([]), setAmount("any"), setRepeatsOnly(false));

  let list!: HTMLDivElement;
  let search!: HTMLInputElement;
  const point = (n: number) => {
    setIndex(Math.max(0, Math.min(flat().length - 1, n)));
    list.querySelector(`[data-i="${index()}"]`)?.scrollIntoView({ block: "nearest" });
  };
  const onKey = (e: KeyboardEvent) => {
    if (chipOpen()) return;
    const typing = e.target instanceof HTMLInputElement;
    if (e.key === "Escape") {
      if (typing && typed()) setTyped("");
      else close();
    } else if (e.key === "ArrowDown") point(index() + 1);
    else if (e.key === "ArrowUp") point(index() - 1);
    else if (e.key === "Enter") openMail(flat()[index()]);
    else if (e.key === "/" && !typing) search.focus();
    else return;
    e.preventDefault();
    e.stopPropagation();
  };
  onMount(() => window.addEventListener("keydown", onKey, true));
  onCleanup(() => window.removeEventListener("keydown", onKey, true));

  return (
    <section class="tool-screen paper-screen" aria-label="Paper trail">
      <header class="screen-head" data-tauri-drag-region="deep">
        <Show when={!docked()}>
          <button type="button" class="icon-button" onClick={toggleSidebar} title="Show the sidebar (Ctrl+\)" aria-label="Show the sidebar">
            <Icon name="panel-left" size={17} />
          </button>
        </Show>
        <button type="button" class="icon-button" onClick={close} title="Back to the mail (Esc)" aria-label="Back to the mail">
          <Icon name="arrow-left" size={17} />
        </button>
        <h1>Paper trail</h1>
        <span class="spacer" />
        <label class="screen-find">
          <Icon name="search" size={14} />
          <input ref={search} placeholder="Find by sender, subject or reference" value={typed()} onInput={(e) => setTyped(e.currentTarget.value)} aria-label="Find a paper" />
          <kbd>/</kbd>
        </label>
        <button type="button" class="screen-button" onClick={() => void exportCsv()} disabled={!flat().length}>
          <Icon name="download" size={14} /> Export CSV
        </button>
      </header>

      <div class="paper-summary">
        <div class="total">
          <div class="label">{headline().title}</div>
          <div class="big">{headline().all.length ? moneyText(headline().all[0][1], headline().all[0][0]) : "Nothing"}</div>
          <div class="label">
            {headline()
              .all.slice(1)
              .map(([c, n]) => `+ ${moneyText(n, c)}`)
              .join(" · ")}
            {headline().all.length > 1 ? " · " : ""}
            {headline().count} {headline().count === 1 ? "paper" : "papers"}
          </div>
        </div>
        <fieldset class="chart">
          <legend class="visually-hidden">Each month in {mainCurrency() ?? "the main currency"}; pick one to see it</legend>
          <For each={bars()}>
            {(b) => (
              <button
                type="button"
                class="bar"
                classList={{ on: month() === b.k, empty: !b.rows.length }}
                aria-pressed={month() === b.k}
                title={`${monthName(b.k)}: ${b.rows.length ? sumsText(b.rows) || `${b.rows.length} without an amount` : "nothing"}`}
                onClick={() => setMonth(month() === b.k ? null : b.k)}
              >
                <span class="fill" style={{ height: `${b.main ? Math.max(4, (b.main / top()) * 100) : b.rows.length ? 4 : 0}%` }} />
                <span class="month">{monthShort.format(ofKey(b.k))}</span>
              </button>
            )}
          </For>
        </fieldset>
      </div>

      <div class="screen-chips">
        <Chip
          label={month() !== null ? monthName(month()!) : rangeLabel(range())}
          icon="calendar"
          set={month() !== null || range().kind !== "12months"}
          onClear={() => (setMonth(null), setRange({ kind: "12months" }))}
        >
          {(done) => <DatePanel value={range()} onChange={(r) => (setMonth(null), setRange(r))} presets={["12months", "month", "3months", "year"]} close={done} />}
        </Chip>
        <Chip label={kinds().length ? kinds().map((k) => `${k}s`).join(", ") : "Any kind"} set={kinds().length > 0} onClear={() => setKinds([])}>
          {() => <Ticks items={kindCounts()} picked={kinds()} onChange={setKinds} />}
        </Chip>
        <Chip label={from().length ? `From ${from().length <= 2 ? from().join(", ") : `${from()[0]} and ${from().length - 1} more`}` : "From anyone"} set={from().length > 0} onClear={() => setFrom([])}>
          {() => <Ticks items={senderCounts()} picked={from()} onChange={setFrom} find="Find a sender" />}
        </Chip>
        <Show when={currencyCounts().length > 1 || currencies().length}>
          <Chip label={currencies().length ? currencies().join(", ") : "Any currency"} set={currencies().length > 0} onClear={() => setCurrencies([])}>
            {() => <Ticks items={currencyCounts()} picked={currencies()} onChange={setCurrencies} />}
          </Chip>
        </Show>
        <Chip label={AMOUNTS.find((a) => a.value === amount())!.label} set={amount() !== "any"} onClear={() => setAmount("any")}>
          {(done) => <Choices items={AMOUNTS} value={amount()} onChange={(v) => (setAmount(v), done())} />}
        </Chip>
        <button type="button" class="chip" classList={{ set: repeatsOnly() }} aria-pressed={repeatsOnly()} onClick={() => setRepeatsOnly(!repeatsOnly())} title="Senders whose papers come in three or more months">
          <Icon name="repeat" size={13} /> Repeats
        </button>
        <Show when={anySet()}>
          <button type="button" class="link clear" onClick={clearAll}>
            Clear
          </button>
        </Show>
        <span class="chips-end">
          <span class="segmented">
            <button type="button" aria-pressed={!bySender()} classList={{ on: !bySender() }} onClick={() => setSetting("paperBy", "month")}>
              By month
            </button>
            <button type="button" aria-pressed={bySender()} classList={{ on: bySender() }} onClick={() => setSetting("paperBy", "sender")}>
              By sender
            </button>
          </span>
        </span>
      </div>

      <div class="ledger-head" aria-hidden="true">
        <span>Date</span>
        <span>Kind</span>
        <span>From</span>
        <span>What</span>
        <span>Reference</span>
        <span class="amount">Amount</span>
      </div>
      <div class="screen-list ledger" ref={list} role="listbox" aria-label="Receipts and invoices">
        <Show when={items()} fallback={<p class="quiet empty">Reading your mail…</p>}>
          <For each={groups()} fallback={<p class="quiet empty">{items()!.length ? "No paper matches these filters." : "No receipts or invoices in the last year."}</p>}>
            {(g) => (
              <>
                <h3 class="day">
                  <span>
                    {g.title}
                    <Show when={bySender() && repeats().has(g.title)}>
                      <span class="repeats" title="Comes every month">
                        <Icon name="repeat" size={12} />
                      </span>
                    </Show>
                    <span class="n">
                      {" "}
                      · {g.rows.length} {g.rows.length === 1 ? "paper" : "papers"}
                    </span>
                  </span>
                  <span class="sum">{sumsText(g.rows)}</span>
                </h3>
                <For each={g.rows}>
                  {(i, n) => (
                    // biome-ignore lint/a11y/useFocusableInteractive: the keys stay with the screen, which points here
                    <div
                      class="ledger-row"
                      role="option"
                      data-i={g.first + n()}
                      aria-selected={g.first + n() === index()}
                      classList={{ active: g.first + n() === index() }}
                      onMouseDown={() => setIndex(g.first + n())}
                      onDblClick={() => openMail(i)}
                    >
                      <span class="date">{when(i.row.date)}</span>
                      <span class={`kind ${i.paper.kind.toLowerCase()}`}>{i.paper.kind}</span>
                      <span class="from">
                        {i.from}
                        <Show when={repeats().has(i.from)}>
                          <span class="repeats" title="Comes every month">
                            <Icon name="repeat" size={12} />
                          </span>
                        </Show>
                      </span>
                      <span class="what">{i.row.subject || "(no subject)"}</span>
                      <span class="ref">{i.paper.reference ?? ""}</span>
                      <span class="amount">{i.paper.amount != null && i.paper.currency ? moneyText(i.paper.amount, i.paper.currency) : ""}</span>
                    </div>
                  )}
                </For>
              </>
            )}
          </For>
        </Show>
      </div>

      <footer class="screen-foot">
        <span>
          <kbd>↑</kbd> <kbd>↓</kbd> move · <kbd>Enter</kbd> open its mail · <kbd>Esc</kbd> back to the mail
        </span>
        <span class="quiet">Read on this computer from the mail. Check amounts before you rely on them.</span>
      </footer>
    </section>
  );
}
