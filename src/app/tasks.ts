// Todoist beside the open conversation (package 17 G): whether it is connected, the conversation's tasks, and the
// task box in the companion. Tasks go through the outbox with the usual undo; nothing reaches Todoist from here.

import { createSignal } from "solid-js";
import { api, type TaskRow, type ThreadMessage } from "../api";
import { promisesIn } from "../promises";
import { setSetting, settings } from "../settings";
import { showToast } from "./toast";

export const [todoistOn, setTodoistOn] = createSignal(false);
/** Reads the keyring once (Settings changes it), never Todoist. */
export const checkTodoist = () => void api.todoistConnected().then(setTodoistOn, () => {});

/** The open conversation's tasks, for its Tasks section and the pill under its subject. */
export const [taskRows, setTaskRows] = createSignal<TaskRow[]>([]);
let shownFor = 0;
export const loadTasks = (id: number) => {
  shownFor = id;
  if (!todoistOn()) return setTaskRows([]);
  void api.tasksOf(id).then((rows) => shownFor === id && setTaskRows(rows), () => {});
};

/** The task box, open in the companion: from which message, and what it starts with. */
export type TaskDraft = { message: number; title: string; due: string };
export const [taskBox, setTaskBox] = createSignal<TaskDraft | null>(null);

/** What a task from this conversation starts as: the first thing asked of you or that you said you'd do, else the
 * subject; with the day it names. */
export function suggestTask(messages: ThreadMessage[], mine: (addr: string) => boolean): { title: string; due: string } {
  const owed = promisesIn(messages, mine).filter((p) => p.yours && !settings.promisesDone.includes(p.key));
  const p = owed[owed.length - 1];
  if (p) return { title: p.text.replace(/\s*[?.!]+$/, ""), due: p.due ? dayWord(p.due) : "" };
  return { title: messages[0]?.subject || "", due: "" };
}

/** A day as Todoist reads it, in English: "fri", or "14 Nov" past the next week. */
export function dayWord(seconds: number): string {
  const d = new Date(seconds * 1000);
  const days = (d.getTime() - Date.now()) / 86_400_000;
  if (days < 6.5) return d.toLocaleDateString("en-GB", { weekday: "short" }).toLowerCase();
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

/** Opens the task box in the companion (opening the companion too). */
export function startTask(message: number, title: string, due = "") {
  if (!todoistOn()) return showToast("Connect Todoist in Settings → Todoist first", []);
  setSetting("companion", true);
  setTaskBox({ message, title, due });
}

/** Adds the task to the project chosen in Settings → Todoist (its Inbox when none is). */
export async function addTask(draft: TaskDraft, title: string, due: string, note: string) {
  setTaskBox(null);
  try {
    const label = settings.todoist.label.trim();
    const projectId = settings.todoist.project || null;
    const token = await api.queueTask(draft.message, { title, due, projectId, label: label || null, note: note || null });
    loadTasks(draft.message);
    showToast(`Added to Todoist: ${title}`, token, () => loadTasks(draft.message));
  } catch (e) {
    showToast(String(e), []);
  }
}
