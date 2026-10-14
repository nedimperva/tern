import { createSignal, For, onCleanup, onMount, type JSX } from "solid-js";
import type { Account } from "../api";
import { setSetting, settings, type Settings } from "../settings";

type Choice<K extends keyof Settings> = { label: string; value: Settings[K] };

function Select<K extends keyof Settings>(props: { name: K; title: string; help: string; choices: Choice<K>[] }) {
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

const SECTIONS: { name: string; body: () => JSX.Element }[] = [
  {
    name: "Appearance",
    body: () => (
      <>
        <Select
          name="theme"
          title="Theme"
          help="System follows your desktop's light or dark setting."
          choices={[
            { label: "System", value: "system" },
            { label: "Light", value: "light" },
            { label: "Dark", value: "dark" },
          ]}
        />
        <Select
          name="density"
          title="Density"
          help="How tall each conversation row is."
          choices={[
            { label: "Dense", value: "dense" },
            { label: "Comfortable", value: "comfortable" },
            { label: "Spacious", value: "spacious" },
          ]}
        />
      </>
    ),
  },
  {
    name: "Reading",
    body: () => (
      <>
        <Select
          name="openMode"
          title="Open conversations"
          help="Beside the list keeps it in view; over the list gives the message the whole window."
          choices={[
            { label: "Beside the list when there is room", value: "auto" },
            { label: "Always beside the list", value: "split" },
            { label: "Always over the list", value: "full" },
          ]}
        />
        <Select
          name="readAfterMs"
          title="Mark as read"
          help="When an open conversation counts as read. U marks it either way by hand."
          choices={[
            { label: "Immediately", value: 0 },
            { label: "After 1 second", value: 1000 },
            { label: "Only when I mark it", value: -1 },
          ]}
        />
        <Select
          name="sendDelay"
          title="Undo send"
          help="How long a sent message waits before it leaves, so Z can take it back."
          choices={[
            { label: "Off", value: 0 },
            { label: "5 seconds", value: 5 },
            { label: "10 seconds", value: 10 },
            { label: "20 seconds", value: 20 },
          ]}
        />
        <Select
          name="loadImages"
          title="Remote images"
          help="Images from the web can tell the sender when you read their mail."
          choices={[
            { label: "Ask each time", value: "ask" },
            { label: "Always load", value: "always" },
          ]}
        />
      </>
    ),
  },
];

/** Ctrl+, : settings over the list (docs/design/ui.md §4.8). Changes apply and are saved at once. */
/** Accounts: each one's signature, and where it goes in replies. */
function AccountSettings(props: { accounts: Account[] }) {
  return (
    <>
      <For each={props.accounts}>
        {(a) => (
          <label class="setting signature">
            <span class="title">Signature for {a.email}</span>
            <textarea
              rows={4}
              value={settings.signatures[String(a.id)] ?? ""}
              placeholder="Name, role, phone…"
              onInput={(e) => setSetting("signatures", { ...settings.signatures, [String(a.id)]: e.currentTarget.value })}
            />
            <span class="help">Added under new messages and replies from this account, after a "-- " line.</span>
          </label>
        )}
      </For>
      <Select
        name="signatureBelow"
        title="Signature in replies"
        help="Above the quoted message is where people read it; below is the older custom."
        choices={[
          { label: "Above the quoted message", value: false },
          { label: "Below the quoted message", value: true },
        ]}
      />
    </>
  );
}

export function SettingsPage(props: { accounts: Account[]; onClose: () => void }) {
  const [section, setSection] = createSignal(0);
  const sections = () => [...SECTIONS, { name: "Accounts", body: () => <AccountSettings accounts={props.accounts} /> }];
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    props.onClose();
  };
  onMount(() => window.addEventListener("keydown", onKey, true));
  onCleanup(() => window.removeEventListener("keydown", onKey, true));

  return (
    <div class="settings-page" role="dialog" aria-label="Settings">
      <nav>
        <h2>Settings</h2>
        <For each={sections()}>
          {(s, i) => (
            <a classList={{ active: i() === section() }} onClick={() => setSection(i())}>
              {s.name}
            </a>
          )}
        </For>
        <button class="link" onClick={props.onClose}>
          Close <kbd>Esc</kbd>
        </button>
      </nav>
      <div class="settings-body">
        <h1>{sections()[section()].name}</h1>
        {sections()[section()].body()}
      </div>
    </div>
  );
}
