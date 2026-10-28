import { createResource, createSignal, For, type JSX, onCleanup, Show } from "solid-js";
import { api, type MessageRow } from "../api";
import { when } from "./ConversationRow";

export type PersonActions = {
  write: (email: string) => void;
  search: (email: string) => void;
  open: (row: MessageRow) => void;
};

/** How long the pointer rests on a name before its card shows, and how long the card waits after it leaves. */
const SHOW_AFTER = 450;
const HIDE_AFTER = 200;

/** A sender's name that shows their card on hover or click (docs/design/ui.md §4.2): who they are, how often you
 * write each other, your latest conversations, and quick ways to write or find their mail. */
export function PersonCard(props: { name: string; email: string; colour: string; initials: string; actions: PersonActions; children: JSX.Element }) {
  const [open, setOpenNow] = createSignal(false);
  const [at, setAt] = createSignal({ top: 0, left: 0 });
  let anchor!: HTMLButtonElement;
  // The card is fixed to the window, as the header it sits in clips what overflows it; scrolling closes it.
  const setOpen = (show: boolean) => {
    if (show) {
      const r = anchor.getBoundingClientRect();
      setAt({ top: r.bottom + 6, left: Math.max(8, Math.min(r.left - 8, window.innerWidth - 348)) });
    }
    setOpenNow(show);
  };
  const onScroll = () => setOpenNow(false);
  window.addEventListener("scroll", onScroll, true);
  onCleanup(() => window.removeEventListener("scroll", onScroll, true));
  // Esc closes an open card before anything else hears it, and gives focus back to the name.
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "Escape" || !open()) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    setOpenNow(false);
    anchor.focus();
  };
  window.addEventListener("keydown", onKey, true);
  onCleanup(() => window.removeEventListener("keydown", onKey, true));
  const [copied, setCopied] = createSignal(false);
  const [card] = createResource(() => open() && props.email, (email) => api.contactCard(email));
  let timer: number | undefined;
  const later = (show: boolean, ms: number) => {
    clearTimeout(timer);
    timer = window.setTimeout(() => setOpen(show), ms);
  };
  onCleanup(() => clearTimeout(timer));

  const act = (e: MouseEvent, run: () => void) => {
    e.stopPropagation();
    setOpen(false);
    run();
  };
  const copy = async (e: MouseEvent) => {
    e.stopPropagation();
    await navigator.clipboard.writeText(props.email).catch(() => {});
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  };

  return (
    <span
      class="person-wrap"
      // A real move, not the page shifting under a still pointer (opening a conversation puts a name there).
      onPointerMove={(e) => (open() ? clearTimeout(timer) : (e.movementX || e.movementY) && later(true, SHOW_AFTER))}
      onPointerLeave={() => later(false, HIDE_AFTER)}
    >
      <button
        type="button"
        class="person"
        ref={anchor}
        aria-haspopup="dialog"
        aria-expanded={open()}
        onClick={(e) => {
          e.stopPropagation();
          clearTimeout(timer);
          setOpen(!open());
        }}
      >
        {props.children}
      </button>
      <Show when={open()}>
        {/* biome-ignore lint/a11y/useKeyWithClickEvents: only keeps a click in the card from reaching the message header */}
        <div
          class="person-card"
          role="dialog"
          aria-label={props.name || props.email}
          style={{ top: `${at().top}px`, left: `${at().left}px` }}
          onClick={(e) => e.stopPropagation()}
        >
          <div class="person-head">
            <span class="person-avatar" style={{ background: props.colour }}>
              {props.initials}
            </span>
            <span>
              <strong>{props.name || card()?.name || props.email}</strong>
              <button class="link person-addr" onClick={(e) => void copy(e)} title="Copy address">
                {copied() ? "Copied" : props.email}
              </button>
            </span>
          </div>
          <Show when={card()}>
            {(c) => (
              <>
                <p class="person-counts">
                  {c().received === 1 ? "1 message from them" : `${c().received} messages from them`} ·{" "}
                  {c().sent === 1 ? "1 to them" : `${c().sent} to them`}
                </p>
                <Show when={c().recent.length}>
                  <ul class="person-recent">
                    <For each={c().recent}>
                      {(m) => (
                        <li>
                          <button onClick={(e) => act(e, () => props.actions.open(m))}>
                            <span class="subject">{m.subject || "(no subject)"}</span>
                            <time>{when(m.date)}</time>
                          </button>
                        </li>
                      )}
                    </For>
                  </ul>
                </Show>
              </>
            )}
          </Show>
          <div class="person-actions">
            <button class="primary" onClick={(e) => act(e, () => props.actions.write(props.email))}>
              Write to them
            </button>
            <button onClick={(e) => act(e, () => props.actions.search(props.email))}>All their mail</button>
          </div>
        </div>
      </Show>
    </span>
  );
}
