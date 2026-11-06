import { createMemo, createSignal, For, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { go, isSaved, loadMore, searchServer, serverFound, splitIndex, SPLITS, tabUnread, title, toggleSaved, toggleSelected } from "../app/list";
import { open } from "../app/conversation";
import { keyOf } from "../app/rows";
import {
  accounts,
  docked,
  focus,
  openRow,
  partial,
  query,
  role,
  rows,
  searchBox,
  target,
  searching,
  selection,
  setFocus,
  setQuery,
  ownTitleBar,
  titleSlot,
  toggleSidebar,
} from "../app/state";
import { coverage, inboxZero, listedHere } from "../app/status";
import { ROW_HEIGHTS, settings, SPLIT_ROW_EXTRA } from "../settings";
import { colourOf } from "../colours";
import type { Target, ThreadRow } from "../api";
import { ConversationRow, participants } from "./ConversationRow";
import { Icon, type IconName } from "./Icon";
import { SelectionBar } from "./SelectionBar";
import { SyncButton } from "./SyncButton";
import { InboxZero } from "./InboxZero";
import { rowId } from "../motion";
import { VirtualList } from "./VirtualList";
import { dayHeading } from "../listDays";

/** The height of a day heading in the list. */
const DAY_HEADING = 30;

const NOBODY_NEW = "Nobody new. First mail from someone you haven't written to waits here until you let them in.";

/** The icon each split tab shows (Lucide, see Icon.tsx). */
const TAB_ICON: Record<string, IconName> = {
  important: "circle-alert",
  bulk: "mail",
  starred: "star",
  new_people: "user-plus",
  inbox: "inbox",
};
const tabRole = (t: Target) => ("role" in t ? t.role : "");

/** The conversation list with its header (splits, search) and the status strip under it. */
export function ListPane(props: {
  /** A conversation is open beside the list, so rows are narrow. */
  split: boolean;
  /** Search words to light up in the rows. */
  hits?: string[];
  /** Conversations that need the person, for the dot in their rows. */
  needsYou: ReadonlySet<string>;
}) {
  // A list that mixes accounts (the inboxes, splits, search) marks each row with its account's colour, but only
  // when its rows really come from more than one: All Inboxes with one account's mail looks like that account's.
  const mixed = createMemo(() => {
    if (accounts().length < 2 || !(searching() || "role" in target())) return false;
    const first = rows()[0]?.accountId;
    return rows().some((r) => r.accountId !== first);
  });
  const accountOf = (row: ThreadRow) => {
    const a = mixed() ? accounts().find((x) => x.id === row.accountId) : undefined;
    return a ? { colour: colourOf(accounts(), a.id), email: a.email } : undefined;
  };
  // j and k move the focus with the keys anywhere in the window, so a screen reader hears the focused conversation
  // here; while the list itself has focus, aria-activedescendant says it instead.
  const spoken = createMemo(() => {
    const row = rows()[focus()];
    if (!row || document.activeElement?.classList.contains("vlist")) return "";
    return `${participants(row)}, ${row.subject || "no subject"}${row.unread ? ", unread" : ""}, ${focus() + 1} of ${rows().length}`;
  });
  /** Rows the server's search added beyond what was found here. */
  const added = () => rows().filter((r) => r.fromServer).length;
  const onSearchKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      setQuery("");
      searchBox.input?.blur();
    } else if (e.key === "Enter" || e.key === "ArrowDown") {
      e.preventDefault();
      searchBox.input?.blur();
    }
  };

  // Search grows over the tabs while it has the focus or holds a search (canvas "Tern title bar ideas", 3). Its
  // filters (`from:ana`, `is:unread`) show as chips before the words; a filter becomes a chip once a space follows
  // it, so one still being typed stays in the field.
  const [searchFocused, setSearchFocused] = createSignal(false);
  const growing = () => searchFocused() || searching();
  // Day headings in the full-width list where rows run newest first by date; not in the narrow column beside a
  // conversation, search results, Snoozed (sorted by when they come back) or New people (a row per person).
  const dated = () => !props.split && !searching() && !["snoozed", "new_people", "later"].includes(role());
  const tokens = () => query().match(/"[^"]*"|\S+/g) ?? [];
  const isFilter = (t: string) => /^-?[a-z_]+:\S/i.test(t);
  const typedLast = () => /\S$/.test(query());
  const chips = () => {
    const all = tokens();
    return all.filter((t, i) => isFilter(t) && (i < all.length - 1 || !typedLast()));
  };
  const words = () => {
    const all = tokens();
    const kept = all.filter((t, i) => !(isFilter(t) && (i < all.length - 1 || !typedLast())));
    return kept.join(" ") + (query().endsWith(" ") && kept.length ? " " : "");
  };
  const setWords = (text: string) => setQuery([...chips(), text].filter(Boolean).join(" "));
  const dropChip = (chip: string) => {
    const left = chips().filter((c) => c !== chip);
    setQuery([...left, words().trim()].filter(Boolean).join(" ") + (words().trim() ? "" : left.length ? " " : ""));
    searchBox.input?.focus();
  };
  /** Filters a tap adds, each a filter the search already understands. */
  const QUICK: [string, string][] = [
    ["Unread", "is:unread"],
    ["Starred", "is:starred"],
    ["With files", "has:file"],
    ["This week", "newer_than:7d"],
    ["Marked", "has:marks"],
    ["Sent", "in:sent"],
  ];
  const toggleQuick = (token: string) => {
    const on = chips().includes(token);
    const left = on ? chips().filter((c) => c !== token) : [...chips(), token];
    setQuery(`${[...left, words().trim()].filter(Boolean).join(" ")}${words().trim() ? "" : " "}`);
    searchBox.input?.focus();
  };

  /** Which list this is and searching it: in Tern's own title bar when there is one, else a row of its own. One
   * element (`display: contents`, so the row's layout holds), not loose parts: loose, swapping the tabs for
   * "Search: …" on the first letter took the search field out and put it back, and it lost the focus. */
  const Head = () => (
    <div class="list-head" classList={{ growing: growing() }}>
      <Show when={!growing()}>
      <Show when={splitIndex() >= 0 && !searching()} fallback={<h2>{title()}</h2>}>
          <div class="splits" role="tablist" aria-label="Inbox views">
            <For each={SPLITS()}>
              {(s, i) => (
                <button
                  role="tab"
                  aria-selected={i() === splitIndex()}
                  classList={{ active: i() === splitIndex(), people: "role" in s.target && s.target.role === "new_people" }}
                  onClick={() => go(s.target)}
                  title={"role" in s.target && s.target.role === "new_people" ? "First mail from people you haven't written to (G N)" : s.name}
                  aria-label={"role" in s.target && s.target.role === "new_people" ? `New people, ${tabUnread(s.target)} waiting` : s.name}
                >
                  {/* Each tab has its icon; beside a narrow list only the open tab keeps its name (styles.css). */}
                  <Icon name={TAB_ICON[tabRole(s.target)] ?? "inbox"} size={13} />
                  <span class="name">{s.name}</span>
                  <Show when={tabUnread(s.target)}>
                    <span class="count">{tabUnread(s.target)}</span>
                  </Show>
                </button>
              )}
            </For>
          </div>
        </Show>
      </Show>
        <div class="search-box" classList={{ open: growing() }}>
          <Icon name="search" size={14} />
          <For each={growing() ? chips() : []}>
            {(c) => (
              <button type="button" class="chip" title={`Remove ${c}`} onMouseDown={(e) => e.preventDefault()} onClick={() => dropChip(c)}>
                {c}
                <Icon name="x" size={11} />
              </button>
            )}
          </For>
          <input
            ref={(el) => (searchBox.input = el)}
            class="search"
            aria-label="Search mail"
            placeholder={chips().length && growing() ? "" : props.split ? "/" : "Search   /"}
            value={growing() ? words() : query()}
            onInput={(e) => setWords(e.currentTarget.value)}
            onKeyDown={(e) => {
              // Backspace at the start takes the last chip off.
              if (e.key === "Backspace" && !e.currentTarget.value && chips().length) {
                e.preventDefault();
                dropChip(chips()[chips().length - 1]);
                return;
              }
              onSearchKey(e);
            }}
            onFocus={() => setSearchFocused(true)}
            onBlur={() => setSearchFocused(false)}
          />
          <Show when={searchFocused()}>
            <fieldset class="search-quick">
              <legend class="kicker">Narrow it</legend>
              <div class="quick-row">
                <For each={QUICK}>
                  {([name, token]) => (
                    <button
                      type="button"
                      classList={{ on: chips().includes(token) }}
                      aria-pressed={chips().includes(token)}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => toggleQuick(token)}
                    >
                      {name}
                    </button>
                  )}
                </For>
              </div>
            </fieldset>
          </Show>
        </div>
        <Show when={searching()}>
          <button
            class="link save-search"
            classList={{ on: isSaved() }}
            title={isSaved() ? "Take this search out of the rail" : "Keep this search in the rail and the command palette"}
            onClick={toggleSaved}
          >
            {isSaved() ? "Saved" : "Save search"}
          </button>
        </Show>
    </div>
  );

  return (
    <main class="list-pane">
      <Show
        when={ownTitleBar && titleSlot()}
        fallback={
          <header class="list-header">
            <Show when={!ownTitleBar}>
              <button
                type="button"
                class="icon-button"
                onClick={toggleSidebar}
                title={`${docked() ? "Hide" : "Show"} the sidebar (Ctrl+\\)`}
                aria-label={docked() ? "Hide the sidebar" : "Show the sidebar"}
              >
                <Icon name="panel-left" size={17} />
              </button>
            </Show>
            <Head />
            {/* Without Tern's own title bar (Linux), sync sits at the end of the list's header. */}
            <Show when={!ownTitleBar}>
              <SyncButton />
            </Show>
          </header>
        }
      >
        {(slot) => (
          <Portal mount={slot()}>
            {/* Over the narrow list beside a conversation, the row is the list's width: the rest drags the window. */}
            <div class="list-header in-titlebar" classList={{ split: props.split }}>
              <Head />
            </div>
          </Portal>
        )}
      </Show>
      {/* Without Tern's own title bar the selection's actions take a row over the list. */}
      <Show when={!ownTitleBar && selection().size > 0}>
        <SelectionBar />
      </Show>
      <Show when={searching() && partial()}>
        <div class="search-note">
          {coverage()}{" "}
          <Show
            when={serverFound().query === query().trim() ? serverFound() : null}
            fallback={
              <button type="button" class="link" onClick={() => void searchServer()}>
                Search the server
              </button>
            }
          >
            {(s) => (
              <span class="server-said" role="status">
                {s().state === "busy"
                  ? "Searching the server…"
                  : s().state === "error"
                    ? `The server search didn't work: ${s().error}`
                    : added()
                      ? `The server found ${added() === 1 ? "1 more" : `${added()} more`}, below; their text is on its way.`
                      : "The server found nothing more."}
              </span>
            )}
          </Show>
        </div>
      </Show>
      <Show
        when={rows().length}
        fallback={
          <Show
            when={inboxZero()}
            fallback={
              <Show when={searching()} fallback={<div class="empty">{listedHere() ? (role() === "new_people" ? NOBODY_NEW : "Nothing here.") : ""}</div>}>
                <div class="empty search-help">
                  <p>Nothing found.</p>
                  <p>
                    Search also takes filters: <code>from:</code> <code>to:</code> <code>subject:</code> <code>is:unread</code>{" "}
                    <code>is:starred</code> <code>is:marked</code> <code>has:note</code> <code>is:snoozed</code>{" "}
                    <code>has:attachment</code> <code>in:sent</code>{" "}
                    <code>before:2026-01-31</code> <code>newer_than:7d</code> <code>larger:5m</code>. Quote a
                    phrase, put <code>-</code> before what to leave out, <code>OR</code> between words for either.
                  </p>
                </div>
              </Show>
            }
          >
            <InboxZero accounts={accounts()} />
          </Show>
        }
      >
        <div class="visually-hidden" aria-live="polite">
          {spoken()}
        </div>
        <VirtualList
          items={rows()}
          rowHeight={ROW_HEIGHTS[settings.density] + (props.split ? SPLIT_ROW_EXTRA : 0)}
          selected={focus()}
          label={searching() ? `Search results for ${query()}` : title()}
          activeId={rows()[focus()] ? rowId(rows()[focus()]) : undefined}
          onEnd={loadMore}
          heading={dated() ? (row, above) => dayHeading(row, above) : undefined}
          headingHeight={DAY_HEADING}
        >
          {(row, index) => (
            <ConversationRow
              row={row}
              focused={index() === focus()}
              selected={selection().has(keyOf(row))}
              narrow={props.split}
              needsYou={props.needsYou.has(keyOf(row))}
              hits={props.hits}
              account={accountOf(row)}
              id={rowId(row)}
              onClick={(e) => {
                setFocus(index());
                if (e.shiftKey || e.ctrlKey || e.metaKey) toggleSelected(row);
                else if (openRow()) void open(row);
              }}
              onOpen={() => open(row)}
            />
          )}
        </VirtualList>
      </Show>
    </main>
  );
}
