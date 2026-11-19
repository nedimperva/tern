// A `.eml` file opened with Tern (idea 132): the message as Tern shows mail, read from the file and not stored.
// HTML runs in a sandboxed frame without scripts or remote images, as for any mail. Import puts it in an account's
// Imported folder through the outbox.

import { createResource, For, onCleanup, onMount, Show } from "solid-js";
import { api } from "../api";
import { accounts } from "../app/state";
import { showToast } from "../app/toast";
import { accountName } from "./settings/shared";

// Only the message's own styles and pictures that travel with it: nothing is fetched to show a file.
const CSP = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:">`;

export function EmlViewer(props: { path: string; onClose: () => void }) {
  const [eml] = createResource(() => props.path, (p) => api.openEml(p));
  const name = () => props.path.split(/[\\/]/).pop() ?? props.path;
  const importTo = async (account: number) => {
    try {
      const done = await api.importEml(props.path, account);
      showToast(`Importing into ${done.folder}`, [done.token]);
      props.onClose();
    } catch (e) {
      showToast(String(e), []);
    }
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") (e.preventDefault(), props.onClose());
    e.stopPropagation();
  };
  onMount(() => window.addEventListener("keydown", onKey, true));
  onCleanup(() => window.removeEventListener("keydown", onKey, true));

  return (
    <div class="viewer original eml" role="dialog" aria-label={`Mail file ${name()}`}>
      <header>
        <span class="title">
          <strong>{eml()?.subject || name()}</strong>
          <span>{name()}, a mail file on this computer</span>
        </span>
        <Show when={eml() && accounts().length}>
          <For each={accounts().slice(0, 3)}>
            {(a) => (
              <button type="button" onClick={() => void importTo(a.id)}>
                {accounts().length > 1 ? `Import to ${accountName(a)}` : "Import to Imported"}
              </button>
            )}
          </For>
        </Show>
        <button type="button" class="close" onClick={props.onClose} aria-label="Close">
          <kbd>Esc</kbd>
        </button>
      </header>
      <div class="stage">
        <Show when={!eml.error} fallback={<p class="viewer-problem">{String(eml.error)}</p>}>
          <Show when={eml()} fallback={<p class="viewer-note">Reading the file…</p>}>
            {(m) => (
              <article class="eml-card">
                <dl>
                  <dt>From</dt>
                  <dd>{m().fromName ? `${m().fromName} <${m().fromAddr}>` : m().fromAddr}</dd>
                  <dt>To</dt>
                  <dd>{m().to || "—"}</dd>
                  <Show when={m().cc}>
                    <dt>Cc</dt>
                    <dd>{m().cc}</dd>
                  </Show>
                  <dt>Date</dt>
                  <dd>{new Date(m().date * 1000).toLocaleString(undefined, { dateStyle: "full", timeStyle: "short" })}</dd>
                  <Show when={m().attachments.length}>
                    <dt>Files</dt>
                    <dd>{m().attachments.join(", ")}</dd>
                  </Show>
                </dl>
                <Show when={m().html} fallback={<pre class="text">{m().text ?? ""}</pre>}>
                  {(html) => <iframe class="eml-body" title="The message" sandbox="" srcdoc={`${CSP}${html()}`} />}
                </Show>
              </article>
            )}
          </Show>
        </Show>
      </div>
    </div>
  );
}
