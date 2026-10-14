import { createSignal, For, onMount, Show } from "solid-js";
import type { Account, Draft } from "../api";

export type ComposeInit = {
  accountId?: number;
  to?: string;
  cc?: string;
  subject?: string;
  body?: string;
  inReplyTo?: string | null;
  /** Put the cursor here when opening (a forward starts in To; a reply in the body). */
  focus?: "to" | "body";
};

export function Compose(props: {
  accounts: Account[];
  init: ComposeInit;
  onSend: (accountId: number, draft: Draft) => void;
  onClose: () => void;
}) {
  const [from, setFrom] = createSignal(props.init.accountId ?? props.accounts[0]?.id);
  const [to, setTo] = createSignal(props.init.to ?? "");
  const [cc, setCc] = createSignal(props.init.cc ?? "");
  const [subject, setSubject] = createSignal(props.init.subject ?? "");
  const [body, setBody] = createSignal(props.init.body ?? "");
  let first!: HTMLInputElement;
  let text!: HTMLTextAreaElement;
  onMount(() => ((props.init.focus ?? (props.init.to ? "body" : "to")) === "body" ? text : first).focus());
  const list = (s: string) => s.split(/[,;]/).map((a) => a.trim()).filter(Boolean);

  const send = () => {
    const recipients = list(to());
    if (!recipients.length || from() == null) return;
    props.onSend(from()!, {
      to: recipients,
      cc: list(cc()),
      subject: subject(),
      body: body(),
      inReplyTo: props.init.inReplyTo ?? null,
    });
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") props.onClose();
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) send();
  };

  return (
    <div class="overlay" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <form class="compose" onKeyDown={onKeyDown} onSubmit={(e) => (e.preventDefault(), send())}>
        <select value={from()} onChange={(e) => setFrom(Number(e.currentTarget.value))}>
          <For each={props.accounts}>{(a) => <option value={a.id}>{a.displayName ? `${a.displayName} <${a.email}>` : a.email}</option>}</For>
        </select>
        <input ref={first} placeholder="To" value={to()} onInput={(e) => setTo(e.currentTarget.value)} />
        <Show when={props.init.cc !== undefined || cc()}>
          <input placeholder="Cc" value={cc()} onInput={(e) => setCc(e.currentTarget.value)} />
        </Show>
        <input placeholder="Subject" value={subject()} onInput={(e) => setSubject(e.currentTarget.value)} />
        <textarea ref={text} value={body()} onInput={(e) => setBody(e.currentTarget.value)} />
        <footer>
          <button type="submit" class="primary">
            Send <kbd>Ctrl ↵</kbd>
          </button>
          <button type="button" onClick={props.onClose}>
            Discard <kbd>Esc</kbd>
          </button>
        </footer>
      </form>
    </div>
  );
}
