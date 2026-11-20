// Recently done (idea 137): the last changes made from the list, in words, so "where did that mail go?" has an
// answer after the undo window. Kept while Tern runs; each opens the mail where it is now, and Done or Trash can
// be put back in the Inbox.

import { createSignal } from "solid-js";
import { api, type Target, type ThreadRow } from "../api";
import { asRow } from "./rows";

export type Done = {
  text: string;
  at: number;
  rows: ThreadRow[];
  /** Where the rows went, to put them back from: Done and Trash only. */
  from?: Target;
};

const KEEP = 30;
export const [recent, setRecent] = createSignal<Done[]>([]);

export function remember(text: string, rows: ThreadRow[], from?: Target) {
  if (!rows.length) return;
  setRecent([{ text, at: Date.now(), rows, from }, ...recent()].slice(0, KEEP));
}

/** The first of a change's conversations, read again where it is now; null when it is gone (deleted, expunged). */
export async function whereNow(d: Done): Promise<ThreadRow | null> {
  const [now] = await api.messageRows([d.rows[0].id]);
  return now ? asRow(now) : null;
}

/** Back in the Inbox from where Done or Trash took them, through the outbox like any move. */
export async function putBack(d: Done) {
  if (!d.from) return;
  await api.applyConversations(
    d.rows.map((r) => r.id),
    "inbox",
    d.from,
  );
  setRecent(recent().filter((x) => x !== d));
}

const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
export const doneLine = (d: Done) => `${d.text} · ${clock(d.at)}`;
