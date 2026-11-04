// What the sync button says: how sync is doing and changes waiting to go out.

import { createEffect, createSignal, onCleanup } from "solid-js";
import type { SyncState } from "../api";
import { markZero } from "../zero";
import {
  accounts,
  listed,
  listKey,
  online,
  problems,
  progress,
  ready,
  role,
  rows,
  searching,
  syncStates,
  waiting,
} from "./state";

/** The rows on show were read for the list on show (not the one switched away from). */
export const listedHere = () => ready() && listed() === listKey();

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

/** What the title bar's sync button shows: an icon, a word or two when something needs a look, and a tone for its
 * dot. Most of the time it is the arrows and a green dot. The arrows turn only for a download worth a percent:
 * a server without IDLE is checked every minute and bodies come down in the background, and arrows turning for
 * that read as "always syncing". (Sync now turns them too, in the button.) */
export const syncButton = (): { icon: "refresh" | "alert" | "pause" | "wifi-off"; label: string; tone: string; turning: boolean } => {
  const sentence = syncSentence();
  const n = (x: number, one: string, many: string) => (x === 1 ? `1 ${one}` : `${x} ${many}`);
  if (sentence.tone === "danger") return { icon: "alert", label: "Sign in", tone: "danger", turning: false };
  if (problems().length) return { icon: "alert", label: n(problems().length, "problem", "problems"), tone: "danger", turning: false };
  if (held().length) return { icon: "alert", label: n(held().length, "to confirm", "to confirm"), tone: "danger", turning: false };
  if (sentence.text.startsWith("Offline")) return { icon: "wifi-off", label: "Offline", tone: "warn", turning: false };
  if (sentence.text.startsWith("Can't reach")) return { icon: "wifi-off", label: "Can't connect", tone: "warn", turning: false };
  if (paused()) return { icon: "pause", label: "Paused", tone: "warn", turning: false };
  const down = downloadShare();
  const busy = Object.values(syncStates()).some((s) => s === "syncing" || s === "connecting");
  if (down !== null) return { icon: "refresh", label: `${down}%`, tone: "busy", turning: true };
  if (late().length) return { icon: "refresh", label: n(late().length, "waiting", "waiting"), tone: "waiting", turning: false };
  return { icon: "refresh", label: "", tone: busy ? "busy" : "ok", turning: false };
};

/** How far a backlog download is, in percent; null when there is none worth showing. */
const downloadShare = () => {
  if (!downloading()) return null;
  const busy = progress().filter((p) => ["syncing", "connecting"].includes(syncStates()[p.accountId]));
  const have = busy.reduce((n, p) => n + p.have, 0);
  const total = busy.reduce((n, p) => n + p.total, 0);
  return total ? Math.min(99, Math.floor((have / total) * 100)) : 0;
};

/** Each account's state in a few words, for the sync panel. */
export const accountStates = () =>
  accounts().map((a) => {
    const s = syncStates()[a.id];
    const word =
      s === "auth-failed" ? "Sign-in refused" : s === "offline" ? "Can't connect" : s === "paused" ? "Paused" : s === "connecting" ? "Connecting" : s === "syncing" ? "Syncing" : "Up to date";
    const tone = s === "auth-failed" ? "danger" : s === "offline" || s === "paused" ? "warn" : s === "syncing" || s === "connecting" ? "busy" : "ok";
    return { id: a.id, email: a.email, word, tone };
  });

/** The inbox empty, or its Important split (what Tern opens on); Other has its own tab count. */
export const inboxZero = () => listedHere() && !searching() && rows().length === 0 && ["inbox", "important"].includes(role());
