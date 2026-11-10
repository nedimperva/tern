// Pieces every settings page uses (canvas "Tern settings and compose", 55): a page is an optional preview, then
// groups, each a heading and one card of rows; a row is a name, one line on it, and its control on the right. On or
// off is a switch, two or three short choices a segmented control, more (or long names) a dropdown.

import { For, Show, type JSX } from "solid-js";
import type { Account } from "../../api";
import { radioKeys } from "../../a11y";
import { setSetting, settings, type Settings } from "../../settings";
import { Dropdown } from "../Dropdown";

export type Choice<K extends keyof Settings> = { label: string; value: Settings[K] };

/** A row: the name and a line on it at the left, the control at the right. */
export function Row(props: { title: string; help?: JSX.Element; children?: JSX.Element; class?: string }) {
  return (
    <div class={`setting ${props.class ?? ""}`}>
      <span class="title">{props.title}</span>
      {props.children}
      <Show when={props.help}>
        <span class="help">{props.help}</span>
      </Show>
    </div>
  );
}

/** Four or more choices, or long ones: a dropdown. */
export function Select<K extends keyof Settings>(props: { name: K; title: string; help?: JSX.Element; choices: Choice<K>[] }) {
  return (
    <Row title={props.title} help={props.help}>
      <Dropdown
        label={props.title}
        value={String(settings[props.name])}
        choices={props.choices.map((c) => ({ value: String(c.value), label: c.label }))}
        onChange={(v) => {
          const picked = props.choices.find((c) => String(c.value) === v);
          if (picked) setSetting(props.name, picked.value);
        }}
      />
    </Row>
  );
}

/** Two or three short choices, all in view. */
export function Segmented<T>(props: { label: string; value: T; choices: { label: string; value: T }[]; onChange: (v: T) => void }) {
  return (
    <div class="segmented" role="radiogroup" aria-label={props.label} onKeyDown={radioKeys}>
      <For each={props.choices}>
        {(c) => (
          // biome-ignore lint/a11y/useSemanticElements: a styled radio; radioKeys gives it the arrow keys of a native one
          <button
            type="button"
            role="radio"
            aria-checked={c.value === props.value}
            tabIndex={c.value === props.value ? 0 : -1}
            classList={{ on: c.value === props.value }}
            onClick={() => props.onChange(c.value)}
          >
            {c.label}
          </button>
        )}
      </For>
    </div>
  );
}

export function Segments<K extends keyof Settings>(props: { name: K; title: string; help?: JSX.Element; choices: Choice<K>[] }) {
  return (
    <Row title={props.title} help={props.help}>
      <Segmented label={props.title} value={settings[props.name]} choices={props.choices} onChange={(v) => setSetting(props.name, v)} />
    </Row>
  );
}

/** On or off. */
export function Switch(props: { label: string; on: boolean; onChange: (on: boolean) => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      class="switch"
      aria-label={props.label}
      aria-checked={props.on}
      disabled={props.disabled}
      onClick={() => props.onChange(!props.on)}
    />
  );
}

type Flags = { [K in keyof Settings]: Settings[K] extends boolean ? K : never }[keyof Settings];

/** A setting that is on or off. `invert` for one whose stored value means the opposite of its name. */
export function Toggle(props: { name: Flags; title: string; help?: JSX.Element; invert?: boolean }) {
  const on = () => (settings[props.name] as boolean) !== !!props.invert;
  return (
    <Row title={props.title} help={props.help}>
      <Switch label={props.title} on={on()} onChange={(v) => setSetting(props.name, (v !== !!props.invert) as never)} />
    </Row>
  );
}

/** A heading and one card of rows. `note` sits quietly after the heading; `end` at its right. */
export function Group(props: { title: string; note?: string; end?: JSX.Element; children: JSX.Element; class?: string }) {
  return (
    <section class={`settings-group ${props.class ?? ""}`}>
      <div class="settings-group-head">
        <h2>{props.title}</h2>
        <Show when={props.note}>
          <small>{props.note}</small>
        </Show>
        <Show when={props.end}>
          <span class="end">{props.end}</span>
        </Show>
      </div>
      <div class="settings-card">{props.children}</div>
    </section>
  );
}

/** What a page changes, drawn with made-up mail; the same soft panel on every page that has one. */
export function Preview(props: { label?: string; children: JSX.Element; note?: string }) {
  return (
    <aside class="settings-preview" aria-label={props.label ?? "Preview"}>
      <span class="settings-preview-label">{props.label ?? "Preview"}</span>
      {props.children}
      <Show when={props.note}>
        <p class="settings-preview-note">{props.note}</p>
      </Show>
    </aside>
  );
}

/** A state in a few words: Connected, Not connected, Off. */
export function Chip(props: { tone?: "ok" | "warn"; children: JSX.Element }) {
  return <span class={`state-chip ${props.tone ?? ""}`}>{props.children}</span>;
}

/** An account's name in Tern: its label, else the name on its mail, else its address. */
export const accountName = (a: Account) => a.label || a.displayName || a.email;

/** A labelled part of an editor panel (snippets, signatures). */
export function Part(props: { title: string; children: JSX.Element }) {
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
