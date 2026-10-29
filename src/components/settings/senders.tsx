// Settings → Who writes most: the senders behind most of the last 30 days' mail, with a way to stop each one
// (List-Unsubscribe) or send them to Other. Counted on this computer; Unsubscribe opens the sender's own page or
// starts the mail it asks for, and nothing is sent without the person.

import { createSignal, For, onMount, Show } from "solid-js";
import { api, type SenderVolume } from "../../api";
import { fromLink } from "../../app/composing";
import { setSettingsOpen } from "../../app/state";
import { unsubscribeTarget } from "../../unsubscribe";

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

  return (
    <div class="senders">
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
  );
}
