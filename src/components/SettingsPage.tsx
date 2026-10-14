import { createSignal, For, onCleanup, onMount, type JSX } from "solid-js";
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
export function SettingsPage(props: { onClose: () => void }) {
  const [section, setSection] = createSignal(0);
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
        <For each={SECTIONS}>
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
        <h1>{SECTIONS[section()].name}</h1>
        {SECTIONS[section()].body()}
      </div>
    </div>
  );
}
