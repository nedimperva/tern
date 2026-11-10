// Settings → Senders: the choices made about senders (blocked, to Other, kept Important), each with a way back, then
// who writes most: the senders behind most of the last 30 days' mail, with a way to stop each one (List-Unsubscribe)
// or send them to Other. Counted on this computer; Unsubscribe opens the sender's own page or starts the mail it
// asks for, and nothing is sent without the person.

import { createSignal, For, onMount, Show } from "solid-js";
import { api, type MessageRow, type SenderChoice, type SenderState, type SenderVolume } from "../../api";
import { fromLink } from "../../app/composing";
import { setSettingsOpen } from "../../app/state";
import { setSetting, settings } from "../../settings";
import { unsubscribeTarget } from "../../unsubscribe";
import { Avatar } from "../ConversationView";
import { Icon } from "../Icon";
import { Group, Preview, Segmented, Toggle } from "./shared";

const DAYS = 30;

export function SendersSettings() {
  const since = Math.floor(Date.now() / 1000) - DAYS * 86_400;
  // A plain signal, not a resource: a resource read inside Settings' Suspense blanked the whole page until it came.
  const [list, setList] = createSignal<SenderVolume[] | null>(null);
  onMount(() => void api.senders(since).then(setList, () => setList([])));
  const mutate = (f: (l: SenderVolume[] | null) => SenderVolume[] | undefined) => setList(f(list()) ?? null);
  const [said, setSaid] = createSignal<Record<string, string>>({});
  const most = () => Math.max(1, ...(list() ?? []).map((s) => s.count));
  const key = (s: SenderVolume) => `${s.accountId}:${s.addr}`;
  const say = (s: SenderVolume, text: string) => setSaid({ ...said(), [key(s)]: text });
  // The list is short until asked (idea 57): a find box, filters and Show all.
  const [query, setQuery] = createSignal("");
  const [filter, setFilter] = createSignal<"all" | "important" | "other" | "lists">("all");
  const [all, setAll] = createSignal(false);
  const matching = () => {
    const q = query().trim().toLowerCase();
    return (list() ?? []).filter(
      (s) =>
        (!q || `${s.name} ${s.addr}`.toLowerCase().includes(q)) &&
        (filter() === "all" ||
          (filter() === "important" && !s.other) ||
          (filter() === "other" && s.other) ||
          (filter() === "lists" && !!unsubscribeTarget(s.listUnsubscribe))),
    );
  };
  const shown = () => (all() ? matching() : matching().slice(0, SHORT));
  const share = () => {
    const l = list() ?? [];
    const other = l.filter((s) => s.other).reduce((n, s) => n + s.count, 0);
    const important = l.filter((s) => !s.other).reduce((n, s) => n + s.count, 0);
    return { important, other, total: Math.max(1, important + other) };
  };

  const unsubscribe = (s: SenderVolume) => {
    const target = unsubscribeTarget(s.listUnsubscribe);
    if (!target) return;
    if ("web" in target) {
      api.openUrl(target.web);
      say(s, "Their unsubscribe page is open in your browser.");
    } else {
      setSettingsOpen(null);
      fromLink(target.mail);
    }
  };
  const split = async (s: SenderVolume, other: boolean) => {
    if (s.other === other) return;
    await api.setSplit([s.newest], other);
    mutate((l) => l?.map((x) => (key(x) === key(s) ? { ...x, other } : x)));
    say(s, other ? "In Other from now on, past mail too." : "Back in Important, past mail and new.");
  };

  const domains = (text: string) =>
    setSetting(
      "knownDomains",
      [...new Set(text.split(/[\s,]+/).map((d) => d.trim().replace(/^@/, "").toLowerCase()).filter(Boolean))],
    );
  return (
    <>
      <Show when={list()?.length}>
        <Preview label={`Your last ${DAYS} days`} note="From the senders below: where their mail went.">
          <div class="split-bar" aria-hidden="true">
            <span class="important" style={{ width: `${(share().important / share().total) * 100}%` }} />
            <span class="other" style={{ width: `${(share().other / share().total) * 100}%` }} />
          </div>
          <div class="split-legend">
            <span>
              <strong>{share().important}</strong> Important
            </span>
            <span>
              <strong>{share().other}</strong> Other
            </span>
          </div>
        </Preview>
      </Show>
      <Group title="New people">
        <Toggle
          name="screener"
          title="Screen first mail"
          help="Mail from someone new waits in New people until you let them in (Y), send them to Other (Shift O) or block them (Shift X). Lists go to Other as before."
        />
        <Show when={settings.screener}>
          <label class="setting sub">
            <span class="title">People you know at</span>
            <input
              value={settings.knownDomains.join(", ")}
              placeholder="work.example, school.example"
              onChange={(e) => domains(e.currentTarget.value)}
              onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
            />
            <span class="help">Everyone at these domains counts as known.</span>
          </label>
        </Show>
      </Group>
      <Group title="Who writes most" note={`most first, last ${DAYS} days`}>
        <div class="list-head">
          <input type="search" class="find" placeholder="Find a sender" aria-label="Find a sender" value={query()} onInput={(e) => setQuery(e.currentTarget.value)} />
          <span class="list-filters">
            <For each={FILTERS}>
              {([id, name]) => (
                <button type="button" aria-pressed={filter() === id} onClick={() => setFilter(id)}>
                  {name}
                </button>
              )}
            </For>
          </span>
        </div>
        <Show when={list()} fallback={<p class="list-none">Counting…</p>}>
          <For each={shown()} fallback={<p class="list-none">{list()!.length ? "No sender matches." : `No mail in the last ${DAYS} days.`}</p>}>
            {(s) => (
              <div class="list-row sender-row">
                <Avatar addr={s.addr} name={s.name} />
                <span class="who">
                  <strong>
                    {s.name || s.addr}
                    <Show when={unsubscribeTarget(s.listUnsubscribe)}>
                      <span class="tag">List</span>
                    </Show>
                  </strong>
                  <span class="sub">{s.addr}</span>
                  <Show when={said()[key(s)]}>
                    <span class="said" role="status">
                      {said()[key(s)]}
                    </span>
                  </Show>
                </span>
                <span class="mini-meter" title={`${s.count} messages`}>
                  <span class="track">
                    <span style={{ width: `${Math.max(4, (s.count / most()) * 100)}%` }} />
                  </span>
                  {s.count}
                </span>
                <Segmented
                  label={`Where ${s.name || s.addr}'s mail goes`}
                  value={s.other}
                  choices={[
                    { label: "Important", value: false },
                    { label: "Other", value: true },
                  ]}
                  onChange={(v) => void split(s, v)}
                />
                <Show when={unsubscribeTarget(s.listUnsubscribe)} fallback={<span />}>
                  <button type="button" class="icon-button" title="Unsubscribe" aria-label={`Unsubscribe from ${s.name || s.addr}`} onClick={() => unsubscribe(s)}>
                    <Icon name="mail-x" size={15} />
                  </button>
                </Show>
              </div>
            )}
          </For>
          <Show when={matching().length > SHORT}>
            <div class="list-foot">
              <span>
                {shown().length} of {matching().length} senders
              </span>
              <button type="button" class="link" onClick={() => setAll(!all())}>
                {all() ? "Show fewer" : "Show all"}
              </button>
            </div>
          </Show>
        </Show>
      </Group>
      <Choices />
      <Muted />
    </>
  );
}

const SHORT = 8;
const FILTERS: ["all" | "important" | "other" | "lists", string][] = [
  ["all", "All"],
  ["important", "Important"],
  ["other", "Other"],
  ["lists", "Lists"],
];

const GROUPS: [SenderState, string, string][] = [
  ["blocked", "Blocked", "new mail is archived as it comes"],
  ["other", "Sent to Other", "their mail goes to Other"],
  ["important", "Kept in Important", "even when it looks like a list"],
];
const BACK: Record<SenderState, string> = { blocked: "Unblock", other: "To Important", important: "Forget" };

/** Muted conversations (`m`): replies to them skip the inbox. Unmute lets the next reply in again. */
function Muted() {
  const [rows, setRows] = createSignal<MessageRow[]>([]);
  const read = () => void api.mutedConversations().then(setRows, () => setRows([]));
  onMount(read);
  const unmute = async (r: MessageRow) => {
    await api.mute([r.id], false);
    read();
  };
  return (
    <Show when={rows().length}>
      <Group title="Muted conversations" note="replies skip the inbox; they can still be found">
        <For each={rows()}>
          {(r) => (
            <div class="list-row">
              <span class="badge-mark quiet">
                <Icon name="bell" size={15} />
              </span>
              <span class="who">
                <strong>{r.subject || "(no subject)"}</strong>
                <span class="sub">{r.fromName || r.fromAddr}</span>
              </span>
              <button type="button" onClick={() => void unmute(r)}>
                Unmute
              </button>
            </div>
          )}
        </For>
      </Group>
    </Show>
  );
}

/** What the person chose about senders, a list per choice, each with a way back. */
function Choices() {
  const [choices, setChoices] = createSignal<SenderChoice[] | null>(null);
  const read = () => void api.senderChoices().then(setChoices, () => setChoices([]));
  onMount(read);
  const back = async (c: SenderChoice) => {
    // Out of Other is a choice for Important; unblocking and forgetting leave it to the headers again.
    await api.setSender(c.accountId, c.addr, c.state === "other" ? "important" : null);
    read();
  };
  const label = (c: SenderChoice) => (c.addr.startsWith("@") ? `Everyone at ${c.addr.slice(1)}` : c.name || c.addr);
  return (
    <Show when={choices()?.length}>
      <For each={GROUPS}>
        {([state, title, help]) => (
          <Show when={choices()!.some((c) => c.state === state)}>
            <Group title={title} note={help}>
              <For each={choices()!.filter((c) => c.state === state)}>
                {(c) => (
                  <div class="list-row">
                    <Avatar addr={c.addr} name={c.name || c.addr.replace(/^@/, "")} />
                    <span class="who">
                      <strong>{label(c)}</strong>
                      <span class="sub">{c.addr.startsWith("@") ? "the whole domain" : c.addr}</span>
                    </span>
                    <button type="button" onClick={() => void back(c)}>
                      {BACK[state]}
                    </button>
                  </div>
                )}
              </For>
            </Group>
          </Show>
        )}
      </For>
    </Show>
  );
}
