// Pieces every settings page uses.

import { For, type JSX } from "solid-js";
import { type Account } from "../../api";
import { setSetting, settings, type Settings } from "../../settings";

export type Choice<K extends keyof Settings> = { label: string; value: Settings[K] };

export function Select<K extends keyof Settings>(props: { name: K; title: string; help: string; choices: Choice<K>[] }) {
  return (
    <label class="setting">
      <span class="title">{props.title}</span>
      <select
        value={String(settings[props.name])}
        onChange={(e) => {
          const picked = props.choices.find((c) => String(c.value) === e.currentTarget.value);
          if (picked) setSetting(props.name, picked.value);
        }}
      >
        <For each={props.choices}>{(c) => <option value={String(c.value)}>{c.label}</option>}</For>
      </select>
      <span class="help">{props.help}</span>
    </label>
  );
}

export const accountName = (a: Account) => a.displayName || a.email;

/** A labelled part of an editor panel. */
export function Group(props: { title: string; children: JSX.Element }) {
  return (
    <section class="group">
      <h2 class="group-title">{props.title}</h2>
      {props.children}
    </section>
  );
}

/** A message as the person written to sees it: its header lines, then its text. */
export function MailPreview(props: { head: [string, string][]; children: JSX.Element }) {
  return (
    <div class="mail-preview">
      <dl class="mail-head">
        <For each={props.head}>
          {([name, value]) => (
            <div>
              <dt>{name}</dt>
              <dd>{value}</dd>
            </div>
          )}
        </For>
      </dl>
      <div class="mail-body">{props.children}</div>
    </div>
  );
}

/** When something was last done, as a short day: "today", "yesterday", "on Friday", "on 3 Oct". */
export function lastDay(seconds: number): string {
  const then = new Date(seconds * 1000);
  const days = Math.round((new Date().setHours(0, 0, 0, 0) - new Date(then).setHours(0, 0, 0, 0)) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `on ${then.toLocaleDateString(undefined, { weekday: "long" })}`;
  return `on ${then.toLocaleDateString(undefined, { day: "numeric", month: "short" })}`;
}
