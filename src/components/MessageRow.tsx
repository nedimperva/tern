import type { MessageRow as Row } from "../api";

const day = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const time = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const year = new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric" });

export function when(seconds: number): string {
  const d = new Date(seconds * 1000);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return time.format(d);
  if (d.getFullYear() === now.getFullYear()) return day.format(d);
  return year.format(d);
}

export function MessageRow(props: { row: Row; selected: boolean; onClick: () => void }) {
  return (
    <div
      class="row"
      classList={{ selected: props.selected, unread: !props.row.seen }}
      onMouseDown={props.onClick}
    >
      <div class="row-top">
        <span class="dot" />
        <span class="from">{props.row.fromName || props.row.fromAddr}</span>
        {props.row.flagged && <span class="star">★</span>}
        {props.row.hasAttachments && <span class="clip">📎</span>}
        <span class="date">{when(props.row.date)}</span>
      </div>
      <div class="row-bottom">
        <span class="subject">{props.row.subject || "(no subject)"}</span>
        <span class="snippet"> — {props.row.snippet}</span>
      </div>
    </div>
  );
}
