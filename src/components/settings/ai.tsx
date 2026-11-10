// The token meter is a span (a native meter can't be styled alike in WebKitGTK and WebView2); the style note's length
// and tone are styled radios that radioKeys gives the arrow keys of native ones.
// biome-ignore-all lint/a11y/useSemanticElements: see above
// biome-ignore-all lint/a11y/useFocusableInteractive: the meter is read, not used
// Settings → AI: providers and keys, the features, and the writing style note.

import { createSignal, For, Show } from "solid-js";
import { api, type Account, type AiLearned, type AiProvider, type AiStats, type AiStyle } from "../../api";
import { colourOf } from "../../colours";
import { aiRoute, setSetting, settings, type AiFeatureKey, type AiRoute, type AiSettings } from "../../settings";
import { Icon } from "../Icon";
import { accountName, Chip, Group, lastDay, Preview, Row, Segmented, Switch } from "./shared";
import { Dropdown } from "../Dropdown";

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

/** Optional AI with the person's own keys (package 10), in the settings grammar (idea 60): the providers (any of them,
 * each with its key), the mail it may read, and what it may do, each feature with what it sends and the model it asks. Off until
 * turned on, which first shows the privacy sheet; a provider not agreed to yet is asked about before it gets mail. */
export function AiSettingsPage(props: { accounts: Account[]; /** Opens Settings → Writing style. */ onStyles: () => void }) {
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
  const pick = (feature: AiFeatureKey, value: string) => {
    const [provider, ...rest] = value.split(":");
    const route = { provider: provider as AiProvider, model: rest.join(":") };
    // The list keeps showing the model in use until the person allows the new provider.
    if (ai().enabled && !agreedTo(route.provider)) return setAsking({ feature, route });
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

  const redactNote = () => (ai().redact ? "Addresses and phone numbers are taken out first." : "Addresses and phone numbers go as they are.");
  const PROVIDER_COLOUR: Record<AiProvider, string> = { anthropic: "#c4621d", openai: "#1f1e1b", gemini: "#2b5fb8" };

  return (
    <Show when={known()}>
      {/* What one request sends, with the redaction as it is set: the privacy promise made visible (idea 60). */}
      <Preview label="What leaves your computer" note="Never files, never in the background, never mail from accounts you didn't tick.">
        <div class="preview-sheet ai-payload" aria-hidden="true">
          <span class="small">
            For a summary of “Offsite”, this goes to {company(aiRoute(ai(), "summaries").provider)}. {redactNote()}
          </span>
          <code>
            {'<mail from="Ada Lovelace" date="Fri 6 Nov">'}
            {"\n"}The offsite is at Studio 4 on Monday. Call me on{" "}
            <Show when={ai().redact} fallback="+44 20 7946 0958">
              <mark>[phone]</mark>
            </Show>{" "}
            or write to{" "}
            <Show when={ai().redact} fallback="ada@example.com">
              <mark>[email]</mark>
            </Show>
            .{"\n"}
            {"</mail>"}
          </code>
        </div>
      </Preview>
      <Group title="AI in Tern">
        <Row
          title="Use AI"
          help={
            ai().enabled
              ? `On · ${inUse().map(company).join(", ") || "no feature on"}. Turn it off here at any time: from then on nothing is sent.`
              : ready()
                ? `Turning it on shows exactly what goes to ${inUse().map(company).join(" and ")} first.`
                : "Add a key below first."
          }
        >
          <Switch label="Use AI" on={ai().enabled || sheet()} disabled={!ready() && !ai().enabled} onChange={(on) => (on ? setSheet(true) : (set({ enabled: false }), setSheet(false)))} />
        </Row>
        <Show when={sheet()}>
          <div class="ai-sheet" role="dialog" aria-label="What AI sends">
            <h2>Before you turn it on</h2>
            <ul>
              <li>
                <strong>Only when you ask</strong>, what the rows below say goes <strong>to {inUse().map(company).join(" and ")}</strong> (
                {inUse()
                  .map((p) => PROVIDERS.find((x) => x.id === p)!.host)
                  .join(", ")}
                ), under your keys. Their terms and data retention apply to it, so that mail no longer stays only on this computer and your
                mail provider.
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
        </Show>
      </Group>
      <Group title="Providers" note="one is enough">
        <For each={PROVIDERS}>
          {(p) => (
            <div class="ai-provider-row">
              <div class="list-row">
                <span class="badge-mark square" style={{ background: PROVIDER_COLOUR[p.id] }}>
                  {p.company[0]}
                </span>
                <span class="who">
                  <strong>{p.company}</strong>
                  <span class="sub">
                    {p.family} · {hasKey(p.id) ? "key in the system keyring" : "no key"}
                  </span>
                </span>
                <span class="end">
                  <Show
                    when={hasKey(p.id)}
                    fallback={
                      <Show when={adding() !== p.id}>
                        <button onClick={() => (setAdding(p.id), setKey(""), setTested(null))}>Add key</button>
                      </Show>
                    }
                  >
                    <Chip tone="ok">Connected</Chip>
                    <button disabled={testing()} onClick={() => void test(p.id)}>
                      {testing() && tested() == null ? "Testing…" : "Test"}
                    </button>
                    <button class="danger-text" onClick={() => void forgetKey(p.id)}>
                      Forget
                    </button>
                  </Show>
                </span>
              </div>
              <Show when={adding() === p.id}>
                <div class="ai-key-row">
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
                    <button onClick={() => setAdding(null)}>Cancel</button>
                    <button class="primary" disabled={!key().trim()} onClick={() => void saveKey(p.id)}>
                      Save
                    </button>
                  </span>
                  <span class="help">
                    Make one at {p.keys}. {p.company} bills you for what Tern asks; the key only ever goes to {p.company}.
                  </span>
                </div>
              </Show>
              <Show when={tested()?.p === p.id}>
                <span class={tested()!.ok ? "ai-test ok" : "ai-test bad"}>{tested()!.text}</span>
              </Show>
            </div>
          )}
        </For>
      </Group>
      {/* Without a key the rest can't do anything yet: it steps back (idea 52). */}
      <div class="ai-rest" classList={{ later: !ready() }}>
        <Group title="Mail it may read">
          <For each={props.accounts}>
            {(a) => (
              <div class="list-row">
                <span class="badge-mark" style={{ background: colourOf(props.accounts, a.id) }}>
                  {accountName(a)[0]?.toUpperCase()}
                </span>
                <span class="who">
                  <strong>{accountName(a)}</strong>
                  <Show when={accountName(a) !== a.email}>
                    <span class="sub">{a.email}</span>
                  </Show>
                </span>
                <Switch label={`AI may read ${accountName(a)}`} on={allowed(a.id)} disabled={!ready()} onChange={(on) => allow(a.id, on)} />
              </div>
            )}
          </For>
          <Row title="Take addresses and phone numbers out first" help="They become [email] and [phone]. Best effort, not anonymous.">
            <Switch label="Take addresses and phone numbers out first" on={ai().redact} disabled={!ready()} onChange={(on) => set({ redact: on })} />
          </Row>
        </Group>
        <Group title="What it may do" note="each only when you ask">
          <For each={FEATURES}>
            {(f) => (
              <>
                <Row
                  title={f.name}
                  help={
                    <>
                      {f.sends}. <span class="keys">{f.keys}</span>
                    </>
                  }
                >
                  <span class="value-action">
                    <Dropdown
                      label={`Model for ${f.name}`}
                      value={`${aiRoute(ai(), f.key).provider}:${aiRoute(ai(), f.key).model}`}
                      disabled={!ready()}
                      choices={[
                        // The model in use stays listed while the providers' lists load, or after it left them.
                        ...((models()[aiRoute(ai(), f.key).provider] ?? []).some(([id]) => id === aiRoute(ai(), f.key).model)
                          ? []
                          : [{ value: `${aiRoute(ai(), f.key).provider}:${aiRoute(ai(), f.key).model}`, label: modelName(aiRoute(ai(), f.key)) }]),
                        ...PROVIDERS.filter((p) => hasKey(p.id)).flatMap((p) =>
                          (models()[p.id] ?? []).map(([id, name]) => ({ value: `${p.id}:${id}`, label: name, group: p.company })),
                        ),
                      ]}
                      onChange={(v) => pick(f.key, v)}
                    />
                    <Switch label={f.name} on={ai()[f.toggle]} disabled={!ready()} onChange={(on) => set({ [f.toggle]: on })} />
                  </span>
                </Row>
                <Show when={asking()?.feature === f.key}>
                  <div class="ai-ask">
                    <span>
                      {modelName(asking()!.route)} sends {f.name.toLowerCase()} to <strong>{company(asking()!.route.provider)}</strong>, under your key at{" "}
                      {PROVIDERS.find((p) => p.id === asking()!.route.provider)!.host}. Their terms and data retention apply.
                      <Show when={asking()!.route.provider === "gemini"}> On Google's free tier, Google may use it to improve its products.</Show>
                    </span>
                    <span class="value-action">
                      <button onClick={() => setAsking(null)}>Cancel</button>
                      <button class="primary" onClick={allowAsked}>
                        Allow {company(asking()!.route.provider)}
                      </button>
                    </span>
                  </div>
                </Show>
              </>
            )}
          </For>
          <Show when={usesGemini()}>
            <p class="list-none">On Google's free tier, Google may use what you send to improve its products.</p>
          </Show>
        </Group>
      </div>
      <Show when={ai().enabled}>
        <Group title="Use">
          <Row title="Today" help="Sent and received, all providers. Resets at midnight UTC.">
            <span class="mini-meter ai-meter" role="meter" aria-valuenow={used()} aria-valuemin={0} aria-valuemax={ai().dailyTokens || used()} aria-label="Tokens used today">
              <Show when={ai().dailyTokens > 0}>
                <span class="track">
                  <span style={{ width: `${usedShare()}%` }} />
                </span>
              </Show>
              {used().toLocaleString()} of {ai().dailyTokens > 0 ? ai().dailyTokens.toLocaleString() : "no limit"}
            </span>
          </Row>
          <Row title="Daily limit" help="Small models cost a fraction of the big ones: summaries and replies need little.">
            <Dropdown
              label="Daily limit"
              value={String(ai().dailyTokens)}
              choices={[
                { value: "50000", label: "50,000 tokens" },
                { value: "200000", label: "200,000 tokens" },
                { value: "1000000", label: "1,000,000 tokens" },
                { value: "0", label: "No limit" },
              ]}
              onChange={(v) => set({ dailyTokens: Number(v) })}
            />
          </Row>
        </Group>
      </Show>
      <Group title="Kept on this computer">
        <Row title="Writing style" help="What Tern learned from each account's sent mail, for suggested replies and Write with AI.">
          <button type="button" class="link" onClick={props.onStyles}>
            Open
          </button>
        </Row>
        <Row title="AI cache" help={`Answers kept so they open at once: ${kept()}.`}>
          <button class="danger-text" onClick={() => void api.aiClearCache().then(() => restat(), (e) => setError(String(e)))}>
            Delete
          </button>
        </Row>
      </Group>
      <Show when={error()}>
        <p class="setting-error">{error()}</p>
      </Show>
    </Show>
  );
}

/** Settings → Writing style: a note per account on how its person writes, learned from their sent mail on request
 * and used by suggested replies and Write with AI. On its own page, as the notes take room. */
export function AiStylePage(props: { accounts: Account[]; /** Opens Settings → AI. */ onAi: () => void }) {
  const ai = () => settings.ai;
  const readable = () => props.accounts.filter((a) => ai().accounts.includes(a.id));
  const why = () =>
    !ai().enabled
      ? "Learning needs AI on, with Write in my style ticked."
      : !ai().voice
        ? "Turn it on in Settings → AI to learn how you write."
        : "Turn one on under Mail it may read in Settings → AI.";
  return (
    <Show
      when={ai().enabled && ai().voice && readable().length}
      fallback={
        // The same empty card as everywhere: an icon, a line, one button (idea 61).
        <div class="settings-card">
          <div class="settings-empty-row">
            <span class="mark">
              <Icon name="sparkles" size={18} />
            </span>
            <span>
              <strong>{!ai().enabled ? "AI is off" : !ai().voice ? "Write in my style is off" : "No account may be read yet"}</strong>
              <span>{why()}</span>
            </span>
            <button onClick={props.onAi}>Open AI settings</button>
          </div>
        </div>
      }
    >
      <For each={readable()}>{(a) => <StyleNote account={a} accounts={props.accounts} onChange={() => {}} />}</For>
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
  { key: "style", toggle: "voice", name: "Write in my style", keys: "per account", sends: "Learning: your latest 50 sent messages, your own words only, once each time" },
];

/** A note's greeting as it would open a reply to Ada: its "<name>" filled in, else her name after it. */
const greeting = (open: string) => (/<name>/i.test(open) ? open.replace(/<name>/gi, "Ada") : `${open.replace(/[,!]$/, "")} Ada,`);

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

  const learnButton = (
    <button type="button" class="link" disabled={learning()} onClick={() => void learn()}>
      {learning() ? "Learning…" : style() ? "Learn again" : "Learn from my sent mail"}
    </button>
  );
  const choice = (name: "length" | "tone", values: string[]) => (
    <Segmented
      label={name === "length" ? "Length" : "Tone"}
      value={parts()[name]}
      choices={values.map((v) => ({ label: v[0].toUpperCase() + v.slice(1), value: v }))}
      onChange={(v) => change({ [name]: v })}
    />
  );
  const chips = (key: "opens" | "closes") => (
    <span class="word-tags">
      <For each={parts()[key]} fallback={<span class="help">None yet</span>}>
        {(t) => (
          <span class="word-tag">
            {t}
            <button type="button" aria-label={`Remove ${t}`} onClick={() => change({ [key]: parts()[key].filter((x) => x !== t) })}>
              ×
            </button>
          </span>
        )}
      </For>
    </span>
  );

  // One account's style in the settings grammar: a heading with when it was learned and Learn at its right, then one
  // card of rows (the greeting and sign-off, length, tone, habits) and a foot to edit it as text or forget it.
  return (
    <Group
      title={accountName(props.account)}
      class="style-group"
      note={style() ? `${style()!.samples ? `from ${style()!.samples} sent messages, ` : ""}${lastDay(style()!.updated)}` : "not learned yet"}
      end={learnButton}
    >
      <Show
        when={style()}
        fallback={
          <div class="settings-empty-row">
            <span class="mark">
              <Icon name="feather" size={18} />
            </span>
            <span>
              <strong>Not learned yet</strong>
              <span>Tern reads your latest 50 sent messages once, your own words only, and writes a short note on how you write.</span>
            </span>
            <span />
          </div>
        }
      >
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
              <div class="style-text">
                <textarea
                  aria-label={`Writing style for ${accountName(props.account)}`}
                  value={style()!.note}
                  rows={Math.min(12, style()!.note.split("\n").length + 1)}
                  onBlur={(e) => save(e.currentTarget.value)}
                />
              </div>
            }
          >
            <Show when={parts().opens.length || parts().closes.length}>
              <div class="style-sample-row">
                <div class="preview-sheet style-sample">
                  <span class="small">A reply to Ada, as the note has it</span>
                  <span>{greeting(parts().opens[0] ?? "Hi")}</span>
                  <span class="dim">…</span>
                  <span>{parts().closes[0] ?? "Best"}</span>
                </div>
              </div>
            </Show>
            <Row title="Opens with">{chips("opens")}</Row>
            <Row title="Signs off with">{chips("closes")}</Row>
            <Row title="Length">{choice("length", ["short", "medium", "long"])}</Row>
            <Row title="Tone">{choice("tone", ["formal", "plain", "warm"])}</Row>
            <Show when={parts().habits.length}>
              <Row
                title="Habits"
                help={
                  <ul class="style-habits">
                    <For each={parts().habits}>{(h) => <li>{h}</li>}</For>
                  </ul>
                }
              />
            </Show>
          </Show>
          <div class="list-foot">
            <span>Used by suggested replies and Write with AI for this account.</span>
            <span class="style-foot-actions">
              <Show when={structured()}>
                <button type="button" class="link" onClick={() => setAsText(!asText())}>
                  {asText() ? "Show as parts" : "Edit as text"}
                </button>
              </Show>
              <button type="button" class="link danger" onClick={forget}>
                Forget
              </button>
            </span>
          </div>
        </Show>
      </Show>
      <Show when={error()}>
        <p class="setting-error">{error()}</p>
      </Show>
    </Group>
  );
}
