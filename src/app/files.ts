// Your mail as files (package 17 I): a message as .eml, a folder or a search as mbox. The sources come from the
// server, as Tern keeps no whole copy of a message here; an export says how far it is and can be stopped.

import { createSignal } from "solid-js";
import { api } from "../api";
import { title } from "./list";
import { accounts, folders, query, searching, target } from "./state";
import { showToast } from "./toast";

/** An export that is running: how far it is, for the status strip. */
export const [exporting, setExporting] = createSignal<{ done: number; total: number } | null>(null);

/** A folder (not a role like the unified inbox) or a search can be exported. */
export const exportable = () => searching() || "folder" in target();
export const exportName = () => (searching() ? `“${query().trim()}”` : title() || "this folder");

export async function saveEml(id: number) {
  try {
    if (await api.saveEml(id)) showToast("Saved as .eml", []);
  } catch (e) {
    showToast(String(e), []);
  }
}

/** Exports the list on show: the folder, or the search's results. */
export async function exportList() {
  if (exporting()) return;
  const t = target();
  const folder = !searching() && "folder" in t ? t.folder : null;
  const q = searching() ? query().trim() : null;
  const name = searching() ? `Search ${q}` : title() || "Mail";
  const stop = api.onExportProgress((p) => setExporting(p));
  try {
    const done = await api.exportMbox(folder, q, name);
    if (!done) return;
    const said = `${done.written.toLocaleString()} ${done.written === 1 ? "message" : "messages"} saved to ${done.path}`;
    const gone = done.missing ? `; ${done.missing} weren't on the server` : "";
    showToast(done.stopped ? `Stopped: ${said}${gone}` : `${said}${gone}`, []);
  } catch (e) {
    showToast(String(e), []);
  } finally {
    stop();
    setExporting(null);
  }
}

/** Imports an mbox file into a new folder of the account on show (the first one in a unified view). The messages
 * go up to the server after the undo window and come back down like any other mail. */
export async function importMbox() {
  const t = target();
  const account = ("folder" in t ? folders().find((f) => f.id === t.folder)?.accountId : undefined) ?? accounts()[0]?.id;
  if (account == null) return;
  try {
    const queued = await api.importMbox(account);
    if (!queued) return;
    const n = queued.total.toLocaleString();
    showToast(`Importing ${n} ${queued.total === 1 ? "message" : "messages"} into ${queued.folder}`, [queued.token]);
  } catch (e) {
    showToast(String(e), []);
  }
}

export const stopExport = () => api.exportStop();
