import { For, Show } from "solid-js";
import { Icon } from "./Icon";
import type { ThreadRow } from "../api";
import { labelColour } from "../colours";

const time = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const weekday = new Intl.DateTimeFormat(undefined, { weekday: "short" });
const dayMonth = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });

/** A list date: the time today, the weekday within the last six days, day and month this year, else the year. */
export function when(seconds: number): string {
  const d = new Date(seconds * 1000);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return time.format(d);
  const days = (now.getTime() - d.getTime()) / 86_400_000;
  if (days < 6) return weekday.format(d);
  if (d.getFullYear() === now.getFullYear()) return dayMonth.format(d);
  return String(d.getFullYear());
}

const dayTime = new Intl.DateTimeFormat(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });
const dateTime = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });

/** When a snoozed conversation comes back: the time today, weekday and time this week, else the date and time. */
export function until(seconds: number): string {
  const d = new Date(seconds * 1000);
  const days = (d.getTime() - Date.now()) / 86_400_000;
  if (d.toDateString() === new Date().toDateString()) return time.format(d);
  return days < 6 ? dayTime.format(d) : dateTime.format(d);
}

/** "Ana Rossi" alone, or first names when several wrote: "Ana, Tom, me". */
export function participants(row: ThreadRow): string {
  const names = row.participants.length ? row.participants : [row.fromName || row.fromAddr];
  if (names.length === 1) return names[0];
  return names.map((n) => (n.includes("@") ? n.split("@")[0] : n.split(" ")[0])).join(", ");
}

/** One conversation on one line (docs/design/ui.md §4.1). */
export function ConversationRow(props: {
  row: ThreadRow;
  focused: boolean;
  selected: boolean;
  /** The list is beside an open conversation: no room for the snippet. */
  narrow: boolean;
  /** Its newest message is someone else's and waits on the person (the start of the day). */
  needsYou?: boolean;
  onClick: (e: MouseEvent) => void;
  onOpen: () => void;
}) {
  return (
    <div
      class="crow"
      role="row"
      aria-selected={props.selected}
      classList={{ focused: props.focused, selected: props.selected, unread: props.row.unread > 0 }}
      onMouseDown={props.onClick}
      onDblClick={props.onOpen}
    >
      <span class="mark">{props.selected ? "✓" : props.needsYou ? <span class="needs" title="Waits on you" /> : ""}</span>
      <span class="who">
        <span class="names">{participants(props.row)}</span>
        <Show when={props.row.count > 1}>
          <span class="count">{props.row.count}</span>
        </Show>
      </span>
      <span class="what">
        <span class="subject">{props.row.subject || "(no subject)"}</span>
        <Show when={props.row.labels?.length}>
          <span class="labels">
            <For each={props.row.labels!.slice(0, 2)}>
              {(l) => (
                <span class="label-chip" style={{ "--label": labelColour(l) }}>
                  {l}
                </span>
              )}
            </For>
            <Show when={props.row.labels!.length > 2}>
              <span class="label-chip" title={props.row.labels!.slice(2).join(", ")}>
                +{props.row.labels!.length - 2}
              </span>
            </Show>
          </span>
        </Show>
        <Show when={!props.narrow && props.row.snippet}>
          <span class="snippet">{props.row.snippet}</span>
        </Show>
      </span>
      <span class="glyphs">
        <Show when={props.row.hasAttachments}>
          <span class="clip" title="Has attachments" aria-label="Has attachments">
            <Icon name="paperclip" size={13} />
          </span>
        </Show>
        <Show when={props.row.flagged}>
          <span class="star" title="Starred" aria-label="Starred">
            <Icon name="star" size={13} filled />
          </span>
        </Show>
      </span>
      <Show when={props.row.followUp}>
        <span class="chip follow-up" title="You asked to be reminded if nobody replied. Done (e) dismisses it.">
          No reply yet
        </span>
      </Show>
      <Show when={props.row.snoozedUntil} fallback={<span class="date">{when(props.row.date)}</span>}>
        {(due) => (
          <span class="date snoozed" title="Snoozed until then">
            <Icon name="clock" size={12} />
            {until(due())}
          </span>
        )}
      </Show>
    </div>
  );
}
