// Paper trail (idea 115): receipts, invoices, orders and bookings from the last year, each with its amount and
// reference, by month with the month's total. Read on this computer from the mail's own words; Export CSV gives
// the list to a spreadsheet or an accountant.

import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { api, type MessageRow } from "../api";
import { open } from "../app/conversation";
import { asRow } from "../app/rows";
import { setPaperOpen } from "../app/state";
import { showToast } from "../app/toast";
import { moneyText, type Paper, type PaperKind, readPaper, toCsv } from "../paper";
import { when } from "./ConversationRow";

type Item = { row: MessageRow; paper: Paper };

const monthOf = (seconds: number) => {
  const d = new Date(seconds * 1000);
  return d.toLocaleDateString(undefined, d.getFullYear() === new Date().getFullYear() ? { month: "long" } : { month: "long", year: "numeric" });
};

/** Each currency's sum, largest first: "€42.50 · 24,00 KM". */
function totals(items: Item[]): string {
  const sum = new Map<string, number>();
  for (const { paper } of items) if (paper.amount != null && paper.currency) sum.set(paper.currency, (sum.get(paper.currency) ?? 0) + paper.amount);
  return [...sum]
    .sort((a, b) => b[1] - a[1])
    .map(([c, n]) => moneyText(n, c))
    .join(" · ");
}

export function PaperTrail() {
  const [items, setItems] = createSignal<Item[] | null>(null);
  const [typed, setTyped] = createSignal("");
  const [kind, setKind] = createSignal<PaperKind | "all">("all");
  const [index, setIndex] = createSignal(0);
  const since = new Date();
  since.setMonth(since.getMonth() - 12, 1);
  since.setHours(0, 0, 0, 0);
  void api.paperCandidates(Math.floor(since.getTime() / 1000)).then(
    (found) =>
      setItems(
        found.flatMap(([row, text]) => {
          const paper = readPaper(row.subject, text);
          return paper ? [{ row, paper }] : [];
        }),
      ),
    () => setItems([]),
  );
  const kinds = createMemo(() => {
    const n = new Map<PaperKind, number>();
    for (const i of items() ?? []) n.set(i.paper.kind, (n.get(i.paper.kind) ?? 0) + 1);
    return [...n].sort((a, b) => b[1] - a[1]);
  });
  const shown = createMemo(() => {
    const words = typed().trim().toLowerCase().split(/\s+/).filter(Boolean);
    return (items() ?? []).filter(
      (i) =>
        (kind() === "all" || i.paper.kind === kind()) &&
        words.every((w) => `${i.row.fromName} ${i.row.fromAddr} ${i.row.subject} ${i.paper.reference ?? ""}`.toLowerCase().includes(w)),
    );
  });
  const months = createMemo(() => {
    const out: { month: string; items: Item[]; first: number }[] = [];
    shown().forEach((i, n) => {
      const month = monthOf(i.row.date);
      if (out.at(-1)?.month === month) out.at(-1)!.items.push(i);
      else out.push({ month, items: [i], first: n });
    });
    return out;
  });
  const close = () => setPaperOpen(false);
  const openMail = (i: Item | undefined) => {
    if (!i) return;
    close();
    open(asRow(i.row), false);
  };
  const exportCsv = async () => {
    const csv = toCsv(shown().map((i) => ({ date: i.row.date, from: i.row.fromName || i.row.fromAddr, subject: i.row.subject, paper: i.paper })));
    try {
      if (await api.saveText("Export the paper trail", "paper-trail.csv", csv)) showToast(`Saved ${shown().length} rows as CSV`, []);
    } catch (e) {
      showToast(String(e), []);
    }
  };
  let list!: HTMLDivElement;
  const point = (n: number) => {
    setIndex(Math.max(0, Math.min(shown().length - 1, n)));
    list.querySelector(`[data-i="${index()}"]`)?.scrollIntoView({ block: "nearest" });
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") close();
    else if (e.key === "ArrowDown") point(index() + 1);
    else if (e.key === "ArrowUp") point(index() - 1);
    else if (e.key === "Enter") openMail(shown()[index()]);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };
  onMount(() => window.addEventListener("keydown", onKey, true));
  onCleanup(() => window.removeEventListener("keydown", onKey, true));

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: a click beside the dialog closes it, as Esc does
    <div class="overlay" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div class="paper-trail" role="dialog" aria-modal="true" aria-label="Paper trail">
        <header>
          <h2>Paper trail</h2>
          <input
            ref={(el) => queueMicrotask(() => el.focus())}
            placeholder="Find by sender, subject or reference"
            value={typed()}
            onInput={(e) => (setTyped(e.currentTarget.value), setIndex(0))}
          />
          <button type="button" onClick={() => void exportCsv()} disabled={!shown().length}>
            Export CSV
          </button>
          <button type="button" class="close" onClick={close} aria-label="Close">
            <kbd>Esc</kbd>
          </button>
        </header>
        <Show when={kinds().length > 1}>
          <fieldset class="kinds" aria-label="Kind">
            <button type="button" aria-pressed={kind() === "all"} onClick={() => (setKind("all"), setIndex(0))}>
              All {items()?.length}
            </button>
            <For each={kinds()}>
              {([k, n]) => (
                <button type="button" aria-pressed={kind() === k} onClick={() => (setKind(k), setIndex(0))}>
                  {k}s {n}
                </button>
              )}
            </For>
          </fieldset>
        </Show>
        <div class="rows" ref={list} role="listbox" aria-label="Receipts and invoices">
          <Show when={items()} fallback={<p class="quiet">Reading your mail…</p>}>
            <For each={months()} fallback={<p class="quiet">{items()!.length ? "Nothing by those words." : "No receipts or invoices in the last year."}</p>}>
              {(g) => (
                <>
                  <h3 class="month">
                    <span>{g.month}</span>
                    <span class="sum">{totals(g.items)}</span>
                  </h3>
                  <For each={g.items}>
                    {(i, n) => (
                      // biome-ignore lint/a11y/useFocusableInteractive: the keys stay in the search field, which points here
                      <div
                        class="item"
                        role="option"
                        data-i={g.first + n()}
                        aria-selected={g.first + n() === index()}
                        classList={{ active: g.first + n() === index() }}
                        onMouseEnter={() => setIndex(g.first + n())}
                        onMouseDown={() => openMail(i)}
                      >
                        <span class={`kind ${i.paper.kind.toLowerCase()}`}>{i.paper.kind}</span>
                        <span class="what">
                          <span class="name">{i.row.fromName || i.row.fromAddr}</span>
                          <span class="quiet">
                            {i.row.subject || "(no subject)"}
                            {i.paper.reference ? ` · ${i.paper.reference}` : ""}
                          </span>
                        </span>
                        <span class="amount">{i.paper.amount != null && i.paper.currency ? moneyText(i.paper.amount, i.paper.currency) : ""}</span>
                        <span class="date">{when(i.row.date)}</span>
                      </div>
                    )}
                  </For>
                </>
              )}
            </For>
          </Show>
        </div>
        <footer>
          <span>
            {shown().length ? `${shown().length} in the last year · ${totals(shown())}` : ""}
          </span>
          <span class="quiet">Read on this computer from the mail. Check amounts before you rely on them.</span>
        </footer>
      </div>
    </div>
  );
}
