// The open conversation: opening and closing it, and moving between its messages.

import { batch, createEffect, on } from "solid-js";
import { api, type ThreadRow } from "../api";
import { glide, settle, shift, type Shift } from "../motion";
import { settings } from "../settings";
import { act } from "./actions";
import { resume } from "./composing";
import {
  expanded,
  folders,
  messageFocus,
  messages,
  openRow,
  searching,
  setExpanded,
  setMessageFocus,
  setMessages,
  setOpenMuted,
  setOpenRow,
  setViewing,
} from "./state";
import { keyOf } from "./rows";
import { showToast } from "./toast";

let readTimer: number | undefined;
let openGen = 0;

/** Opens a conversation. From search, `row` is the message that matched: it opens and comes into view, wherever
 * it sits in the conversation; otherwise the newest message is the one to read. It comes in from the right, or
 * fades in where another stood; `how` says otherwise, as for the one after a mail that was just done. */
export async function open(row: ThreadRow | undefined, matched = searching(), how?: Shift) {
  clearTimeout(readTimer);
  if (!row) return close();
  if (openRow() && keyOf(openRow()!) === keyOf(row)) return show(row, matched);
  // With view transitions (Windows) the change runs later, once the old screen is captured: wait for it there too.
  await new Promise<void>((done) =>
    shift(how ?? (openRow() ? "switch" : "open"), () => {
      const loading = show(row, matched).finally(done);
      return settle(loading);
    }),
  );
}

async function show(row: ThreadRow, matched: boolean) {
  const gen = ++openGen;
  // A draft being written in Tern opens in compose, not as a conversation.
  if (folders().find((f) => f.id === row.folderId)?.role === "drafts") {
    const record = await api.draftForMessage(row.id);
    if (gen !== openGen) return;
    if (record) return resume(record);
  }
  const found = await api.thread(row.id);
  if (gen !== openGen) return;
  // The conversation lists each message once, so the copy that matched may be another folder's row of it.
  const at = !matched
    ? -1
    : found.findIndex((m) => m.id === row.id) >= 0
      ? found.findIndex((m) => m.id === row.id)
      : found.findIndex((m) => m.date === row.date && m.fromAddr === row.fromAddr && m.subject === row.subject);
  batch(() => {
    setOpenRow(row);
    setMessages(found);
    // Only the newest message starts open (owner, 2026-10-29): the rest are one line each, opened as the person
    // goes. Unread ones keep their dot, and "Since you last read" jumps to the first.
    const open = new Set(found.length ? [found[found.length - 1].id] : []);
    if (at >= 0) open.add(found[at].id);
    setExpanded(open);
    setMessageFocus(at >= 0 ? at : Math.max(0, found.length - 1));
  });
  if (at >= 0 && at < found.length - 1) {
    const id = found[at].id;
    requestAnimationFrame(() => document.querySelector(`.conversation [data-message="${id}"]`)?.scrollIntoView({ block: "start" }));
  }
  if (row.unread > 0 && settings.readAfterMs >= 0) {
    readTimer = window.setTimeout(() => {
      if (openRow() === row) void act("markRead", [row], false);
    }, settings.readAfterMs);
  }
}

export function close() {
  openGen++;
  clearTimeout(readTimer);
  const now = () => batch(() => (setOpenRow(null), setMessages([])));
  if (openRow()) shift("close", now);
  else now();
}

export const toggleMessage = (index: number) => {
  const m = messages[index];
  if (!m) return;
  const next = new Set(expanded());
  if (next.has(m.id)) next.delete(m.id);
  else next.add(m.id);
  glide(() => batch(() => (setExpanded(next), setMessageFocus(index))));
};
export const moveMessage = (by: number) => setMessageFocus(Math.max(0, Math.min(messages.length - 1, messageFocus() + by)));

/** `v`: the focused message's files in the viewer, else the newest message's that has some. */
export function viewFiles() {
  const focused = messages[messageFocus()];
  const m = focused?.attachments.length ? focused : [...messages].reverse().find((x) => x.attachments.length);
  if (m) setViewing({ message: m, index: 0 });
}

/** The conversation's own effects; App runs this once. */
export function watchConversation() {
  createEffect(
    on(openRow, (row) => {
      if (!row) return void setOpenMuted(false);
      void api.muted(row.id).then((m) => openRow()?.id === row.id && setOpenMuted(m), () => {});
    }),
  );
}

export async function unmute() {
  const row = openRow();
  if (!row) return;
  await api.mute([row.id], false);
  setOpenMuted(false);
  showToast("Unmuted", []);
}
