// Settings → Todoist (package 17 G): the person's own API token, kept in the keyring; the project and label new tasks
// get; and what goes to Todoist.

import { createSignal, For, onMount, Show } from "solid-js";
import { api, type TodoistProject } from "../../api";
import { setTodoistOn } from "../../app/tasks";
import { setSetting, settings } from "../../settings";
import { Dropdown } from "../Dropdown";

export function TodoistSettings() {
  const [connected, setConnected] = createSignal<boolean | null>(null);
  const [projects, setProjects] = createSignal<TodoistProject[]>([]);
  const [token, setToken] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const set = (patch: Partial<typeof settings.todoist>) => setSetting("todoist", { ...settings.todoist, ...patch });
  onMount(async () => {
    const on = await api.todoistConnected().catch(() => false);
    setConnected(on);
    if (on) void api.todoistProjects().then(setProjects, (e) => setError(String(e)));
  });
  const connect = async () => {
    setBusy(true);
    setError("");
    try {
      setProjects(await api.todoistConnect(token()));
      setToken("");
      setConnected(true);
      setTodoistOn(true);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  const forget = async () => {
    await api.todoistForget();
    setConnected(false);
    setTodoistOn(false);
    setProjects([]);
  };
  return (
    <>
      <Show
        when={connected()}
        fallback={
          <Show when={connected() === false}>
            <form
              class="setting"
              onSubmit={(e) => {
                e.preventDefault();
                void connect();
              }}
            >
              <label class="title" for="todoist-token">
                API token
              </label>
              <div class="todoist-connect">
                <input
                  id="todoist-token"
                  type="password"
                  autocomplete="off"
                  value={token()}
                  onInput={(e) => setToken(e.currentTarget.value)}
                  placeholder="Paste your Todoist API token"
                />
                <button type="submit" class="primary" disabled={busy() || !token().trim()}>
                  {busy() ? "Checking…" : "Connect"}
                </button>
              </div>
              <span class="help">
                In Todoist: Settings → Integrations → Developer → API token. Tern checks it by listing your projects, then
                keeps it in the system keyring, never in its database.
              </span>
            </form>
          </Show>
        }
      >
        <div class="setting">
          <span class="title">Todoist</span>
          <div class="todoist-connect">
            <span>Connected{projects().length ? ` · ${projects().length} projects` : ""}</span>
            <button type="button" onClick={() => void forget()}>
              Forget the token
            </button>
          </div>
          <span class="help">Tasks already made stay in Todoist.</span>
        </div>
        <div class="setting">
          <span class="title">New tasks go to</span>
          <Dropdown
            label="New tasks go to"
            value={settings.todoist.project}
            choices={[{ value: "", label: "Inbox" }, ...projects().filter((p) => !p.inbox).map((p) => ({ value: p.id, label: p.name }))]}
            onChange={(v) => set({ project: v })}
          />
          <span class="help">The task box starts with it; each task can go elsewhere.</span>
        </div>
        <div class="setting">
          <label class="title" for="todoist-label">
            Label on tasks from mail
          </label>
          <input id="todoist-label" value={settings.todoist.label} onChange={(e) => set({ label: e.currentTarget.value.trim().replace(/^@/, "") })} placeholder="none" />
          <span class="help">Empty for no label.</span>
        </div>
      </Show>
      <div class="setting">
        <span class="title">What goes to Todoist</span>
        <ul class="todoist-what">
          <For
            each={[
              "Only when you add a task: T, or Add task beside something asked or due.",
              "The title, the day and the note as they are in the box, the project and the label.",
              "One line naming the mail: who sent it and its subject.",
              "Never the mail's text or its files. Fill with AI sends the conversation to your AI provider, not to Todoist.",
            ]}
          >
            {(line) => <li>{line}</li>}
          </For>
        </ul>
      </div>
      <Show when={error()}>
        <p class="setting-error">{error()}</p>
      </Show>
    </>
  );
}
