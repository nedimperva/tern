// Settings → Todoist (package 17 G): the person's own API token, kept in the keyring; the project and label new tasks
// get; and what goes to Todoist.

import { createSignal, onMount, Show } from "solid-js";
import { api, type TodoistProject } from "../../api";
import { setTodoistOn } from "../../app/tasks";
import { setSetting, settings } from "../../settings";
import { Dropdown } from "../Dropdown";
import { Icon } from "../Icon";
import { Chip, Group, Preview, Row } from "./shared";

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
  const projectName = () => projects().find((p) => p.id === settings.todoist.project)?.name ?? "Inbox";
  return (
    <>
      {/* The mail and the task it makes: what goes to Todoist, in place of a list of rules (idea 62). */}
      <Preview
        label="What a task looks like"
        note="Only this goes to Todoist, when you add a task (T). Never the mail's text or its files; Fill with AI asks your AI provider, not Todoist."
      >
        <div class="todoist-preview" aria-hidden="true">
          <div class="preview-sheet">
            <strong>Ada Lovelace</strong>
            <span class="block">Can you bring the Q3 deck?</span>
            <span class="small">Press T</span>
          </div>
          <Icon name="chevron-right" size={18} />
          <div class="preview-sheet task">
            <span class="ring" />
            <span>
              <span class="block">Bring the Q3 deck</span>
              <span class="small block">
                Mon 16 Nov · {projectName()}
                {settings.todoist.label ? ` · @${settings.todoist.label}` : ""}
              </span>
              <span class="small block">From Ada Lovelace: “Offsite”</span>
            </span>
          </div>
        </div>
      </Preview>
      <Group title="Account">
        <Show
          when={connected()}
          fallback={
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
              <span class="value-action">
                <Show when={connected() === false}>
                  <input
                    id="todoist-token"
                    type="password"
                    autocomplete="off"
                    value={token()}
                    onInput={(e) => setToken(e.currentTarget.value)}
                    placeholder="Paste your token"
                  />
                  <button type="submit" class="primary" disabled={busy() || !token().trim()}>
                    {busy() ? "Checking…" : "Connect"}
                  </button>
                </Show>
              </span>
              <span class="help">Todoist → Settings → Integrations → Developer. Kept in the system keyring, never in Tern's database.</span>
            </form>
          }
        >
          <Row title="Todoist" help={`Connected${projects().length ? ` · ${projects().length} projects` : ""}. Tasks already made stay in Todoist.`}>
            <span class="value-action">
              <Chip tone="ok">Connected</Chip>
              <button type="button" class="danger-text" onClick={() => void forget()}>
                Forget the token
              </button>
            </span>
          </Row>
        </Show>
      </Group>
      <Show when={connected()}>
        <Group title="New tasks">
          <Row title="Go to" help="The task box starts with it; each task can go elsewhere.">
            <Dropdown
              label="New tasks go to"
              value={settings.todoist.project}
              choices={[{ value: "", label: "Inbox" }, ...projects().filter((p) => !p.inbox).map((p) => ({ value: p.id, label: p.name }))]}
              onChange={(v) => set({ project: v })}
            />
          </Row>
          <label class="setting">
            <span class="title">Label on tasks from mail</span>
            <input id="todoist-label" value={settings.todoist.label} onChange={(e) => set({ label: e.currentTarget.value.trim().replace(/^@/, "") })} placeholder="none" />
            <span class="help">Empty for no label.</span>
          </label>
        </Group>
      </Show>
      <Show when={error()}>
        <p class="setting-error">{error()}</p>
      </Show>
    </>
  );
}
