import { createEffect, createSignal, For, Show } from "solid-js";
import { api, type Mark } from "../api";
import type { Facts, Link } from "../facts";
import { Icon } from "./Icon";

const day = new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short" });
const dayYear = new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric" });
const time = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

/** "Thu 6 Nov · 10:00–16:00". */
function whenSaid(w: NonNullable<Facts["when"]>): string {
  const at = new Date(w.at * 1000);
  const d = (at.getFullYear() === new Date().getFullYear() ? day : dayYear).format(at);
  if (w.allDay) return d;
  return `${d} · ${time.format(at)}${w.end ? `–${time.format(new Date(w.end * 1000))}` : ""}`;
}

/** When a snooze for that day brings the mail back: an hour before a time, else 08:00 that morning. */
export function snoozeFor(w: NonNullable<Facts["when"]>): number {
  if (!w.allDay) return w.at - 3600;
  const d = new Date(w.at * 1000);
  d.setHours(8, 0, 0, 0);
  return d.getTime() / 1000;
}

function copy(text: string) {
  void navigator.clipboard.writeText(text).catch(() => {});
}

/** The companion's Details tab (docs/design/ui.md §4.2a–c): a newsletter's parts in reading view, what the newest
 * message holds, its links, and the person's marks. The open conversation draws it, as all of it is its own. */
export function Details(props: {
  facts: Facts | null;
  /** The headings of a newsletter in reading view. */
  contents: string[];
  onContents: (index: number) => void;
  /** "Links in this issue" for a newsletter, else "Links". */
  issue: boolean;
  onSnooze: (due: number) => void;
  marks: Mark[];
  /** The mark the keys are on. */
  current: number | null;
  /** Marks whose message is folded or whose text is gone. */
  hidden: (id: number) => boolean;
  onShowMark: (id: number) => void;
  onChanged: () => void;
  /** A mark just made with "Note": its field takes the keys. */
  noting: number | null;
}) {
  const facts = () => props.facts;
  const links = (): Link[] => facts()?.links ?? [];
  // Five links, then the rest on asking: a newsletter can carry a dozen.
  const [allLinks, setAllLinks] = createSignal(false);
  const shownLinks = () => (allLinks() || links().length <= 6 ? links() : links().slice(0, 5));
  const future = () => {
    const w = facts()?.when;
    return w && snoozeFor(w) > Date.now() / 1000 ? w : null;
  };
  // What was asked of the person is under Promises, for the whole conversation, so it is not repeated here.
  const found = () => !!facts() && !!(facts()!.when || facts()!.where || facts()!.codes.length);
  return (
    <div class="details">
      <Show when={props.contents.length > 1}>
        <section>
          <h2>In this issue</h2>
          <nav class="contents">
            <For each={props.contents}>{(h, i) => <button onClick={() => props.onContents(i())}>{h}</button>}</For>
          </nav>
        </section>
      </Show>
      <Show when={found()}>
        <section>
          <h2>In this message</h2>
          <div class="facts">
            <Show when={facts()!.when}>
              {(w) => (
                <div class="fact">
                  <span class="kind">When</span>
                  <strong>{whenSaid(w())}</strong>
                  <Show when={future()}>
                    {(f) => (
                      <button onClick={() => props.onSnooze(snoozeFor(f()))} title="Snooze it until then; it comes back unread">
                        <Icon name="clock" size={13} /> Snooze until then
                      </button>
                    )}
                  </Show>
                </div>
              )}
            </Show>
            <Show when={facts()!.where}>
              {(where) => (
                <div class="fact">
                  <span class="kind">Where</span>
                  <strong>{where()}</strong>
                  <button onClick={() => api.openUrl(`https://www.openstreetmap.org/search?query=${encodeURIComponent(where())}`)}>
                    Open the map
                  </button>
                </div>
              )}
            </Show>
            <For each={facts()!.codes}>
              {(code) => (
                <div class="fact">
                  <span class="kind">{code.label}</span>
                  <span class="code">{code.value}</span>
                  <button onClick={() => copy(code.value)}>Copy</button>
                </div>
              )}
            </For>
          </div>
        </section>
      </Show>
      <Show when={links().length}>
        <section>
          <h2>
            {props.issue ? "Links in this issue" : "Links"} · {links().length}
          </h2>
          <div class="links">
            <For each={shownLinks()}>
              {(l) => (
                <button class="link-card" title={l.href} onClick={() => api.openUrl(l.href)}>
                  <span class="text">{l.text}</span>
                  <span class="host">{l.host}</span>
                </button>
              )}
            </For>
            <Show when={shownLinks().length < links().length}>
              <button class="more" onClick={() => setAllLinks(true)}>
                {links().length - shownLinks().length} more
              </button>
            </Show>
          </div>
        </section>
      </Show>
      <Show when={props.contents.length < 2 && !found() && !links().length}>
        <p class="nothing">No day, place, code or link to pick out in the newest message.</p>
      </Show>
      <section>
        <h2>
          Your marks
          <Show when={props.marks.length}>
            {" "}· {props.marks.length}
            <span class="keys">
              <kbd>[</kbd>
              <kbd>]</kbd>
            </span>
          </Show>
        </h2>
        <Show when={props.marks.length} fallback={<p class="nothing">Select text in a message to mark it or add a note.</p>}>
          <div class="marks">
            <For each={props.marks}>
              {(m) => <MarkCard mark={m} on={props.current === m.id} hidden={props.hidden(m.id)} noting={props.noting === m.id} onShow={() => props.onShowMark(m.id)} onChanged={props.onChanged} />}
            </For>
          </div>
        </Show>
      </section>
      <Show when={found() || links().length}>
        <p class="found-here">Found on this computer, from the words of the mail.</p>
      </Show>
    </div>
  );
}

function MarkCard(props: { mark: Mark; on: boolean; hidden: boolean; noting: boolean; onShow: () => void; onChanged: () => void }) {
  let field: HTMLTextAreaElement | undefined;
  createEffect(() => props.noting && field?.focus());
  const save = (note: string) => {
    if (note.trim() !== props.mark.note) void api.setMarkNote(props.mark.id, note).then(props.onChanged);
  };
  return (
    <div class="mark" classList={{ on: props.on }}>
      <button class="passage" onClick={props.onShow} title={props.hidden ? "In a folded message: opens it" : "Show it in the message"}>
        {props.mark.text}
      </button>
      <textarea
        ref={field}
        aria-label="Note, only on this computer"
        placeholder="Add a note"
        value={props.mark.note}
        rows={2}
        onBlur={(e) => save(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape" || (e.key === "Enter" && !e.shiftKey)) {
            e.preventDefault();
            e.currentTarget.blur();
          }
        }}
      />
      <button class="remove" aria-label="Remove this mark" title="Remove this mark" onClick={() => void api.deleteMark(props.mark.id).then(props.onChanged)}>
        <Icon name="x" size={12} />
      </button>
    </div>
  );
}
