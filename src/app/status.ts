// What the status strip says: how sync is doing, changes waiting to go out, and the keys worth knowing.

import { createEffect, createSignal, onCleanup } from "solid-js";
import type { SyncState } from "../api";
import { markZero } from "../zero";
import { accounts, context, online, progress, ready, role, rows, searching, syncStates, waiting } from "./state";

// Missing messages below this are new mail arriving, not a backlog worth a "Downloading mail" sentence.
const BACKLOG = 100;

// Seconds, ticking only while work waits, so items leave their undo window without an event.
const [clock, setClock] = createSignal(Date.now() / 1000);
export { clock };

/** The strip's own effects; App runs this once. */
export function watchStatus() {
  createEffect(() => {
    if (!waiting().length) return;
    const timer = setInterval(() => setClock(Date.now() / 1000), 1000);
    onCleanup(() => clearInterval(timer));
  });
  // Today counts towards the streak once the inbox is empty.
  createEffect(() => inboxZero() && markZero());
}

/** Waiting work worth mentioning: past its undo window by a moment, tried before, or going out now. A change
 * still in its undo window is the toast's business. */
// Scheduled sends are not late until their time (or held after Tern was closed); they have their own link.
export const late = () =>
  waiting().filter((w) => !w.held && (w.sending || w.attempts > 0 || (w.notBefore + 2 <= clock() && !w.scheduled)));
export const scheduled = () => waiting().filter((w) => w.scheduled && !w.held && !w.sending);
// Scheduled sends whose time passed while Tern was closed: they wait for the person.
export const held = () => waiting().filter((w) => w.held);

export const paused = () => Object.values(syncStates()).some((s) => s === "paused");

/** "Downloading mail: 12,400 of 48,210" while an account is fetching a backlog. A few new messages are not a
 * download worth a sentence, and a folder whose messages can't be read must not keep it up forever: only accounts
 * still syncing count. */
const downloading = () => {
  const busy = progress().filter((p) => ["syncing", "connecting"].includes(syncStates()[p.accountId]));
  const sum = (key: "have" | "total" | "unchecked") => busy.reduce((n, p) => n + p[key], 0);
  const [have, total, unchecked] = [sum("have"), sum("total"), sum("unchecked")];
  if (!busy.length || (total - have < BACKLOG && !unchecked)) return null;
  if (!total) return "Downloading mail…";
  const n = (x: number) => x.toLocaleString();
  return `Downloading mail: ${n(have)} of ${n(total)}${unchecked ? "…" : ""}`;
};

/** What the search note says about mail whose text isn't here yet. */
export const coverage = () => {
  const all = progress().reduce((n, p) => n + p.messages, 0);
  const text = progress().reduce((n, p) => n + p.withText, 0);
  const n = (x: number) => x.toLocaleString();
  return text < all
    ? `The text of ${n(text)} of ${n(all)} messages is on this computer; the others were searched by sender and subject only.`
    : "Older mail without its text downloaded was searched by sender and subject only.";
};

/** One sentence for every account together, naming the account when only some are in trouble. */
export const syncSentence = () => {
  // A removed account's last state may linger until its worker stops.
  const entries = Object.entries(syncStates()).filter(([id]) => accounts().some((a) => a.id === Number(id)));
  const several = entries.length > 1;
  const inState = (s: SyncState) =>
    entries.filter(([, state]) => state === s).map(([id]) => accounts().find((a) => a.id === Number(id)));
  const refused = inState("auth-failed");
  if (refused.length) {
    const who = several && refused.length === 1 && refused[0] ? refused[0].email : "The server";
    if (refused.every((a) => a?.auth === "google"))
      return { text: `Google sign-in ended${several ? ` for ${refused[0]?.email}` : ""}. Sign in again in Settings (Ctrl+,).`, tone: "danger" };
    return { text: `${who} refused the password. Enter the new one in Settings (Ctrl+,).`, tone: "danger" };
  }
  const unreachable = inState("offline");
  if (unreachable.length) {
    if (!online() || (several && unreachable.length === entries.length))
      return { text: "Offline. Changes are kept and go out when you're back.", tone: "warn" };
    const host = unreachable.length === 1 && unreachable[0] ? unreachable[0].imapHost : "the mail server";
    return { text: `Can't reach ${host}. Trying again.`, tone: "warn" };
  }
  if (paused()) return { text: "Sync paused. Changes wait until you resume.", tone: "warn" };
  const download = downloading();
  if (download) return { text: download, tone: "ok" };
  if (entries.some(([, s]) => s === "connecting")) return { text: "Connecting…", tone: "warn" };
  return { text: entries.length ? "Up to date" : "", tone: "ok" };
};

/** The three most useful keys where the keyboard is now. */
export const hints = () =>
  context() === "conversation"
    ? [["R", "reply"], ["E", "done"], ["Esc", "back"]]
    : rows().length
      ? [["Enter", "open"], ["E", "done"], ["Ctrl K", "commands"]]
      : [["C", "compose"], ["?", "shortcuts"], ["Ctrl K", "commands"]];

/** The inbox empty, or its Important split (what Tern opens on); Other has its own tab count. */
export const inboxZero = () => ready() && !searching() && rows().length === 0 && ["inbox", "important"].includes(role());
