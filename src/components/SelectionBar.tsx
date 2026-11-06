import { For, Show } from "solid-js";
import { act, moveToSplit, screen, startLabel, targets, toggleRead } from "../app/actions";
import { role, setSelection, setSnoozing } from "../app/state";
import { settings } from "../settings";
import { participants } from "./ConversationRow";
import { Icon } from "./Icon";

/** Conversations selected (x, Shift+J/K, Ctrl+A): the title bar becomes what can be done with all of them at once
 * (canvas "Tern title bar ideas", 2), in place of the tabs, search and sync. Esc or the cross clears it. */
export function SelectionBar() {
  const hit = () => targets();
  const from = () => {
    const names = [...new Set(hit().map((r) => participants(r)))];
    return names.length > 3 ? `${names.slice(0, 3).join(", ")} and ${names.length - 3} more` : names.join(", ");
  };
  const unread = () => hit().some((r) => r.unread > 0);
  const screening = () => role() === "new_people";
  type Act = { name: string; key?: string; run: () => unknown; main?: boolean };
  const actions = (): Act[] =>
    screening()
      ? [
          { name: "Let them in", key: "Y", run: () => void screen(false), main: true },
          { name: "Other", key: "Shift O", run: () => void screen(true) },
        ]
      : [
          { name: "Done", key: "E", run: () => void act("archive"), main: true },
          { name: "Snooze", key: "H", run: () => setSnoozing(hit()) },
          { name: "Label", key: "L", run: startLabel },
          { name: unread() ? "Mark read" : "Mark unread", key: "U", run: () => void toggleRead() },
          ...(settings.splitInbox && ["important", "bulk"].includes(role())
            ? [{ name: role() === "bulk" ? "Move sender to Important" : "Move sender to Other", run: () => void moveToSplit(role() !== "bulk") }]
            : []),
          { name: "Trash", key: "#", run: () => void act("trash") },
        ];

  return (
    <div class="select-bar" role="toolbar" aria-label={`${hit().length} selected`}>
      <button type="button" class="icon-button" aria-label="Clear the selection" title="Clear the selection (Esc)" onClick={() => setSelection(new Set<string>())}>
        <Icon name="x" size={15} />
      </button>
      <strong>{hit().length} selected</strong>
      <span class="from">{from()}</span>
      <span class="vsep" />
      <For each={actions()}>
        {(a) => (
          <button type="button" class="select-act" classList={{ main: !!a.main }} onClick={a.run}>
            {a.name}
            <Show when={a.key}>
              <kbd>{a.key}</kbd>
            </Show>
          </button>
        )}
      </For>
    </div>
  );
}
