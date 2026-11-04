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
import { Select } from "./shared";

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
  const split = async (s: SenderVolume) => {
    await api.setSplit([s.newest], !s.other);
    mutate((l) => l?.map((x) => (key(x) === key(s) ? { ...x, other: !s.other } : x)));
    say(s, s.other ? "Back in Important, past mail and new." : "In Other from now on, past mail too.");
  };

  const domains = (text: string) =>
    setSetting(
      "knownDomains",
      [...new Set(text.split(/[\s,]+/).map((d) => d.trim().replace(/^@/, "").toLowerCase()).filter(Boolean))],
    );
  return (
    <>
      <Select
        name="screener"
        title="New people"
        help="First mail from someone you haven't written to waits in New people until you let them in (Y), send them to Other (Shift O) or block them (Shift X). Lists and newsletters go to Other as before. Mail already here stays where it is."
        choices={[
          { label: "Off", value: false },
          { label: "On", value: true },
        ]}
      />
      <Show when={settings.screener}>
        <label class="setting">
          <span class="title">People you know at</span>
          <input
            value={settings.knownDomains.join(", ")}
            placeholder="work.example, school.example"
            onChange={(e) => domains(e.currentTarget.value)}
            onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
          />
          <span class="help">Everyone at these domains counts as known, so their mail goes straight to Important.</span>
        </label>
      </Show>
      <div class="senders">
      <Choices />
      <Muted />
      <h2 class="group-title senders-title">Who writes most</h2>
      <p class="help">
        Who sent you the most in the last {DAYS} days, most first. Unsubscribe opens the sender's own page, or starts the mail
        it asks for, for you to send.
      </p>
      <Show when={list()} fallback={<p class="help">Counting…</p>}>
        <ol class="sender-list">
          <For each={list()} fallback={<li class="help">No mail in the last {DAYS} days.</li>}>
            {(s) => (
              <li>
                <span class="who">
                  <strong>{s.name || s.addr}</strong>
                  <span class="addr">{s.addr}</span>
                  <Show when={said()[key(s)]}>
                    <span class="said" role="status">
                      {said()[key(s)]}
                    </span>
                  </Show>
                </span>
                <span class="volume" title={`${s.count} messages`}>
                  <span class="bar" style={{ width: `${Math.max(4, (s.count / most()) * 100)}%` }} />
                  <span class="count">{s.count}</span>
                </span>
                <span class="actions">
                  <Show when={unsubscribeTarget(s.listUnsubscribe)}>
                    <button type="button" onClick={() => unsubscribe(s)}>
                      Unsubscribe
                    </button>
                  </Show>
                  <button type="button" onClick={() => void split(s)}>
                    {s.other ? "To Important" : "To Other"}
                  </button>
                </span>
              </li>
            )}
          </For>
        </ol>
      </Show>
      </div>
    </>
  );
}

const GROUPS: [SenderState, string, string][] = [
  ["blocked", "Blocked", "Their new mail is read and archived as it comes. It can still be found."],
  ["other", "To Other", "Their mail goes to Other."],
  ["important", "Kept in Important", "Their mail stays in Important, even when it looks like a list."],
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
      <section class="sender-choices">
        <h4>
          Muted <span class="count">{rows().length}</span>
        </h4>
        <p class="help">Replies in these conversations skip the inbox. They can still be found.</p>
        <ul class="sender-list">
          <For each={rows()}>
            {(r) => (
              <li>
                <span class="who">
                  <strong>{r.subject || "(no subject)"}</strong>
                  <span class="addr">{r.fromName || r.fromAddr}</span>
                </span>
                <span />
                <span class="actions">
                  <button type="button" onClick={() => void unmute(r)}>
                    Unmute
                  </button>
                </span>
              </li>
            )}
          </For>
        </ul>
      </section>
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
      <h2 class="group-title senders-title">Your choices</h2>
      <For each={GROUPS}>
        {([state, title, help]) => (
          <Show when={choices()!.some((c) => c.state === state)}>
            <section class="sender-choices">
              <h4>
                {title} <span class="count">{choices()!.filter((c) => c.state === state).length}</span>
              </h4>
              <p class="help">{help}</p>
              <ul class="sender-list">
                <For each={choices()!.filter((c) => c.state === state)}>
                  {(c) => (
                    <li>
                      <span class="who">
                        <strong>{label(c)}</strong>
                        <span class="addr">{c.addr.startsWith("@") ? "the whole domain" : c.addr}</span>
                      </span>
                      <span />
                      <span class="actions">
                        <button type="button" onClick={() => void back(c)}>
                          {BACK[state]}
                        </button>
                      </span>
                    </li>
                  )}
                </For>
              </ul>
            </section>
          </Show>
        )}
      </For>
    </Show>
  );
}
