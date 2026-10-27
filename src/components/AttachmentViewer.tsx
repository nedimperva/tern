import { createEffect, createResource, createSignal, For, Match, on, onCleanup, onMount, Show, Switch } from "solid-js";
import { api, type ThreadMessage } from "../api";
import { Icon } from "./Icon";

type Shown =
  | { kind: "image" | "pdf" | "video" | "audio"; url: string }
  | { kind: "text"; text: string; table: string[][] | null }
  | { kind: "none"; reason: string };

const TEXT = /\.(txt|csv|tsv|log|md|json|xml|ya?ml|ini|conf|cfg|ics|vcf|eml|html?|css|js|ts|py|rs|sh|sql)$/i;
const IMAGE = /\.(png|jpe?g|gif|webp|bmp|avif)$/i;
/** Text past this is cut, so a huge log does not freeze the window. */
const TEXT_LIMIT = 2_000_000;

/** What the viewer can do with a file, by its type and then its name. SVG is shown only as an image, where its
 * scripts cannot run. */
export function viewable(name: string, mime: string): Shown["kind"] {
  if (mime === "application/pdf" || /\.pdf$/i.test(name)) return "pdf";
  if (mime.startsWith("image/") || IMAGE.test(name)) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("text/") || TEXT.test(name)) return "text";
  return "none";
}

/** Rows of a comma- or tab-separated file, quotes understood; null when it does not look like one. */
export function table(text: string, name: string): string[][] | null {
  const sep = /\.tsv$/i.test(name) ? "\t" : /\.csv$/i.test(name) ? "," : null;
  if (!sep) return null;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') (cell += '"'), i++;
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === sep) (row.push(cell), (cell = ""));
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      (row = []), (cell = "");
      if (rows.length >= 5000) break;
    } else cell += c;
  }
  if (cell || row.length) (row.push(cell), rows.push(row));
  return rows.length ? rows : null;
}

function size(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${Math.round(bytes / 1000)} KB`;
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

/** A received file shown inside Tern, over everything (docs/design/ui.md §4.11): pictures, PDFs, text and tables,
 * sound and video. ← and → step through the message's files; Esc closes. Anything else opens with the system. */
export function AttachmentViewer(props: { message: ThreadMessage; index: number; onClose: () => void }) {
  const [index, setIndex] = createSignal(props.index);
  const [zoomed, setZoomed] = createSignal(false);
  const [problem, setProblem] = createSignal("");
  const file = () => props.message.attachments[index()];
  const count = () => props.message.attachments.length;
  let url: string | null = null;
  const release = () => {
    if (url) URL.revokeObjectURL(url);
    url = null;
  };
  onCleanup(release);

  const [shown] = createResource(index, async (i): Promise<Shown> => {
    const f = props.message.attachments[i];
    const kind = viewable(f.name, f.mime);
    if (kind === "none") return { kind, reason: "Tern cannot show this kind of file." };
    let bytes: ArrayBuffer;
    try {
      bytes = await api.attachmentBytes(props.message.id, i);
    } catch (e) {
      return { kind: "none", reason: String(e) };
    }
    if (kind === "text") {
      const text = new TextDecoder().decode(bytes.slice(0, TEXT_LIMIT));
      return { kind, text, table: table(text, f.name) };
    }
    release();
    const type = kind === "pdf" ? "application/pdf" : f.mime || "application/octet-stream";
    url = URL.createObjectURL(new Blob([bytes], { type }));
    return { kind, url };
  });
  createEffect(on(index, () => (setZoomed(false), setProblem(""))));

  const step = (by: number) => setIndex((index() + by + count()) % count());
  const attempt = async (work: () => Promise<unknown>) => {
    setProblem("");
    try {
      await work();
    } catch (e) {
      setProblem(String(e));
    }
  };
  const openOutside = () => attempt(() => api.openAttachment(props.message.id, index()));
  const save = () => attempt(() => api.saveAttachment(props.message.id, index()));

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") props.onClose();
    else if (e.key === "ArrowRight" && count() > 1) step(1);
    else if (e.key === "ArrowLeft" && count() > 1) step(-1);
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") void save();
    else return;
    e.preventDefault();
    e.stopPropagation();
  };
  onMount(() => window.addEventListener("keydown", onKey, true));
  onCleanup(() => window.removeEventListener("keydown", onKey, true));

  return (
    <div class="viewer" role="dialog" aria-label={`Attachment: ${file().name}`}>
      <header>
        <span class="title">
          <strong>{file().name}</strong>
          <span>
            {size(file().size)}
            <Show when={count() > 1}> · {index() + 1} of {count()}</Show>
          </span>
        </span>
        <button onClick={() => void openOutside()}>Open with system</button>
        <button onClick={() => void save()}>
          Save <kbd>Ctrl S</kbd>
        </button>
        <button class="close" onClick={props.onClose} aria-label="Close">
          <kbd>Esc</kbd>
        </button>
      </header>
      <Show when={problem()}>
        <p class="viewer-problem">{problem()}</p>
      </Show>
      <div class="stage" onClick={(e) => e.target === e.currentTarget && props.onClose()}>
        <Show when={!shown.loading} fallback={<p class="viewer-note">Getting {file().name}…</p>}>
          <Switch>
            <Match when={shown()?.kind === "image" && (shown() as { url: string })}>
              {(s) => (
                <img
                  classList={{ zoomed: zoomed() }}
                  src={s().url}
                  alt={file().name}
                  title={zoomed() ? "Click to fit" : "Click for full size"}
                  onClick={() => setZoomed(!zoomed())}
                />
              )}
            </Match>
            <Match when={shown()?.kind === "pdf" && (shown() as { url: string })}>
              {(s) => <iframe class="pdf" src={s().url} title={file().name} />}
            </Match>
            <Match when={shown()?.kind === "video" && (shown() as { url: string })}>
              {(s) => <video src={s().url} controls />}
            </Match>
            <Match when={shown()?.kind === "audio" && (shown() as { url: string })}>
              {(s) => <audio src={s().url} controls />}
            </Match>
            <Match when={shown()?.kind === "text" && (shown() as { text: string; table: string[][] | null })}>
              {(s) => (
                <Show when={s().table} fallback={<pre class="text">{s().text}</pre>}>
                  {(rows) => (
                    <div class="sheet-wrap">
                      <table class="table-view">
                        <thead>
                          <tr>
                            <For each={rows()[0]}>{(c) => <th>{c}</th>}</For>
                          </tr>
                        </thead>
                        <tbody>
                          <For each={rows().slice(1)}>
                            {(r) => (
                              <tr>
                                <For each={r}>{(c) => <td>{c}</td>}</For>
                              </tr>
                            )}
                          </For>
                        </tbody>
                      </table>
                    </div>
                  )}
                </Show>
              )}
            </Match>
            <Match when={shown()?.kind === "none" && (shown() as { reason: string })}>
              {(s) => (
                <div class="viewer-note">
                  <p>{s().reason}</p>
                  <button class="primary" onClick={() => void openOutside()}>
                    Open with system
                  </button>
                </div>
              )}
            </Match>
          </Switch>
        </Show>
      </div>
      <Show when={count() > 1}>
        <button class="nav prev" onClick={() => step(-1)} aria-label="Previous file" title="Previous file (←)">
          <Icon name="chevron-left" size={20} />
        </button>
        <button class="nav next" onClick={() => step(1)} aria-label="Next file" title="Next file (→)">
          <Icon name="chevron-right" size={20} />
        </button>
      </Show>
    </div>
  );
}
