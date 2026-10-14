import { createSignal, For, onMount, Show } from "solid-js";
import type { Account, Draft } from "../api";
import { RecipientField, splitAddresses, validAddress } from "./RecipientField";

export type ComposeInit = {
  accountId?: number;
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  body?: string;
  inReplyTo?: string | null;
  references?: string[];
  /** Where the cursor starts: To for new mail and forwards, the body for replies. */
  focus?: "to" | "body";
  /** Shown at the bottom of the open conversation rather than as a dialog. */
  inline?: boolean;
};

/** New mail, reply or forward (docs/design/ui.md §4.4). Ctrl+Enter sends, Ctrl+Shift+Enter sends and marks the
 * conversation done; Ctrl+Shift+C / B add Cc / Bcc; Esc closes. */
export function Compose(props: {
  accounts: Account[];
  init: ComposeInit;
  onSend: (accountId: number, draft: Draft, done: boolean) => void;
  onClose: () => void;
}) {
  const [from, setFrom] = createSignal(props.init.accountId ?? props.accounts[0]?.id);
  const [to, setTo] = createSignal(props.init.to ?? []);
  const [cc, setCc] = createSignal(props.init.cc ?? []);
  const [bcc, setBcc] = createSignal(props.init.bcc ?? []);
  const [showCc, setShowCc] = createSignal((props.init.cc ?? []).length > 0);
  const [showBcc, setShowBcc] = createSignal((props.init.bcc ?? []).length > 0);
  const [subject, setSubject] = createSignal(props.init.subject ?? "");
  const [body, setBody] = createSignal(props.init.body ?? "");
  const [problem, setProblem] = createSignal("");
  let toInput!: HTMLInputElement;
  let ccInput: HTMLInputElement | undefined;
  let bccInput: HTMLInputElement | undefined;
  let text!: HTMLTextAreaElement;

  /** The body grows with what is in it (§4.4); the dialog or the conversation scrolls, not the field. */
  const grow = () => {
    text.style.height = "auto";
    text.style.height = `${text.scrollHeight}px`;
  };

  onMount(() => {
    grow();
    if ((props.init.focus ?? (props.init.to?.length ? "body" : "to")) === "body") {
      text.setSelectionRange(0, 0);
      text.focus({ preventScroll: true });
      text.scrollIntoView({ block: "nearest" });
    } else toInput.focus();
  });

  const send = (done: boolean) => {
    // Whatever is still typed in a field counts as entered.
    const all = (list: string[], input?: HTMLInputElement) => [...list, ...splitAddresses(input?.value ?? "")];
    const recipients = { to: all(to(), toInput), cc: all(cc(), ccInput), bcc: all(bcc(), bccInput) };
    const everyone = [...recipients.to, ...recipients.cc, ...recipients.bcc];
    if (!everyone.length) return setProblem("Add someone to send it to.");
    const bad = everyone.filter((a) => !validAddress(a));
    if (bad.length) return setProblem(`${bad.join(", ")} does not look like an address.`);
    if (from() == null) return;
    props.onSend(
      from()!,
      {
        ...recipients,
        subject: subject(),
        body: body(),
        inReplyTo: props.init.inReplyTo ?? null,
        references: props.init.references ?? [],
      },
      done,
    );
  };

  const onKeyDown = (e: KeyboardEvent) => {
    const ctrl = e.ctrlKey || e.metaKey;
    if (e.key === "Escape") props.onClose();
    else if (ctrl && e.key === "Enter") send(e.shiftKey);
    else if (ctrl && e.shiftKey && e.key.toLowerCase() === "c") {
      setShowCc(true);
      queueMicrotask(() => ccInput?.focus());
    } else if (ctrl && e.shiftKey && e.key.toLowerCase() === "b") {
      setShowBcc(true);
      queueMicrotask(() => bccInput?.focus());
    } else return;
    e.preventDefault();
    e.stopPropagation();
  };

  const form = (
    <form class="compose" classList={{ inline: props.init.inline }} onKeyDown={onKeyDown} onSubmit={(e) => (e.preventDefault(), send(false))}>
      <Show when={props.accounts.length > 1}>
        <label class="field">
          <span class="label">From</span>
          <select value={from()} onChange={(e) => setFrom(Number(e.currentTarget.value))}>
            <For each={props.accounts}>
              {(a) => <option value={a.id}>{a.displayName ? `${a.displayName} <${a.email}>` : a.email}</option>}
            </For>
          </select>
        </label>
      </Show>
      <RecipientField label="To" value={to()} onChange={setTo} ref={(el) => (toInput = el)} />
      <Show when={showCc()}>
        <RecipientField label="Cc" value={cc()} onChange={setCc} ref={(el) => (ccInput = el)} />
      </Show>
      <Show when={showBcc()}>
        <RecipientField label="Bcc" value={bcc()} onChange={setBcc} ref={(el) => (bccInput = el)} />
      </Show>
      <Show when={!props.init.inline || !props.init.inReplyTo}>
        <label class="field">
          <span class="label">Subject</span>
          <input value={subject()} onInput={(e) => setSubject(e.currentTarget.value)} />
        </label>
      </Show>
      <textarea ref={text} value={body()} onInput={(e) => (setBody(e.currentTarget.value), grow())} aria-label="Message" />
      <Show when={problem()}>
        <p class="error">{problem()}</p>
      </Show>
      <footer>
        <button type="submit" class="primary">
          Send <kbd>Ctrl ↵</kbd>
        </button>
        <button type="button" onClick={() => send(true)}>
          Send & Done <kbd>Ctrl Shift ↵</kbd>
        </button>
        <span class="extras">
          <Show when={!showCc()}>
            <button type="button" class="link" onClick={() => (setShowCc(true), queueMicrotask(() => ccInput?.focus()))}>
              Cc
            </button>
          </Show>
          <Show when={!showBcc()}>
            <button type="button" class="link" onClick={() => (setShowBcc(true), queueMicrotask(() => bccInput?.focus()))}>
              Bcc
            </button>
          </Show>
        </span>
        <button type="button" class="link discard" onClick={props.onClose}>
          Discard <kbd>Esc</kbd>
        </button>
      </footer>
    </form>
  );

  return (
    <Show when={!props.init.inline} fallback={form}>
      <div class="overlay" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
        {form}
      </div>
    </Show>
  );
}
