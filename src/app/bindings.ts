// The window's keys, and the two lists made from them: the conversation's `…` menu and the command palette.
// App wraps each in a memo.

import { api } from "../api";
import { askReplies, suggestions, summon } from "../ai";
import type { MenuItem } from "../components/ActionMenu";
import type { Command } from "../components/CommandBar";
import { switchReading } from "../components/ConversationView";
import { ROLE_NAMES, targetOf } from "../components/Rail";
import { start } from "../day";
import { keyLabel, type Binding } from "../keys";
import { jumpMark } from "../marks";
import { aiOn, setSetting, settings } from "../settings";
import {
  accountOf,
  act,
  folderName,
  markAllRead,
  moveToSplit,
  mute,
  restartToUpdate,
  shelve,
  startLabel,
  switchAccount,
  targets,
  toggleRead,
  toggleStar,
  wake,
} from "./actions";
import { moveMessage, open, toggleMessage, unmute, viewFiles } from "./conversation";
import { newMessage, reply, respond } from "./composing";
import { lineHere, runDeck } from "./deck";
import { escape, extend, go, isSaved, move, nextSplit, runSearch, toggleSaved, toggleSelected } from "./list";
import { keyOf } from "./rows";
import {
  accounts,
  choose,
  context,
  current,
  focus,
  focusMode,
  folders,
  home,
  messageFocus,
  messages,
  openMuted,
  openRow,
  palette,
  perf,
  problems,
  rail,
  rows,
  searchBox,
  setExpanded,
  setFocusMode,
  setPalette,
  setPerf,
  setRail,
  setReviewing,
  setSelection,
  setSettingsOpen,
  setSetup,
  setSheet,
  setSnoozing,
  searching,
  update,
} from "./state";
import { late, paused } from "./status";
import { undo } from "./toast";

export const bindings = (): Binding[] => [
  { keys: "j", name: "Next conversation", run: () => move(1), repeat: true },
  { keys: "k", name: "Previous conversation", run: () => move(-1), repeat: true },
  { keys: "ArrowDown", name: "Next conversation", run: () => move(1), hidden: true, repeat: true },
  { keys: "ArrowUp", name: "Previous conversation", run: () => move(-1), hidden: true, repeat: true },
  { keys: "PageDown", name: "Down a page", run: () => move(15), hidden: true, repeat: true },
  { keys: "PageUp", name: "Up a page", run: () => move(-15), hidden: true, repeat: true },
  { keys: "Home", name: "First conversation", run: () => move(-focus()), hidden: true },
  { keys: "End", name: "Last conversation", run: () => move(rows().length), hidden: true },
  { keys: "Enter", name: "Open conversation", context: "list", run: () => open(current()) },
  { keys: "o", name: "Open conversation", context: "list", run: () => open(current()), hidden: true },
  { keys: "Escape", name: "Back", run: escape },
  ...(lineHere()
    ? [
        { keys: "1", name: "Go through what needs you", context: "list" as const, run: () => start()?.needYou.length && runDeck("need") },
        { keys: "2", name: "Go through what came back from snooze", context: "list" as const, run: () => start()?.back.length && runDeck("back") },
        { keys: "3", name: "Go through what has no answer yet", context: "list" as const, run: () => start()?.waiting.length && runDeck("waiting") },
        { keys: "4", name: "Updates and lists (Other)", context: "list" as const, run: () => go({ role: "bulk" }) },
      ]
    : []),
  { keys: "e", name: "Done (archive)", run: () => act("archive") },
  { keys: "E", name: "Not done (back to Inbox)", run: () => act("inbox") },
  { keys: "!", name: "Mark as spam", run: () => act("junk") },
  { keys: "m", name: "Mute", run: mute },
  { keys: "#", name: "Move to Trash", run: () => act("trash") },
  { keys: "Delete", name: "Move to Trash", run: () => act("trash"), hidden: true },
  { keys: "s", name: "Star or unstar", run: toggleStar },
  { keys: "u", name: "Mark read or unread", run: toggleRead },
  { keys: "U", name: "Mark all read here", context: "list", run: () => void markAllRead() },
  { keys: "x", name: "Select conversation", context: "list", run: () => toggleSelected() },
  { keys: "J", name: "Select and move down", context: "list", run: () => extend(1), repeat: true },
  { keys: "K", name: "Select and move up", context: "list", run: () => extend(-1), repeat: true },
  { keys: "Ctrl+a", name: "Select all", context: "list", run: () => setSelection(new Set(rows().map(keyOf))) },
  { keys: "n", name: "Next message", context: "conversation", run: () => moveMessage(1), repeat: true },
  { keys: "p", name: "Previous message", context: "conversation", run: () => moveMessage(-1), repeat: true },
  { keys: "o", name: "Expand or collapse message", context: "conversation", run: () => toggleMessage(messageFocus()) },
  { keys: "]", name: "Next mark", context: "conversation", run: () => jumpMark(1), repeat: true },
  { keys: "B", name: "Reading view or the original look", context: "conversation", run: switchReading },
  { keys: "i", name: "Show or hide the column beside the messages", context: "conversation", run: () => setSetting("readingColumn", !settings.readingColumn) },
  { keys: "[", name: "Previous mark", context: "conversation", run: () => jumpMark(-1), repeat: true },
  { keys: "Enter", name: "Reply all", context: "conversation", run: () => respond(messages[messageFocus()], "replyAll") },
  { keys: "f", name: "Forward", context: "conversation", run: () => respond(messages[messageFocus()], "forward") },
  { keys: "O", name: "Expand all messages", context: "conversation", run: () => setExpanded(new Set(messages.map((m) => m.id))) },
  { keys: "r", name: "Reply (or continue the draft)", context: "conversation", run: reply },
  { keys: "v", name: "View attachments", context: "conversation", run: viewFiles },
  ...(aiOn("summaries", messages[0]?.accountId)
    ? [{ keys: "S", name: "Summarize with AI", context: "conversation" as const, run: summon }]
    : []),
  ...(aiOn("replies", messages[0]?.accountId)
    ? [{ keys: "q", name: "Suggest replies with AI", context: "conversation" as const, run: askReplies }]
    : []),
  ...suggestions().map((text, i) => ({
    keys: String(i + 1),
    name: `Reply: ${text}`,
    context: "conversation" as const,
    run: () => respond(messages[messages.length - 1], "reply", undefined, text),
    hidden: true,
  })),
  { keys: "F", name: focusMode() ? "Show the list again" : "Focus mode (hide the list)", context: "conversation", run: () => setFocusMode(!focusMode()) },
  { keys: "z", name: "Undo", run: undo },
  { keys: "h", name: "Snooze", run: () => targets().length > 0 && setSnoozing(targets()) },
  { keys: "L", name: "Read later (on the shelf: back to the inbox)", run: () => void shelve() },
  { keys: "l", name: "Label", run: startLabel },
  { keys: "H", name: "Back from snooze now", run: () => void wake() },
  { keys: "c", name: "Compose", run: newMessage },
  { keys: "/", name: "Search", run: () => searchBox.input?.focus() },
  { keys: "Tab", name: "Next split", context: "list", run: () => nextSplit(1) },
  { keys: "Shift+Tab", name: "Previous split", context: "list", run: () => nextSplit(-1) },
  { keys: "g i", name: "Go to Inbox", run: () => go(home()) },
  { keys: "g h", name: "Go to Snoozed", run: () => go({ role: "snoozed" }) },
  { keys: "g r", name: "Go to Read later", run: () => go({ role: "later" }) },
  { keys: "g m", name: "Go to Marks (what you marked and noted)", run: () => go({ role: "marked" }) },
  { keys: "g s", name: "Go to Starred", run: () => go({ role: "starred" }) },
  { keys: "g e", name: "Go to Done (Archive)", run: () => go({ role: "archive" }) },
  { keys: "g t", name: "Go to Sent", run: () => go({ role: "sent" }) },
  { keys: "g d", name: "Go to Drafts", run: () => go({ role: "drafts" }) },
  { keys: "g a", name: "Go to All Mail", run: () => go({ role: "all" }) },
  { keys: "g !", name: "Go to Spam", run: () => go({ role: "junk" }) },
  { keys: "g l", name: "Go to folder …", run: () => choose("Go to folder …") },
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => ({
    keys: `Ctrl+${n}`,
    name: `Go to account ${n}`,
    run: () => switchAccount(n - 1),
    hidden: true,
  })),
  { keys: "g ;", name: "Edit snippets", run: () => setSettingsOpen("Snippets") },
  { keys: "?", name: "Keyboard shortcuts", run: () => setSheet(true) },
  { keys: "Ctrl+,", name: "Settings", run: () => setSettingsOpen("Appearance") },
  { keys: "Ctrl+q", name: "Quit Tern", run: () => void api.quit() },
  { keys: "", name: paused() ? "Resume sync" : "Pause sync", run: () => void api.setSyncPaused(!paused()) },
  ...(update() ? [{ keys: "", name: `Restart to update to ${update()}`, run: restartToUpdate }] : []),
  { keys: "Ctrl+P", name: "Performance overlay", run: () => setPerf(!perf()) },
  { keys: "Ctrl+\\", name: "Accounts and folders", run: () => setRail(!rail()) },
  { keys: "Ctrl+k", name: "Command palette", run: () => setPalette(!palette()), hidden: true },
];

/** The conversation's `…` menu: its actions in the order people reach for them, each with its key. */
const MENU_KEYS = ["r", "Enter", "f", "v", "e", "h", "L", "s", "u", "m", "!", "#", "O", "F"];
export const menu = (all: Binding[]) => {
  const items: MenuItem[] = MENU_KEYS.flatMap((k) => {
    const b = all.find((b) => b.keys === k && (!b.context || b.context === "conversation"));
    if (!b || (k === "v" && !messages.some((m) => m.attachments.length))) return [];
    return [{ name: b.name, keys: keyLabel(b.keys), run: () => void b.run() }];
  });
  items.splice(items.findIndex((i) => i.name === "Mark as spam"), 0, { name: "Move to …", run: () => void choose("Move to …") });
  return items;
};

/** The command palette: every key that works here, then what has no key. */
export const commands = (all: Binding[]): Command[] => [
  ...all
    .filter((b) => !b.hidden && !b.keys.startsWith("Ctrl+,") && b.keys !== "g l" && (!b.context || b.context === context()))
    .map((b) => ({
      name: b.name,
      keys: keyLabel(b.keys),
      group: b.keys.startsWith("g ") ? "Go to" : "Actions",
      run: () => void b.run(),
    })),
  ...(searching() ? [{ name: isSaved() ? "Forget this search" : "Save this search", group: "Actions", run: toggleSaved }] : []),
  ...settings.savedSearches.map((q) => ({ name: q, group: "Saved searches", run: () => runSearch(q) })),
  ...(settings.splitInbox
    ? [
        { name: "Move sender to Other", group: "Actions", run: () => void moveToSplit(true) },
        { name: "Move sender to Important", group: "Actions", run: () => void moveToSplit(false) },
      ]
    : []),
  {
    name: "Move to …",
    group: "Actions",
    args: () => {
      // Folders of the accounts the conversations are in, except where they are now.
      const hit = targets();
      const accountIds = new Set(hit.map((r) => r.accountId));
      const here = new Set(hit.map((r) => r.folderId));
      return folders()
        .filter((f) => accountIds.has(f.accountId) && !here.has(f.id))
        .map((f) => ({
          name: accounts().length > 1 ? `${folderName(f)} — ${accountOf(f.accountId)}` : folderName(f),
          run: () => void act({ moveTo: f.id }),
        }));
    },
  },
  {
    name: "Go to folder …",
    keys: keyLabel("g l"),
    group: "Go to",
    args: () =>
      folders().map((f) => ({
        name: accounts().length > 1 ? `${folderName(f)} — ${accountOf(f.accountId)}` : folderName(f),
        run: () => go(targetOf(f)),
      })),
  },
  {
    name: "Switch account …",
    keys: "Ctrl 1–9",
    group: "Accounts",
    args: () => accounts().map((a, i) => ({ name: a.email, keys: `Ctrl ${i + 1}`, run: () => switchAccount(i) })),
  },
  {
    name: "Theme …",
    group: "Settings",
    args: () =>
      (["system", "light", "dark"] as const).map((t) => ({
        name: t === "system" ? "Follow the system" : t === "light" ? "Light" : "Dark",
        run: () => setSetting("theme", t),
      })),
  },
  { name: "Settings", keys: keyLabel("Ctrl+,"), group: "Settings", run: () => setSettingsOpen("Appearance") },
  ...(openRow() && openMuted() ? [{ name: "Unmute conversation", group: "Actions", run: () => void unmute() }] : []),
  { name: "Add account", group: "Accounts", run: () => setSetup(true) },
  ...(problems().length || late().length
    ? [{ name: problems().length ? "Review changes that didn't go through" : "Review changes waiting to go out", run: () => setReviewing(true) }]
    : []),
  ...folders().map((f) => ({
    group: "Go to",
    name: `Go to ${ROLE_NAMES[f.role] ?? f.name} — ${accounts().find((a) => a.id === f.accountId)?.email ?? ""}`,
    run: () => go({ folder: f.id }),
  })),
];
