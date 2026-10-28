// The ledger in step 3 is an ARIA table laid out with CSS grid, so its rows and cells are divs and spans with roles;
// the token meter is a div (a native meter can't be styled alike in WebKitGTK and WebView2); the style note's length
// and tone are styled radios that radioKeys gives the arrow keys of native ones.
// biome-ignore-all lint/a11y/useSemanticElements: see above
// biome-ignore-all lint/a11y/useFocusableInteractive: table rows, not grid rows; nothing in them needs focus but the controls
// Settings → AI: providers and keys, the features, and the writing style note.

import { createSignal, For, Show, type JSX } from "solid-js";
import { api, type Account, type AiLearned, type AiProvider, type AiStats, type AiStyle } from "../../api";
import { colourOf } from "../../colours";
import { radioKeys } from "../../a11y";
import { aiRoute, setSetting, settings, type AiFeatureKey, type AiRoute, type AiSettings } from "../../settings";
import { Icon } from "../Icon";
import { accountName, lastDay } from "./shared";

const PROVIDERS: { id: AiProvider; company: string; family: string; host: string; keys: string; placeholder: string }[] = [
  { id: "anthropic", company: "Anthropic", family: "Claude", host: "api.anthropic.com", keys: "console.anthropic.com", placeholder: "sk-ant-…" },
  { id: "openai", company: "OpenAI", family: "GPT", host: "api.openai.com", keys: "platform.openai.com", placeholder: "sk-…" },
  { id: "gemini", company: "Google", family: "Gemini", host: "generativelanguage.googleapis.com", keys: "aistudio.google.com", placeholder: "AIza…" },
];
/** The model picked when switching to a provider, until its list says otherwise. */
const FIRST_MODEL: Record<AiProvider, string> = {
  anthropic: "claude-opus-5-5",
  openai: "gpt-6-sol",
  gemini: "gemini-flash-latest",
};

/** A numbered step: a check once done, the number in the accent while it is the one to do, grey after that. */
function Step(props: { n: number; done: boolean; current: boolean; title: string; children: JSX.Element }) {
  return (
    <section class="ai-step" classList={{ done: props.done, current: props.current && !props.done }}>
      <span class="ai-step-mark" aria-hidden="true">
        <Show when={props.done} fallback={props.n}>
          <Icon name="check" size={13} />
        </Show>
      </span>
      <div class="ai-step-body">
        <h2>
          {props.title}
          <Show when={props.done}>
            <span class="visually-hidden"> (done)</span>
          </Show>
        </h2>
        {props.children}
      </div>
    </section>
  );
}

/** Optional AI with the person's own keys (package 10), as three steps: the providers (any of them, each with its
 * key), the mail it may read, and what it may do, each feature with what it sends and the model it asks. Off until
 * turned on, which first shows the privacy sheet; a provider not agreed to yet is asked about before it gets mail. */
export function AiSettingsPage(props: { accounts: Account[] }) {
  const ai = () => settings.ai;
  // Keys, model lists and use are plain signals filled in as they come, not resources: a resource read here would
  // hold the whole settings page behind its Suspense until the keychain and the providers' model lists (a network
  // call for OpenAI and Google) had answered, which took seconds.
  const [keys, setKeys] = createSignal<Partial<Record<AiProvider, boolean>>>({});
  const hasKey = (p: AiProvider) => !!keys()[p];
  // What each provider with a key can use; OpenAI's and Google's lineups change often, so they are read with it.
  const [models, setModels] = createSignal<Partial<Record<AiProvider, [string, string][]>>>({});
  // The page waits for the keychain (quick) so it doesn't first draw "Add key" everywhere; model lists come after.
  const [known, setKnown] = createSignal(false);
  const recheckKeys = async () => {
    const found = await Promise.all(PROVIDERS.map((p) => api.aiHasKey(p.id).catch(() => false)));
    setKeys(Object.fromEntries(PROVIDERS.map((p, i) => [p.id, found[i]])));
    setKnown(true);
    await Promise.all(
      PROVIDERS.map(async (p, i) => {
        const list = found[i] ? await api.aiModels(p.id, null).catch(() => [] as [string, string][]) : [];
        setModels((m) => ({ ...m, [p.id]: list }));
      }),
    );
  };
  void recheckKeys();
  const [stats, setStats] = createSignal<AiStats | null>(null);
  const restat = () => void api.aiStats().then(setStats, () => setStats(null));
  restat();
  // The provider whose key is being typed, the key, and what Test said.
  const [adding, setAdding] = createSignal<AiProvider | null>(null);
  const [key, setKey] = createSignal("");
  const [tested, setTested] = createSignal<{ p: AiProvider; ok: boolean; text: string } | null>(null);
  const [testing, setTesting] = createSignal(false);
  // Turning AI on shows what it sends first; on only after "Turn on".
  const [sheet, setSheet] = createSignal(false);
  // A model picked from a provider not agreed to yet, waiting for the person to allow that provider.
  const [asking, setAsking] = createSignal<{ feature: AiFeatureKey; route: AiRoute } | null>(null);
  const [error, setError] = createSignal("");
  const set = (patch: Partial<AiSettings>) => setSetting("ai", { ...settings.ai, ...patch });
  const allowed = (id: number) => ai().accounts.includes(id);
  const allow = (id: number, on: boolean) =>
    set({ accounts: on ? [...ai().accounts.filter((a) => a !== id), id] : ai().accounts.filter((a) => a !== id) });
  const company = (p: AiProvider) => PROVIDERS.find((x) => x.id === p)!.company;
  const agreedTo = (p: AiProvider) => ai().agreed.includes(p) || (!ai().agreed.length && p === ai().provider);
  const modelName = (r: AiRoute) => models()[r.provider]?.find(([id]) => id === r.model)?.[1] ?? r.model;
  /** The providers the features that are on would send to. */
  const inUse = () => {
    const out: AiProvider[] = [];
    for (const f of FEATURES) if (ai()[f.toggle] && !out.includes(aiRoute(ai(), f.key).provider)) out.push(aiRoute(ai(), f.key).provider);
    return out;
  };

  const test = async (p: AiProvider) => {
    setTesting(true);
    setTested(null);
    try {
      const model = aiRoute(ai(), "writing").provider === p ? aiRoute(ai(), "writing").model : FIRST_MODEL[p];
      const name = await api.aiTest(p, adding() === p ? key().trim() || null : null, model);
      setTested({ p, ok: true, text: `Works with ${name}.` });
    } catch (e) {
      setTested({ p, ok: false, text: String(e) });
    } finally {
      setTesting(false);
    }
  };
  const saveKey = async (p: AiProvider) => {
    setError("");
    try {
      await api.aiSetKey(p, key().trim());
      setKey("");
      setAdding(null);
      // The first key makes its provider the default.
      if (!hasKey(ai().provider)) set({ provider: p, model: FIRST_MODEL[p], uses: {} });
      await recheckKeys();
    } catch (e) {
      setError(String(e));
    }
  };
  const forgetKey = async (p: AiProvider) => {
    setError("");
    try {
      await api.aiForgetKey(p);
      setTested(null);
      // Features on this provider go back to the default; without the default's key, AI is off.
      const uses = Object.fromEntries(Object.entries(ai().uses).filter(([, r]) => r.provider !== p));
      set({ uses, agreed: ai().agreed.filter((x) => x !== p), ...(p === ai().provider ? { enabled: false } : {}) });
      await recheckKeys();
    } catch (e) {
      setError(String(e));
    }
  };
  /** A model picked for a feature: at once if its provider may already get mail (or AI is still off), else after
   * the person allows it. */
  const pick = (feature: AiFeatureKey, el: HTMLSelectElement) => {
    const [provider, ...rest] = el.value.split(":");
    const route = { provider: provider as AiProvider, model: rest.join(":") };
    if (ai().enabled && !agreedTo(route.provider)) {
      // The list keeps showing the model in use until the person allows the new provider.
      const now = aiRoute(ai(), feature);
      el.value = `${now.provider}:${now.model}`;
      return setAsking({ feature, route });
    }
    set({ uses: { ...ai().uses, [feature]: route } });
  };
  const allowAsked = () => {
    const a = asking();
    if (!a) return;
    const agreed = ai().agreed.length ? ai().agreed : [ai().provider];
    set({ uses: { ...ai().uses, [a.feature]: a.route }, agreed: [...agreed.filter((x) => x !== a.route.provider), a.route.provider] });
    setAsking(null);
  };
  const turnOn = () => {
    set({
      enabled: true,
      accounts: ai().accounts.length ? ai().accounts : props.accounts.map((a) => a.id),
      agreed: [...new Set([...ai().agreed, ...inUse()])],
    });
    setSheet(false);
  };
  const ready = () => PROVIDERS.some((p) => hasKey(p.id));
  const anyFeature = () => ai().summaries || ai().replies || ai().writing;
  const kept = () => {
    const k = stats()?.kept ?? {};
    const parts = [
      k.summary ? `${k.summary} ${k.summary === 1 ? "summary" : "summaries"}` : "",
      k.replies ? `${k.replies} sets of replies` : "",
      k.style ? `${k.style} style ${k.style === 1 ? "note" : "notes"}` : "",
    ].filter(Boolean);
    return parts.length ? parts.join(", ") : "nothing yet";
  };
  const used = () => stats()?.tokensToday ?? 0;
  const usedShare = () => (ai().dailyTokens > 0 ? Math.min(100, (used() / ai().dailyTokens) * 100) : 0);
  const usesGemini = () => inUse().includes("gemini");

  return (
    <Show when={known()}>
      <div class="ai-status">
        <Show
          when={ai().enabled}
          fallback={<p class="help">Off unless you turn it on, and only when you ask: Tern never sends mail to AI in the background.</p>}
        >
          <span class="on">
            <span class="dot" /> On · {inUse().map(company).join(", ")}
          </span>
          <button onClick={() => set({ enabled: false })}>Turn off</button>
        </Show>
      </div>
      <Step n={1} done={ready()} current title="Providers">
        <div class="ai-provider-list">
          <For each={PROVIDERS}>
            {(p) => (
              <div class="ai-provider" classList={{ set: hasKey(p.id) }}>
                <div class="who">
                  <strong>{p.company}</strong>
                  <span>{p.family}</span>
                </div>
                <Show
                  when={adding() === p.id}
                  fallback={
                    <Show
                      when={hasKey(p.id)}
                      fallback={
                        <button onClick={() => (setAdding(p.id), setKey(""), setTested(null))}>
                          Add key
                        </button>
                      }
                    >
                      <span class="saved-key">
                        <Icon name="check" size={12} /> Key saved
                      </span>
                      <button disabled={testing()} onClick={() => void test(p.id)}>
                        {testing() && tested() == null ? "Testing…" : "Test"}
                      </button>
                      <button onClick={() => void forgetKey(p.id)}>Forget</button>
                    </Show>
                  }
                >
                  <span class="ai-key">
                    <input
                      type="password"
                      placeholder={p.placeholder}
                      aria-label={`${p.company} API key`}
                      value={key()}
                      onInput={(e) => (setKey(e.currentTarget.value), setTested(null))}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && key().trim()) void saveKey(p.id);
                        else if (e.key === "Escape") (e.stopPropagation(), setAdding(null));
                      }}
                      ref={(el) => queueMicrotask(() => el.focus())}
                    />
                    <button disabled={!key().trim() || testing()} onClick={() => void test(p.id)}>
                      Test
                    </button>
                    <button class="primary" disabled={!key().trim()} onClick={() => void saveKey(p.id)}>
                      Save
                    </button>
                  </span>
                </Show>
                <Show when={tested()?.p === p.id}>
                  <span class={tested()!.ok ? "ai-test ok" : "ai-test bad"}>{tested()!.text}</span>
                </Show>
                <Show when={adding() === p.id}>
                  <span class="help">
                    Make one at {p.keys}. {p.company} bills you for what Tern asks; the key only ever goes to {p.company}.
                  </span>
                </Show>
              </div>
            )}
          </For>
        </div>
        <span class="help">Set up one or several. Each feature below picks its model from the ones with a key.</span>
      </Step>
      <Step n={2} done={ready() && ai().accounts.length > 0} current={ready()} title="Mail it may read">
        <div class="ai-accounts">
          <For each={props.accounts}>
            {(a) => (
              <label>
                <input type="checkbox" checked={allowed(a.id)} onChange={(e) => allow(a.id, e.currentTarget.checked)} />
                <span class="dot" style={{ background: colourOf(props.accounts, a.id) }} />
                {accountName(a)}
              </label>
            )}
          </For>
        </div>
        <label class="ai-redact">
          <input type="checkbox" checked={ai().redact} onChange={(e) => set({ redact: e.currentTarget.checked })} />
          Take addresses and phone numbers out first (they become [email] and [phone]; best effort, not anonymous)
        </label>
      </Step>
      <Step n={3} done={ready() && ai().accounts.length > 0 && anyFeature()} current={ready() && ai().accounts.length > 0} title="What it may do">
        <div class="ai-ledger" role="table" aria-label="What each feature sends and to which model">
          <div class="row head" role="row">
            <span role="columnheader">Feature</span>
            <span role="columnheader">What goes to its model's provider, when you ask</span>
            <span role="columnheader">Model</span>
            <span role="columnheader">On</span>
          </div>
          <For each={FEATURES}>
            {(f) => (
              <>
                <div class="row" role="row">
                  <span role="cell" class="name">
                    {f.name}
                    <span class="keys">{f.keys}</span>
                  </span>
                  <span role="cell" class="sends">
                    {f.sends}
                  </span>
                  <span role="cell">
                    <select
                      aria-label={`Model for ${f.name}`}
                      value={`${aiRoute(ai(), f.key).provider}:${aiRoute(ai(), f.key).model}`}
                      disabled={!ready()}
                      onChange={(e) => pick(f.key, e.currentTarget)}
                    >
                      <Show when={!(models()[aiRoute(ai(), f.key).provider] ?? []).some(([id]) => id === aiRoute(ai(), f.key).model)}>
                        <option value={`${aiRoute(ai(), f.key).provider}:${aiRoute(ai(), f.key).model}`} selected>
                          {modelName(aiRoute(ai(), f.key))}
                        </option>
                      </Show>
                      <For each={PROVIDERS.filter((p) => hasKey(p.id))}>
                        {(p) => (
                          <optgroup label={p.company}>
                            <For each={models()[p.id] ?? []}>
                              {([id, name]) => {
                                const r = () => aiRoute(ai(), f.key);
                                // Marked here, not only by the select's value: the list arrives after the select.
                                return (
                                  <option value={`${p.id}:${id}`} selected={r().provider === p.id && r().model === id}>
                                    {name}
                                  </option>
                                );
                              }}
                            </For>
                          </optgroup>
                        )}
                      </For>
                    </select>
                  </span>
                  <span role="cell">
                    <input type="checkbox" checked={ai()[f.toggle]} onChange={(e) => set({ [f.toggle]: e.currentTarget.checked })} aria-label={f.name} />
                  </span>
                </div>
                <Show when={asking()?.feature === f.key}>
                  <div class="row ask" role="row">
                    <span role="cell" class="ask-text">
                      {modelName(asking()!.route)} sends {f.name.toLowerCase()} to <strong>{company(asking()!.route.provider)}</strong>, under your key at{" "}
                      {PROVIDERS.find((p) => p.id === asking()!.route.provider)!.host}. Their terms and data retention apply.
                      <Show when={asking()!.route.provider === "gemini"}> On Google's free tier, Google may use it to improve its products.</Show>
                    </span>
                    <span role="cell" class="ask-actions">
                      <button class="primary" onClick={allowAsked}>
                        Allow {company(asking()!.route.provider)}
                      </button>
                      <button onClick={() => setAsking(null)}>Cancel</button>
                    </span>
                  </div>
                </Show>
              </>
            )}
          </For>
          <p class="foot">
            Never attachments, never in the background, never mail from accounts you didn't tick.
            <Show when={usesGemini()}> On Google's free tier, Google may use what you send to improve its products.</Show>
          </p>
        </div>
      </Step>
      <Show
        when={!sheet()}
        fallback={
          <div class="ai-sheet" role="dialog" aria-label="What AI sends">
            <h2>Before you turn it on</h2>
            <ul>
              <li>
                <strong>Only when you ask</strong>, what the table above says goes{" "}
                <strong>to {inUse().map(company).join(" and ")}</strong> (
                {inUse()
                  .map((p) => PROVIDERS.find((x) => x.id === p)!.host)
                  .join(", ")}
                ), under your keys. Their terms and data retention apply to it, so that mail no longer stays only on this
                computer and your mail provider.
              </li>
              <Show when={usesGemini()}>
                <li>
                  <strong>Google's free tier</strong> may use what you send to improve Google's products. A key from a project with billing
                  turned on is covered by Google's paid terms instead.
                </li>
              </Show>
              <li>A model from another provider is asked about before that provider gets any mail.</li>
              <li>Answers and style notes are kept on this computer; delete them here at any time.</li>
              <li>Turn AI off here at any time: from then on nothing is sent.</li>
            </ul>
            <div class="ai-sheet-actions">
              <button class="primary" onClick={turnOn}>
                Turn on AI
              </button>
              <button onClick={() => setSheet(false)}>Cancel</button>
            </div>
          </div>
        }
      >
        <Show when={!ai().enabled}>
          <div class="ai-turn-on">
            <span>{ready() ? `Turning it on shows exactly what goes to ${inUse().map(company).join(" and ")} first.` : "Add a key first."}</span>
            <button class="primary" disabled={!ready()} onClick={() => setSheet(true)}>
              Review and turn on
            </button>
          </div>
        </Show>
      </Show>
      <Show when={ai().enabled}>
        <div class="ai-usage">
          <div class="ai-card">
            <span class="kicker">Today</span>
            <span>
              {used().toLocaleString()} of {ai().dailyTokens > 0 ? `${ai().dailyTokens.toLocaleString()} tokens` : "no limit"}
            </span>
            <Show when={ai().dailyTokens > 0}>
              <div class="meter" role="meter" aria-valuenow={used()} aria-valuemin={0} aria-valuemax={ai().dailyTokens} aria-label="Tokens used today">
                <div style={{ width: `${usedShare()}%` }} />
              </div>
            </Show>
            <span class="help">Sent and received, all providers. Resets at midnight UTC.</span>
          </div>
          <div class="ai-card">
            <span class="kicker">Limit</span>
            <label class="ai-inline">
              Daily limit
              <select value={String(ai().dailyTokens)} onChange={(e) => set({ dailyTokens: Number(e.currentTarget.value) })}>
                <option value="50000">50,000 tokens</option>
                <option value="200000">200,000 tokens</option>
                <option value="1000000">1,000,000 tokens</option>
                <option value="0">No limit</option>
              </select>
            </label>
            <span class="help">Small models cost a fraction of the big ones: summaries and replies need little.</span>
          </div>
        </div>
        <Show when={ai().voice}>
          <div class="ai-styles">
            <h2>Your writing style</h2>
            <span class="help">Learned from an account's latest sent mail when you click Learn, kept here, yours to change.</span>
            <For each={props.accounts.filter((a) => allowed(a.id))}>
              {(a) => <StyleNote account={a} accounts={props.accounts} onChange={() => void restat()} />}
            </For>
          </div>
        </Show>
      </Show>
      <div class="ai-kept">
        <span>Kept on this computer: {kept()}.</span>
        <span class="spacer" />
        <button onClick={() => void api.aiClearCache().then(() => restat(), (e) => setError(String(e)))}>Delete AI cache</button>
      </div>
      <Show when={error()}>
        <p class="setting-error">{error()}</p>
      </Show>
    </Show>
  );
}

/** The features of step 3: the name in `AiSettings.uses`, the switch that turns each on, and what it sends. */
const FEATURES: { key: AiFeatureKey; toggle: "summaries" | "replies" | "writing" | "voice"; name: string; keys: string; sends: string }[] = [
  { key: "summaries", toggle: "summaries", name: "Summaries", keys: "Shift S", sends: "Each message's sender, date and text, without quoted replies" },
  { key: "replies", toggle: "replies", name: "Suggested replies", keys: "Q", sends: "The same as a summary, plus your style note if you use one" },
  {
    key: "writing",
    toggle: "writing",
    name: "Write with AI",
    keys: "Space in an empty draft",
    sends: "What you tell it, your draft if any, and in a reply the conversation; in new mail, names are matched here",
  },
  { key: "style", toggle: "voice", name: "Write in my style", keys: "per account, below", sends: "Learning: your latest 50 sent messages, your own words only, once each time" },
];

/** A style note read as its parts: greetings, sign-offs, length, tone, habits. Lines it doesn't know stay as they are. */
type NoteParts = { opens: string[]; closes: string[]; length: string; tone: string; habits: string[]; other: string[] };

function noteParts(note: string): NoteParts {
  const parts: NoteParts = { opens: [], closes: [], length: "", tone: "", habits: [], other: [] };
  const list = (rest: string) => rest.split("|").map((t) => t.trim()).filter(Boolean);
  for (const raw of note.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const field = /^(Opens with|Signs off with|Length|Tone):\s*(.*)$/i.exec(line);
    if (field) {
      const [, name, rest] = field;
      const n = name.toLowerCase();
      if (n === "opens with") parts.opens = list(rest);
      else if (n === "signs off with") parts.closes = list(rest);
      else if (n === "length") parts.length = rest.trim().toLowerCase();
      else parts.tone = rest.trim().toLowerCase();
    } else if (/^[-•*] /.test(line)) parts.habits.push(line.slice(2).trim());
    else parts.other.push(line);
  }
  return parts;
}

function noteText(p: NoteParts): string {
  return [
    p.opens.length ? `Opens with: ${p.opens.join(" | ")}` : "",
    p.closes.length ? `Signs off with: ${p.closes.join(" | ")}` : "",
    p.length ? `Length: ${p.length}` : "",
    p.tone ? `Tone: ${p.tone}` : "",
    ...p.habits.map((h) => `- ${h}`),
    ...p.other,
  ]
    .filter(Boolean)
    .join("\n");
}

/** One account's writing style. Learn sends its sent mail once; the first answer comes with a sample written plainly
 * and in that style ("Does this sound like you?"); after that the note shows as parts to tune, or as text. */
function StyleNote(props: { account: Account; accounts: Account[]; onChange: () => void }) {
  // A signal, not a resource, so loading the note never holds the settings page behind its Suspense.
  const [style, mutate] = createSignal<AiStyle | null>(null);
  void api.aiStyle(props.account.id).then(mutate, () => {});
  const [preview, setPreview] = createSignal<AiLearned["preview"]>(null);
  const [learning, setLearning] = createSignal(false);
  const [asText, setAsText] = createSignal(false);
  const [error, setError] = createSignal("");
  const parts = () => noteParts(style()?.note ?? "");
  // A note in no known shape (written by hand, or from before) is edited as text.
  const structured = () => {
    const p = parts();
    return p.opens.length + p.closes.length + p.habits.length > 0 || !!p.length || !!p.tone;
  };
  const learn = async () => {
    setLearning(true);
    setError("");
    try {
      const got = await api.aiLearnStyle(props.account.id);
      mutate(got.style);
      setPreview(got.preview);
      props.onChange();
    } catch (e) {
      setError(String(e));
    } finally {
      setLearning(false);
    }
  };
  const save = (note: string) => {
    const current = style();
    if ((current?.note ?? "") === note.trim()) return;
    void api.aiSetStyle(props.account.id, note).then(
      () => {
        mutate(note.trim() ? { accountId: props.account.id, samples: current?.samples ?? 0, note: note.trim(), updated: Math.floor(Date.now() / 1000) } : null);
        props.onChange();
      },
      (e) => setError(String(e)),
    );
  };
  const change = (patch: Partial<NoteParts>) => save(noteText({ ...parts(), ...patch }));
  const forget = () => (setPreview(null), save(""));

  return (
    <div class="style-note">
      <div class="style-head">
        <span class="dot" style={{ background: colourOf(props.accounts, props.account.id) }} />
        <strong>{accountName(props.account)}</strong>
        <span class="meta">
          {style() ? `${style()!.samples ? `From ${style()!.samples} sent messages, ` : ""}${lastDay(style()!.updated)}` : "Not learned yet"}
        </span>
        <button disabled={learning()} onClick={() => void learn()}>
          {learning() ? "Learning…" : style() ? "Learn again" : "Learn from my sent mail"}
        </button>
      </div>
      <Show when={style()}>
        <Show
          when={!preview()}
          fallback={
            <div class="style-preview">
              <h3>Does this sound like you?</h3>
              <p class="help">The same notes, written without and with what Tern learned from your sent mail.</p>
              <div class="style-notes">
                <strong>Notes:</strong> {preview()!.notes}
              </div>
              <div class="style-compare">
                <div class="plain">
                  <span class="kicker">Plain AI</span>
                  <p>{preview()!.plain}</p>
                </div>
                <div class="yours">
                  <span class="kicker">In your style</span>
                  <p>{preview()!.yours}</p>
                </div>
              </div>
              <Show when={preview()!.pickedUp.length}>
                <div class="style-traits">
                  <span>What it picked up:</span>
                  <For each={preview()!.pickedUp}>{(t) => <span class="trait">{t}</span>}</For>
                </div>
              </Show>
              <div class="style-actions">
                <button class="primary" onClick={() => setPreview(null)}>
                  Sounds like me
                </button>
                <button onClick={() => (setPreview(null), setAsText(false))}>Adjust the note</button>
                <span class="spacer" />
                <button class="link" onClick={forget}>
                  Don't use a style
                </button>
              </div>
            </div>
          }
        >
          <Show
            when={structured() && !asText()}
            fallback={
              <textarea
                aria-label={`Writing style for ${accountName(props.account)}`}
                value={style()!.note}
                rows={Math.min(12, style()!.note.split("\n").length + 1)}
                onBlur={(e) => save(e.currentTarget.value)}
              />
            }
          >
            <div class="style-profile">
              <div class="style-part">
                <span class="kicker">Opens with</span>
                <div class="chips">
                  <For each={parts().opens}>
                    {(t) => (
                      <span class="chip">
                        {t}
                        <button aria-label={`Remove ${t}`} onClick={() => change({ opens: parts().opens.filter((x) => x !== t) })}>
                          ×
                        </button>
                      </span>
                    )}
                  </For>
                </div>
              </div>
              <div class="style-part">
                <span class="kicker">Signs off with</span>
                <div class="chips">
                  <For each={parts().closes}>
                    {(t) => (
                      <span class="chip">
                        {t}
                        <button aria-label={`Remove ${t}`} onClick={() => change({ closes: parts().closes.filter((x) => x !== t) })}>
                          ×
                        </button>
                      </span>
                    )}
                  </For>
                </div>
              </div>
              <div class="style-part">
                <span class="kicker">Length</span>
                <div class="segmented" role="radiogroup" aria-label="Length" onKeyDown={radioKeys}>
                  <For each={["short", "medium", "long"]}>
                    {(v) => (
                      <button role="radio" aria-checked={parts().length === v} tabIndex={parts().length === v ? 0 : -1} classList={{ on: parts().length === v }} onClick={() => change({ length: v })}>
                        {v[0].toUpperCase() + v.slice(1)}
                      </button>
                    )}
                  </For>
                </div>
              </div>
              <div class="style-part">
                <span class="kicker">Tone</span>
                <div class="segmented" role="radiogroup" aria-label="Tone" onKeyDown={radioKeys}>
                  <For each={["formal", "plain", "warm"]}>
                    {(v) => (
                      <button role="radio" aria-checked={parts().tone === v} tabIndex={parts().tone === v ? 0 : -1} classList={{ on: parts().tone === v }} onClick={() => change({ tone: v })}>
                        {v[0].toUpperCase() + v.slice(1)}
                      </button>
                    )}
                  </For>
                </div>
              </div>
              <Show when={parts().habits.length}>
                <div class="style-part wide">
                  <span class="kicker">Habits</span>
                  <ul>
                    <For each={parts().habits}>{(h) => <li>{h}</li>}</For>
                  </ul>
                </div>
              </Show>
            </div>
          </Show>
          <div class="style-foot">
            <span class="spacer" />
            <Show when={structured()}>
              <button class="link" onClick={() => setAsText(!asText())}>
                {asText() ? "Show as parts" : "Edit as text"}
              </button>
            </Show>
            <button class="link danger" onClick={forget}>
              Forget
            </button>
          </div>
        </Show>
      </Show>
      <Show when={error()}>
        <p class="setting-error">{error()}</p>
      </Show>
    </div>
  );
}
