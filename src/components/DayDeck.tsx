import { createEffect, createResource, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import { api, type ThreadMessage, type ThreadRow } from "../api";
import { askReplies, suggestions } from "../ai";
import { waitingSince } from "../day";
import { typing } from "../keys";
import { aiOn } from "../settings";
import { AiReplies } from "./AiReplies";

/** A message's words for the card: its text, else its HTML's words, else the snippet. */
function words(m: ThreadMessage): string {
  if (m.bodyText?.trim()) return m.bodyText.split("\n").filter((l) => !l.trimStart().startsWith(">")).join("\n").trim();
  if (m.bodyHtml) {
    const doc = new DOMParser().parseFromString(m.bodyHtml, "text/html");
    doc.querySelectorAll("style,script,blockquote,.gmail_quote").forEach((n) => n.remove());
    doc.querySelectorAll("br,p,div,li,tr").forEach((n) => n.append("\n"));
    return (doc.body.textContent ?? "").replace(/\n{3,}/g, "\n\n").trim();
  }
  return m.snippet;
}

/** One at a time (docs/design/ui.md §4.7a): the conversations that need the person as a stack of cards, each with
 * its newest message and Reply, Snooze, Done or Later. Ends with the inbox as usual. */
export function DayDeck(props: {
  rows: ThreadRow[];
  /** Reply to the newest message, starting with `text` when it is a suggested reply. */
  onReply: (m: ThreadMessage, text?: string) => void;
  /** Snooze it; `then` runs once a time was picked. */
  onSnooze: (row: ThreadRow, then: () => void) => void;
  onDone: (row: ThreadRow) => Promise<unknown>;
  onClose: () => void;
  /** Something else (compose, a picker) has the keys. */
  paused: () => boolean;
}) {
  const [at, setAt] = createSignal(0);
  // Rows done or snoozed here leave the run.
  const [gone, setGone] = createSignal(new Set<string>());
  const key = (r: ThreadRow) => `${r.accountId}:${r.threadId}`;
  const left = () => props.rows.filter((r) => !gone().has(key(r)));
  const row = () => left()[Math.min(at(), left().length - 1)];
  const [thread] = createResource(
    () => row()?.id,
    (id) => api.thread(id),
  );
  const last = () => {
    const t = thread();
    return t?.length ? t[t.length - 1] : undefined;
  };
  // Back to the first card left whenever the list shrinks past where it was.
  createEffect(on(() => left().length, (n) => at() >= n && setAt(Math.max(0, n - 1))));
  const drop = (r: ThreadRow) => setGone(new Set([...gone(), key(r)]));
  const next = () => setAt(Math.min(at() + 1, left().length));
  const prev = () => setAt(Math.max(0, at() - 1));
  const done = () => {
    const r = row();
    if (!r) return;
    drop(r);
    void props.onDone(r);
  };
  const snooze = () => {
    const r = row();
    if (r) props.onSnooze(r, () => drop(r));
  };
  const reply = (text?: string) => {
    const m = last();
    if (m) props.onReply(m, text);
  };
  const finished = () => !row() || at() >= left().length;

  const onKey = (e: KeyboardEvent) => {
    if (props.paused() || typing(e) || e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key;
    // A held key repeats only moving between cards; a held `e` would otherwise finish card after card.
    if (e.repeat && !["j", "k", "ArrowRight", "ArrowLeft"].includes(k)) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (k === "Escape") props.onClose();
    else if (finished()) {
      if (k === "Enter") props.onClose();
      else return;
    } else if (k === "r") reply();
    else if (k === "h") snooze();
    else if (k === "e") done();
    else if (k === "j" || k === "ArrowRight") next();
    else if (k === "k" || k === "ArrowLeft") prev();
    else if (k === "q" && aiOn("replies", row()?.accountId)) askReplies();
    else if (["1", "2", "3"].includes(k) && suggestions()[Number(k) - 1]) reply(suggestions()[Number(k) - 1]);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };
  onMount(() => window.addEventListener("keydown", onKey, true));
  onCleanup(() => window.removeEventListener("keydown", onKey, true));

  return (
    <div class="day-deck" role="dialog" aria-label="One at a time">
      <header>
        <strong>Your morning</strong>
        <Show when={!finished()}>
          <span>
            {Math.min(at() + 1, left().length)} of {left().length}
          </span>
        </Show>
        <span class="bars" aria-hidden="true">
          <For each={left().slice(0, 12)}>{(_, i) => <span classList={{ on: i() <= at() }} />}</For>
        </span>
        <span class="spacer" />
        <button class="link" onClick={props.onClose}>
          Skip to the inbox <kbd>Esc</kbd>
        </button>
      </header>
      <div class="deck-stage">
        <Show
          when={!finished()}
          fallback={
            <div class="deck-end">
              <h2>That's everything that needed you.</h2>
              <button class="primary" onClick={props.onClose}>
                Go to the inbox <kbd>Enter</kbd>
              </button>
            </div>
          }
        >
          <div class="deck-under" aria-hidden="true" />
          <article class="deck-card">
            <div class="who">
              <strong>{row()!.fromName || row()!.fromAddr}</strong>
              <span>waiting since {waitingSince(row()!.date)}</span>
              <span class="spacer" />
              <Show when={row()!.count > 1}>
                <span class="count">{row()!.count} messages</span>
              </Show>
            </div>
            <h2>{row()!.subject || "(no subject)"}</h2>
            <div class="text">{last() ? words(last()!) : row()!.snippet}</div>
            <Show when={last()?.attachments.length}>
              <div class="files">{last()!.attachments.map((a) => a.name).join(" · ")}</div>
            </Show>
            <Show when={last() && aiOn("replies", row()!.accountId)}>
              <AiReplies id={last()!.id} onPick={(text) => reply(text)} />
            </Show>
            <div class="deck-actions">
              <button class="primary" onClick={() => reply()}>
                Reply <kbd>R</kbd>
              </button>
              <button onClick={snooze}>
                Snooze <kbd>H</kbd>
              </button>
              <button onClick={done}>
                Done <kbd>E</kbd>
              </button>
              <button onClick={next}>
                Later <kbd>J</kbd>
              </button>
            </div>
          </article>
        </Show>
      </div>
    </div>
  );
}
