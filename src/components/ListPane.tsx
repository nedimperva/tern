import { For, Show } from "solid-js";
import { firstName, lineHere, runDeck } from "../app/deck";
import { go, isSaved, loadMore, splitIndex, SPLITS, tabUnread, title, toggleSaved, toggleSelected } from "../app/list";
import { open } from "../app/conversation";
import { keyOf } from "../app/rows";
import {
  accounts,
  focus,
  openRow,
  partial,
  query,
  ready,
  rows,
  searchBox,
  target,
  searching,
  selection,
  setFocus,
  setPalette,
  setQuery,
  setRail,
} from "../app/state";
import { coverage, inboxZero } from "../app/status";
import { ROW_HEIGHTS, settings, SPLIT_ROW_EXTRA } from "../settings";
import { colourOf } from "../colours";
import type { ThreadRow } from "../api";
import { ConversationRow } from "./ConversationRow";
import { DayLine } from "./DayLine";
import { Icon } from "./Icon";
import { InboxZero } from "./InboxZero";
import { StatusStrip } from "./StatusStrip";
import { VirtualList } from "./VirtualList";

/** The conversation list with its header (splits, search) and the status strip under it. */
export function ListPane(props: {
  /** A conversation is open beside the list, so rows are narrow. */
  split: boolean;
  /** Search words to light up in the rows. */
  hits?: string[];
  /** Conversations that need the person, for the dot in their rows. */
  needsYou: ReadonlySet<string>;
}) {
  // Lists that mix accounts (the inboxes, splits, search) mark each row with its account's colour.
  const mixed = () => accounts().length > 1 && (searching() || "role" in target());
  const accountOf = (row: ThreadRow) => {
    const a = mixed() ? accounts().find((x) => x.id === row.accountId) : undefined;
    return a ? { colour: colourOf(accounts(), a.id), email: a.email } : undefined;
  };
  const onSearchKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      setQuery("");
      searchBox.input?.blur();
    } else if (e.key === "Enter" || e.key === "ArrowDown") {
      e.preventDefault();
      searchBox.input?.blur();
    }
  };

  return (
    <main class="list-pane">
      <header class="list-header">
        <button
          class="link rail-button"
          onClick={() => setRail(true)}
          title="Accounts and folders (Ctrl+\)"
          aria-label="Accounts and folders"
        >
          <Icon name="menu" size={18} />
        </button>
        <Show when={splitIndex() >= 0 && !searching()} fallback={<h2>{title()}</h2>}>
          <nav class="splits" role="tablist">
            <For each={SPLITS()}>
              {(s, i) => (
                <button role="tab" aria-selected={i() === splitIndex()} classList={{ active: i() === splitIndex() }} onClick={() => go(s.target)}>
                  {s.name}
                  <Show when={tabUnread(s.target)}>
                    <span class="count">{tabUnread(s.target)}</span>
                  </Show>
                </button>
              )}
            </For>
          </nav>
        </Show>
        <input
          ref={(el) => (searchBox.input = el)}
          class="search"
          placeholder={props.split ? "/" : "Search   /"}
          value={query()}
          onInput={(e) => setQuery(e.currentTarget.value)}
          onKeyDown={onSearchKey}
        />
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
        <button class="link" title="Command palette" onClick={() => setPalette(true)}>
          <kbd>Ctrl K</kbd>
        </button>
      </header>
      <Show when={searching() && partial()}>
        <div class="search-note">{coverage()}</div>
      </Show>
      <Show when={lineHere()}>
        <DayLine name={firstName()} onRun={runDeck} onRest={() => go({ role: "bulk" })} />
      </Show>
      <Show
        when={rows().length}
        fallback={
          <Show
            when={inboxZero()}
            fallback={
              <Show when={searching()} fallback={<div class="empty">{ready() ? "Nothing here." : ""}</div>}>
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
        <VirtualList items={rows()} rowHeight={ROW_HEIGHTS[settings.density] + (props.split ? SPLIT_ROW_EXTRA : 0)} selected={focus()} onEnd={loadMore}>
          {(row, index) => (
            <ConversationRow
              row={row}
              focused={index() === focus()}
              selected={selection().has(keyOf(row))}
              narrow={props.split}
              needsYou={props.needsYou.has(keyOf(row))}
              hits={props.hits}
              account={accountOf(row)}
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
      <StatusStrip />
    </main>
  );
}
