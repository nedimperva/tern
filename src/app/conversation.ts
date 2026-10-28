// The open conversation: opening and closing it, and moving between its messages.

import { batch, createEffect, on } from "solid-js";
import { api, type ThreadRow } from "../api";
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
import { showToast } from "./toast";

let readTimer: number | undefined;

/** Opens a conversation. From search, `row` is the message that matched: it opens and comes into view, wherever
 * it sits in the conversation; otherwise the newest message is the one to read. */
export async function open(row: ThreadRow | undefined, matched = searching()) {
  clearTimeout(readTimer);
  if (!row) return close();
  // A draft being written in Tern opens in compose, not as a conversation.
  if (folders().find((f) => f.id === row.folderId)?.role === "drafts") {
    const record = await api.draftForMessage(row.id);
    if (record) return resume(record);
  }
  setOpenRow(row);
  const found = await api.thread(row.id);
  if (openRow() !== row) return;
  // The conversation lists each message once, so the copy that matched may be another folder's row of it.
  const at = !matched
    ? -1
    : found.findIndex((m) => m.id === row.id) >= 0
      ? found.findIndex((m) => m.id === row.id)
      : found.findIndex((m) => m.date === row.date && m.fromAddr === row.fromAddr && m.subject === row.subject);
  batch(() => {
    setMessages(found);
    // The newest message and anything unread start open, as they are what there is to read.
    const open = new Set(found.filter((m, i) => !m.seen || i === found.length - 1).map((m) => m.id));
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
  clearTimeout(readTimer);
  batch(() => (setOpenRow(null), setMessages([])));
}

export const toggleMessage = (index: number) => {
  const m = messages[index];
  if (!m) return;
  const next = new Set(expanded());
  if (next.has(m.id)) next.delete(m.id);
  else next.add(m.id);
  batch(() => (setExpanded(next), setMessageFocus(index)));
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
  createEffect(on(openRow, (row) => (row ? void api.muted(row.id).then(setOpenMuted) : setOpenMuted(false))));
}

export async function unmute() {
  const row = openRow();
  if (!row) return;
  await api.mute([row.id], false);
  setOpenMuted(false);
  showToast("Unmuted", []);
}
