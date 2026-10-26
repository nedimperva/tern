import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  Index,
  lazy,
  on,
  onCleanup,
  onMount,
  Show,
  Suspense,
  untrack,
  type JSX,
} from "solid-js";
import { api, type Account, type AiLearned, type AiProvider, type Signature, type Snippet } from "../api";
import { colourOf } from "../colours";
import { aiRoute, setSetting, settings, type AiFeatureKey, type AiRoute, type AiSettings, type Settings } from "../settings";
import { fillSnippet, PLACES } from "../snippets";
import { Icon } from "./Icon";
import { NIGHT_SHIFT, SCENES } from "../zero";
import { HtmlFrame } from "./HtmlFrame";
import { htmlText, localPictures, pastedHtml } from "../htmlSignature";
// The signature editor is compose's, a chunk of its own.
const Editor = lazy(() => import("./Editor").then((m) => ({ default: m.Editor })));

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

const accountName = (a: Account) => a.displayName || a.email;

/** A labelled part of an editor panel. */
function Group(props: { title: string; children: JSX.Element }) {
  return (
    <section class="group">
      <h2 class="group-title">{props.title}</h2>
      {props.children}
    </section>
  );
}

/** A message as the person written to sees it: its header lines, then its text. */
function MailPreview(props: { head: [string, string][]; children: JSX.Element }) {
  return (
    <div class="mail-preview">
      <dl class="mail-head">
        <For each={props.head}>
          {([name, value]) => (
            <div>
              <dt>{name}</dt>
              <dd>{value}</dd>
            </div>
          )}
        </For>
      </dl>
      <div class="mail-body">{props.children}</div>
    </div>
  );
}

/** When something was last done, as a short day: "today", "yesterday", "on Friday", "on 3 Oct". */
function lastDay(seconds: number): string {
  const then = new Date(seconds * 1000);
  const days = Math.round((new Date().setHours(0, 0, 0, 0) - new Date(then).setHours(0, 0, 0, 0)) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `on ${then.toLocaleDateString(undefined, { weekday: "long" })}`;
  return `on ${then.toLocaleDateString(undefined, { day: "numeric", month: "short" })}`;
}

function AppearanceSettings() {
  return (
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
      <Select
        name="zeroScene"
        title="Inbox Zero"
        help="What an empty inbox shows. Flock, Streak and Your migration count what you clear in Tern on this computer."
        choices={[
          { label: "A different tern each day", value: "rotate" },
          ...[...SCENES, NIGHT_SHIFT].map((s) => ({ label: s.name, value: s.id as string })),
        ]}
      />
    </>
  );
}

function ReadingSettings() {
  return (
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
        name="splitInbox"
        title="Inbox"
        help="Other holds mail sent to many: newsletters, notifications, receipts. Move a sender with Ctrl+K → Move sender."
        choices={[
          { label: "Important and Other", value: true },
          { label: "One list", value: false },
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
      <Select
        name="darkMail"
        title="Designed mail in dark mode"
        help="Newsletters and receipts come with their own colours. Darkened, their backgrounds go dark and their text light; pictures stay as they are."
        choices={[
          { label: "Darken it", value: "darken" },
          { label: "Keep its own colours", value: "original" },
        ]}
      />
      <Select
        name="senderLogos"
        title="Sender logos"
        help="Shows a company's logo instead of initials, taken from its own website once a month. The site can tell when you open its mail. Personal addresses (Gmail, Outlook…) keep their initials."
        choices={[
          { label: "Initials only", value: false },
          { label: "Show logos", value: true },
        ]}
      />
    </>
  );
}

function ComposeSettings() {
  return (
    <>
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
      name="attachmentCheck"
      title="Forgotten attachments"
      help="Before sending, Tern checks whether you wrote that something is attached (“attached”, “u prilogu”, “im Anhang”…) when nothing is."
      choices={[
        { label: "Check", value: true },
        { label: "Don't check", value: false },
      ]}
    />
    <label class="setting">
      <span class="title">Your own attachment words</span>
      <input
        value={settings.attachmentWords.join(", ")}
        placeholder="evo fajla, šaljem ti"
        onChange={(e) =>
          setSetting(
            "attachmentWords",
            e.currentTarget.value.split(",").map((w) => w.trim()).filter(Boolean),
          )
        }
      />
      <span class="help">
        Words or phrases that mean a file goes with the message, separated by commas. Tern already knows the usual ones in
        English, Bosnian, Croatian, Serbian, German, French, Spanish, Italian, Portuguese, Dutch, Polish and Turkish.
      </span>
    </label>
    </>
  );
}

const ISSUES = "https://github.com/nedimperva/tern/issues/new?template=bug_report.yml";
const BETA_GUIDE = "https://github.com/nedimperva/tern/blob/main/docs/beta.md";

/** The version, and what a bug report needs: details without addresses, the log, the issue form. */
function AboutSettings() {
  const [about] = createResource(() => api.about());
  const [copied, setCopied] = createSignal<"yes" | "no" | null>(null);
  let details: HTMLPreElement | undefined;
  const copy = async () => {
    const done = await navigator.clipboard.writeText(about()?.details ?? "").then(
      () => true,
      () => false,
    );
    // Refused (the window lost focus, say): the text is selected instead, for Ctrl+C.
    if (!done && details) window.getSelection()?.selectAllChildren(details);
    setCopied(done ? "yes" : "no");
    setTimeout(() => setCopied(null), 3000);
  };
  return (
    <Show when={about()}>
      {(a) => (
        <>
          <div class="setting">
            <span class="title">Tern {a().version}</span>
            <button class="link" onClick={() => api.openUrl(BETA_GUIDE)}>
              Beta guide
            </button>
            <span class="help">What works, what doesn't yet, and how to go back to an earlier version.</span>
          </div>
          <div class="setting">
            <span class="title">Report a problem</span>
            <button onClick={() => api.openUrl(`${ISSUES}&version=${encodeURIComponent(a().version)}`)}>Open the form</button>
            <span class="help">On GitHub. Paste the details below, and the end of the log if something failed.</span>
          </div>
          <div class="setting">
            <span class="title">Details for a bug report</span>
            <button onClick={() => void copy()}>
              {copied() === "yes" ? "Copied" : copied() === "no" ? "Selected: press Ctrl+C" : "Copy"}
            </button>
            <pre class="about-details" ref={details}>
              {a().details}
            </pre>
            <span class="help">Your version, system and each account's provider. No addresses or server names of your own.</span>
          </div>
          <div class="setting">
            <span class="title">Log</span>
            <button onClick={() => void api.openLogs()}>Open folder</button>
            <span class="help about-path">{a().logFile}</span>
          </div>
        </>
      )}
    </Show>
  );
}

function NotificationSettings() {
  return (
    <>
      <Select
        name="notify"
        title="New mail"
        help="A notification when mail from someone else reaches the inbox. Muted conversations stay quiet."
        choices={[
          { label: "Notify me", value: true },
          { label: "Don't notify me", value: false },
        ]}
      />
      <Select
        name="notifyOther"
        title="Notify for"
        help="Other holds newsletters and automatic mail; it never interrupts unless you ask."
        choices={[
          { label: "Important mail", value: false },
          { label: "Important and Other", value: true },
        ]}
      />
      <div class="setting">
        <span class="title">Quiet hours</span>
        <span class="quiet-hours">
          <input
            type="time"
            value={settings.quietFrom}
            aria-label="Quiet from"
            onChange={(e) => setSetting("quietFrom", e.currentTarget.value)}
          />
          <span>to</span>
          <input
            type="time"
            value={settings.quietTo}
            aria-label="Quiet until"
            onChange={(e) => setSetting("quietTo", e.currentTarget.value)}
          />
          <Show when={settings.quietFrom || settings.quietTo}>
            <button class="link" onClick={() => (setSetting("quietFrom", ""), setSetting("quietTo", ""))}>
              Clear
            </button>
          </Show>
        </span>
        <span class="help">No notifications between these times. Mail that arrives then waits in the inbox, without a notice later.</span>
      </div>
    </>
  );
}

/** Running in the background, login start and mailto: links. The last two live with the system, so they are asked
 * for and set there rather than kept in Tern's settings. */
function DesktopSettings() {
  const [login, setLogin] = createSignal(false);
  const [isDefault, setIsDefault] = createSignal(false);
  const [error, setError] = createSignal("");
  onMount(() => {
    void api.autostart().then(setLogin, () => {});
    void api.defaultMailApp().then(setIsDefault, () => {});
  });
  const attempt = async (f: () => Promise<void>) => {
    setError("");
    try {
      await f();
    } catch (e) {
      setError(String(e));
    }
  };
  return (
    <>
      <Select
        name="background"
        title="When the window closes"
        help="In the background, Tern keeps syncing and notifying from the tray. Ctrl+Q or the tray's Quit ends it."
        choices={[
          { label: "Keep running in the background", value: true },
          { label: "Quit Tern", value: false },
        ]}
      />
      <label class="setting">
        <span class="title">Start at login</span>
        <select
          value={String(login())}
          onChange={(e) => {
            const on = e.currentTarget.value === "true";
            void attempt(async () => {
              await api.setAutostart(on);
              setLogin(on);
            });
          }}
        >
          <option value="true">Start Tern in the tray</option>
          <option value="false">Don't start Tern</option>
        </select>
        <span class="help">Tern starts without a window and fetches mail in the background.</span>
      </label>
      <div class="setting">
        <span class="title">Email links</span>
        <Show
          when={!isDefault()}
          fallback={<span class="help">Email links (mailto:) open in Tern.</span>}
        >
          <button
            onClick={() =>
              void attempt(async () => {
                await api.makeDefaultMailApp();
                setIsDefault(await api.defaultMailApp());
              })
            }
          >
            Open email links in Tern
          </button>
          <span class="help">Clicking an email address on a web page or in another app starts a message here.</span>
        </Show>
      </div>
      <Show when={error()}>
        <p class="setting-error">{error()}</p>
      </Show>
    </>
  );
}

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
function AiSettingsPage(props: { accounts: Account[] }) {
  const ai = () => settings.ai;
  const [keys, { refetch: recheckKeys }] = createResource(async () => {
    const out = {} as Record<AiProvider, boolean>;
    for (const p of PROVIDERS) out[p.id] = await api.aiHasKey(p.id).catch(() => false);
    return out;
  });
  const hasKey = (p: AiProvider) => !!keys()?.[p];
  // What each provider with a key can use; OpenAI's and Google's lineups change often, so they are read with it.
  const [models] = createResource(keys, async (k) => {
    const out = {} as Record<AiProvider, [string, string][]>;
    for (const p of PROVIDERS) out[p.id] = k[p.id] ? await api.aiModels(p.id, null).catch(() => []) : [];
    return out;
  });
  const [stats, { refetch: restat }] = createResource(() => api.aiStats().catch(() => null));
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
  const modelName = (r: AiRoute) => models()?.[r.provider]?.find(([id]) => id === r.model)?.[1] ?? r.model;
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
    <>
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
                      <Show when={!(models()?.[aiRoute(ai(), f.key).provider] ?? []).some(([id]) => id === aiRoute(ai(), f.key).model)}>
                        <option value={`${aiRoute(ai(), f.key).provider}:${aiRoute(ai(), f.key).model}`} selected>
                          {modelName(aiRoute(ai(), f.key))}
                        </option>
                      </Show>
                      <For each={PROVIDERS.filter((p) => hasKey(p.id))}>
                        {(p) => (
                          <optgroup label={p.company}>
                            <For each={models()?.[p.id] ?? []}>
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
    </>
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
  const [style, { mutate }] = createResource(() => props.account.id, (id) => api.aiStyle(id));
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
                <div class="segmented" role="radiogroup" aria-label="Length">
                  <For each={["short", "medium", "long"]}>
                    {(v) => (
                      <button role="radio" aria-checked={parts().length === v} classList={{ on: parts().length === v }} onClick={() => change({ length: v })}>
                        {v[0].toUpperCase() + v.slice(1)}
                      </button>
                    )}
                  </For>
                </div>
              </div>
              <div class="style-part">
                <span class="kicker">Tone</span>
                <div class="segmented" role="radiogroup" aria-label="Tone">
                  <For each={["formal", "plain", "warm"]}>
                    {(v) => (
                      <button role="radio" aria-checked={parts().tone === v} classList={{ on: parts().tone === v }} onClick={() => change({ tone: v })}>
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

/** Snippets: text typed after `;` in compose. A list on the left, the one picked on the right; changes save as they
 * are typed. */
function SnippetSettings(props: { accounts: Account[] }) {
  // Rows carry a key of their own: a new snippet has no id until its first save.
  type Row = Snippet & { key: number };
  let keys = 0;
  const [list, setList] = createSignal<Row[]>([]);
  const [picked, setPicked] = createSignal<number | null>(null);
  const [query, setQuery] = createSignal("");
  // "all", "used" (most used first) or an account id.
  const [filter, setFilter] = createSignal<"all" | "used" | number>("all");
  const [error, setError] = createSignal("");
  // A refused save shows on its own row and stays until that row saves: the row is not kept until then.
  const [refused, setRefusedAll] = createSignal<Record<number, string>>({});
  const setRefused = (key: number, why: string) => setRefusedAll({ ...refused(), [key]: why });
  // What else the picked snippet fills in, as chosen; a subject or Cc it has shows its field anyway.
  const [extras, setExtras] = createSignal<0 | 1 | 2>(0);
  onMount(
    () =>
      void api.snippets().then(
        (all) => {
          setList(all.map((s) => ({ ...s, key: ++keys })));
          setPicked(list()[0]?.key ?? null);
        },
        (e) => setError(String(e)),
      ),
  );
  const current = () => list().find((s) => s.key === picked());
  // Only when another snippet is picked: while one is edited, its fields follow the choice, not the other way.
  createEffect(
    on(picked, (key) => {
      const s = untrack(list).find((r) => r.key === key);
      setExtras(s?.cc.length ? 2 : s?.subject != null ? 1 : 0);
    }),
  );
  const shown = createMemo(() => {
    const q = query().trim().toLowerCase();
    const f = filter();
    const rows = list().filter(
      (s) =>
        (!q || `${s.shortcut} ${s.name} ${s.body}`.toLowerCase().includes(q)) &&
        (typeof f !== "number" || s.accountId == null || s.accountId === f),
    );
    return f === "used" ? [...rows].sort((a, b) => b.used - a.used) : rows;
  });
  const change = (key: number, patch: Partial<Snippet>) => setList(list().map((s) => (s.key === key ? { ...s, ...patch } : s)));
  // One save at a time, so a new snippet is not added twice.
  let saving = Promise.resolve();
  const save = (key: number) =>
    (saving = saving.then(async () => {
      const s = list().find((r) => r.key === key);
      // A new one waits for its shortcut.
      if (!s || (s.id === 0 && !s.shortcut.trim())) return;
      try {
        change(key, { id: await api.saveSnippet(s) });
        setRefused(key, "");
      } catch (e) {
        setRefused(key, String(e));
      }
    }));
  // Typing saves after a pause, and closing settings saves what is left (a removed field gets no blur).
  const waiting = new Map<number, number>();
  const later = (key: number) => {
    clearTimeout(waiting.get(key));
    waiting.set(key, window.setTimeout(() => (waiting.delete(key), void save(key)), 600));
  };
  onCleanup(() => {
    for (const [key, timer] of waiting) (clearTimeout(timer), void save(key));
  });
  const edit = (patch: Partial<Snippet>) => {
    const key = picked();
    if (key == null) return;
    change(key, patch);
    later(key);
  };
  const remove = (key: number) => {
    clearTimeout(waiting.get(key));
    waiting.delete(key);
    saving = saving.then(async () => {
      const s = list().find((r) => r.key === key);
      if (s?.id) await api.deleteSnippet(s.id);
      const left = list().filter((r) => r.key !== key);
      setList(left);
      if (picked() === key) setPicked(left[0]?.key ?? null);
    });
  };
  const blank: Snippet = { id: 0, shortcut: "", name: "", body: "", accountId: null, subject: null, cc: [], used: 0, lastUsed: null };
  const add = (from: Partial<Snippet> = {}) => {
    const row = { ...blank, ...from, id: 0, used: 0, lastUsed: null, key: ++keys };
    setQuery("");
    setList([...list(), row]);
    setPicked(row.key);
    if (row.shortcut) void save(row.key);
    queueMicrotask(() => document.querySelector<HTMLInputElement>(".snippet-editor .snippet-key input")?.focus());
  };
  /** A copy under the first free shortcut: offer → offer2, offer3… */
  const duplicate = (s: Row) => {
    const taken = new Set(list().map((r) => r.shortcut.toLowerCase()));
    let n = 2;
    while (taken.has(`${s.shortcut}${n}`.toLowerCase())) n++;
    add({ ...s, shortcut: `${s.shortcut}${n}`, name: s.name ? `${s.name} (copy)` : "" });
  };
  /** What the shortcut field says under itself. */
  const shortcutNote = (s: Row): { text: string; ok: boolean } | null => {
    const why = refused()[s.key];
    if (why) return { text: `${why} Not saved until the shortcut changes.`, ok: false };
    const word = s.shortcut.trim().replace(/^;/, "");
    if (!word) return { text: "One word, such as thanks.", ok: false };
    const other = list().find((r) => r.key !== s.key && r.shortcut.toLowerCase() === word.toLowerCase());
    if (other) return { text: `Taken by ${other.name || `;${other.shortcut}`}.`, ok: false };
    return { text: "Free to use", ok: true };
  };
  let text: HTMLTextAreaElement | undefined;
  /** Puts `{place}` where the cursor is in the text. */
  const insertPlace = (key: string) => {
    const s = current();
    if (!s || !text) return;
    const at = text.selectionStart ?? s.body.length;
    const end = text.selectionEnd ?? at;
    const place = `{${key}}`;
    edit({ body: s.body.slice(0, at) + place + s.body.slice(end) });
    queueMicrotask(() => (text!.focus(), text!.setSelectionRange(at + place.length, at + place.length)));
  };
  // The preview writes to someone made up, from the account the snippet is for.
  const sample = (s: Row) => {
    const me = props.accounts.find((a) => a.id === s.accountId) ?? props.accounts[0];
    const fill = (t: string) => fillSnippet(t, { email: "ana.rossi@example.com", name: "Ana Rossi" }, "Q4 offer", me?.displayName ?? "");
    const [before, ...after] = fill(s.body).split("{cursor}");
    return { before, after: after.join(""), subject: s.subject ? fill(s.subject) : null };
  };
  const firstLine = (body: string) => body.replace(/\{cursor\}/g, "").split("\n").find((l) => l.trim()) ?? "";

  return (
    <div class="snippets-settings">
      <div class="section-intro">
        <p class="help">
          Type <kbd>;</kbd> in a message to pick one, or type its shortcut and <kbd>Space</kbd>.
        </p>
        <button class="primary" onClick={() => add()}>
          <Icon name="plus" size={14} /> New snippet
        </button>
      </div>
      <Show when={error()}>
        <p class="setting-error">{error()}</p>
      </Show>
      <Show
        when={list().length}
        fallback={
          <div class="settings-empty">
            <p>No snippets yet. Save the replies you write again and again, then type <kbd>;</kbd> to use one.</p>
          </div>
        }
      >
        <div class="master-detail">
          <section class="master panel" aria-label="Your snippets">
            <span class="panel-head">
              {list().length} {list().length === 1 ? "snippet" : "snippets"}
            </span>
            <input
              type="search"
              class="find"
              placeholder="Find a snippet"
              aria-label="Find a snippet"
              value={query()}
              onInput={(e) => setQuery(e.currentTarget.value)}
            />
            <div class="filters" role="group" aria-label="Show">
              <button class="pill" aria-pressed={filter() === "all"} onClick={() => setFilter("all")}>
                All
              </button>
              <Show when={props.accounts.length > 1}>
                <For each={props.accounts}>
                  {(a) => (
                    <button class="pill" aria-pressed={filter() === a.id} onClick={() => setFilter(a.id)}>
                      {accountName(a)}
                    </button>
                  )}
                </For>
              </Show>
              <button class="pill" aria-pressed={filter() === "used"} onClick={() => setFilter("used")}>
                Most used
              </button>
            </div>
            <ul class="master-list">
              <For each={shown()} fallback={<li class="none">Nothing matches.</li>}>
                {(s) => (
                  <li>
                    <button classList={{ picked: s.key === picked() }} aria-current={s.key === picked()} onClick={() => setPicked(s.key)}>
                      <span class="row-head">
                        <span class="name">{s.name || "Untitled"}</span>
                        <span class="snippet-key">;{s.shortcut}</span>
                      </span>
                      <span class="row-sub">{firstLine(s.body)}</span>
                    </button>
                  </li>
                )}
              </For>
            </ul>
          </section>

          <Show when={current()}>
            {(s) => (
              <section class="detail panel snippet-editor" aria-label="Edit snippet">
                <Group title="Snippet">
                <div class="pair">
                  <label class="field">
                    <span class="title">Name</span>
                    <input value={s().name} onInput={(e) => edit({ name: e.currentTarget.value })} />
                  </label>
                  <label class="field snippet-key">
                    <span class="title">Shortcut</span>
                    <span class="prefixed" classList={{ invalid: !shortcutNote(s())?.ok }}>
                      <span aria-hidden="true">;</span>
                      <input
                        value={s().shortcut}
                        aria-invalid={!shortcutNote(s())?.ok}
                        onInput={(e) => edit({ shortcut: e.currentTarget.value })}
                      />
                    </span>
                    <Show when={shortcutNote(s())}>
                      {(note) => (
                        <span class="note" classList={{ ok: note().ok, bad: !note().ok && !!s().shortcut.trim() }}>
                          <Show when={note().ok}>
                            <Icon name="check" size={12} />
                          </Show>
                          {note().text}
                        </span>
                      )}
                    </Show>
                  </label>
                </div>

                <div class="field">
                  <span class="field-head">
                    <span class="title" id="snippet-text">
                      Text
                    </span>
                    <span class="hint">Click a field to put it where the cursor is</span>
                  </span>
                  <div class="textbox">
                    <div class="places" role="toolbar" aria-label="Fields to fill in">
                      <For each={PLACES}>
                        {(p) => (
                          <button type="button" class="place" classList={{ muted: p.key === "cursor" }} onClick={() => insertPlace(p.key)}>
                            {p.label}
                          </button>
                        )}
                      </For>
                    </div>
                    <textarea
                      ref={text}
                      rows={7}
                      aria-labelledby="snippet-text"
                      value={s().body}
                      placeholder={"Thanks {first_name}!\n\n{cursor}"}
                      onInput={(e) => edit({ body: e.currentTarget.value })}
                    />
                  </div>
                </div>
                </Group>

                <Group title="When it's used">
                <div class="pair">
                  <Show when={props.accounts.length > 1}>
                    <label class="field">
                      <span class="title">Available in</span>
                      <select
                        value={String(s().accountId ?? "")}
                        onChange={(e) => edit({ accountId: e.currentTarget.value ? Number(e.currentTarget.value) : null })}
                      >
                        <option value="">All accounts</option>
                        <For each={props.accounts}>{(a) => <option value={String(a.id)}>{accountName(a)} only</option>}</For>
                      </select>
                      <span class="help">Keep a snippet to the account it is written for.</span>
                    </label>
                  </Show>
                  <label class="field">
                    <span class="title">Also fill in</span>
                    <select
                      value={String(extras())}
                      onChange={(e) => {
                        const n = Number(e.currentTarget.value) as 0 | 1 | 2;
                        setExtras(n);
                        if (n === 0) edit({ subject: null, cc: [] });
                        else if (n === 1) edit({ cc: [] });
                      }}
                    >
                      <option value="0">Text only</option>
                      <option value="1">Text and subject</option>
                      <option value="2">Text, subject and Cc</option>
                    </select>
                    <span class="help">A snippet can set the subject or add people, too.</span>
                  </label>
                </div>
                <Show when={extras() > 0}>
                  <div class="pair">
                    <label class="field">
                      <span class="title">Subject</span>
                      <input
                        value={s().subject ?? ""}
                        placeholder="Used when the subject is empty"
                        onInput={(e) => edit({ subject: e.currentTarget.value })}
                      />
                    </label>
                    <Show when={extras() > 1}>
                      <label class="field">
                        <span class="title">Cc</span>
                        <input
                          value={s().cc.join(", ")}
                          placeholder="sales@example.com, …"
                          onChange={(e) => edit({ cc: e.currentTarget.value.split(/[,;\s]+/).filter(Boolean) })}
                        />
                      </label>
                    </Show>
                  </div>
                </Show>

                </Group>

                <Group title="Preview">
                  <MailPreview
                    head={[
                      ["To", "Ana Rossi <ana.rossi@example.com>"],
                      ["Subject", sample(s()).subject ?? "Q4 offer"],
                    ]}
                  >
                    <p class="preview-text">
                      {sample(s()).before}
                      <span class="caret" aria-label="The cursor goes here" />
                      {sample(s()).after}
                    </p>
                  </MailPreview>
                </Group>

                <footer class="detail-foot">
                  <span class="meta">
                    {s().id === 0
                      ? "Not saved until it has a shortcut"
                      : s().used
                        ? `Saved · used ${s().used === 1 ? "once" : `${s().used} times`}${s().lastUsed ? `, last ${lastDay(s().lastUsed!)}` : ""}`
                        : "Saved · not used yet"}
                  </span>
                  <span class="actions">
                    <button onClick={() => duplicate(s())} disabled={!s().shortcut.trim()}>
                      Duplicate
                    </button>
                    <button class="link danger" onClick={() => remove(s().key)}>
                      Delete
                    </button>
                  </span>
                </footer>
              </section>
            )}
          </Show>
        </div>
      </Show>
    </div>
  );
}

/** Whether editor HTML has any formatting; plain text without it goes as plain text. */
const formatted = (html: string) => /<(strong|em|u|s|a|code|ul|ol|blockquote)\b/i.test(html);

/** Signatures: several per account, one for new mail and one for replies, and where they go in a reply. */
/** HTML signatures set aside by a switch to "Write it here", by id: switching back brings them back. */
const keptHtml = new Map<number, string>();

function SignatureSettings(props: { accounts: Account[]; account: number | null; onAccount: (id: number) => void }) {
  const [list, setList] = createSignal<Signature[]>([]);
  const [picked, setPicked] = createSignal<number | null>(null);
  const [error, setError] = createSignal("");
  // Bumped to start the editor afresh (another signature picked, or formatting taken off).
  const [version, setVersion] = createSignal(0);
  const account = () => props.account ?? props.accounts[0]?.id ?? null;
  const mine = () => list().filter((s) => s.accountId === account());
  const current = () => list().find((s) => s.id === picked());
  const load = async () => {
    try {
      setList(await api.signatures());
    } catch (e) {
      setError(String(e));
    }
  };
  onMount(() => void load());
  // Another account: its first signature.
  createEffect(() => {
    const ids = mine().map((s) => s.id);
    if (!ids.includes(picked() ?? -1)) (setPicked(ids[0] ?? null), setVersion(version() + 1));
  });
  const pick = (id: number) => (setPicked(id), setVersion(version() + 1));
  // An HTML signature's text part is read from it.
  const setHtml = (html: string) => edit({ html, body: htmlText(html) });
  const change = (id: number, patch: Partial<Signature>) => setList(list().map((s) => (s.id === id ? { ...s, ...patch } : s)));
  let timer: number | undefined;
  let pending: number | null = null;
  const save = async (id: number) => {
    const s = list().find((r) => r.id === id);
    if (!s) return;
    try {
      await api.saveSignature(s);
    } catch (e) {
      setError(String(e));
    }
  };
  const edit = (patch: Partial<Signature>) => {
    const id = picked();
    if (id == null) return;
    change(id, patch);
    clearTimeout(timer);
    pending = id;
    timer = window.setTimeout(() => ((pending = null), void save(id)), 600);
  };
  onCleanup(() => {
    clearTimeout(timer);
    if (pending != null) void save(pending);
  });
  const add = async () => {
    const id = account();
    if (id == null) return;
    const name = mine().length ? `Signature ${mine().length + 1}` : "Signature";
    const made = await api.saveSignature({ id: 0, accountId: id, name, body: "", html: null, forNew: false, forReply: false });
    await load();
    pick(made);
    queueMicrotask(() => document.querySelector<HTMLElement>(".signature-editor .editor-body .ProseMirror")?.focus());
  };
  const remove = async (id: number) => {
    clearTimeout(timer);
    pending = null;
    await api.deleteSignature(id);
    await load();
  };
  const setDefault = async (reply: boolean, value: string) => {
    const id = account();
    if (id == null) return;
    await api.setSignatureDefault(id, reply, value ? Number(value) : null);
    await load();
  };
  const from = () => {
    const a = props.accounts.find((x) => x.id === account());
    return a ? (a.displayName ? `${a.displayName} <${a.email}>` : a.email) : "";
  };
  const forNew = () => mine().find((s) => s.forNew)?.id ?? null;
  const forReply = () => mine().find((s) => s.forReply)?.id ?? null;

  return (
    <div class="signatures-settings">
      <div class="section-intro">
        <p class="help">
          Each account can have several. Pick one for new mail and one for replies; switch in compose with{" "}
          <kbd>Ctrl Shift S</kbd>.
        </p>
        <button class="primary" onClick={() => void add()}>
          <Icon name="plus" size={14} /> New signature
        </button>
      </div>
      <Show when={props.accounts.length > 1}>
        <div class="tabs" role="tablist" aria-label="Account">
          <For each={props.accounts}>
            {(a) => (
              <button
                role="tab"
                aria-selected={a.id === account()}
                style={{ "--tab": colourOf(props.accounts, a.id) }}
                onClick={() => props.onAccount(a.id)}
              >
                <span class="dot" style={{ background: colourOf(props.accounts, a.id) }} />
                {accountName(a)} <span class="muted">· {a.email}</span>
              </button>
            )}
          </For>
        </div>
      </Show>
      <Show when={error()}>
        <p class="setting-error">{error()}</p>
      </Show>
      <div class="master-detail">
        <section class="master panel" aria-label="Signatures for this account">
          <span class="panel-head">
            {mine().length} {mine().length === 1 ? "signature" : "signatures"}
          </span>
          <ul class="master-list">
            <For each={mine()}>
              {(s) => (
                <li>
                  <button classList={{ picked: s.id === picked() }} aria-current={s.id === picked()} onClick={() => pick(s.id)}>
                    <span class="name">{s.name || "Untitled"}</span>
                    <span class="badges">
                      <Show when={s.forNew}>
                        <span class="badge">New mail</span>
                      </Show>
                      <Show when={s.forReply}>
                        <span class="badge">Replies</span>
                      </Show>
                      <Show when={!s.forNew && !s.forReply}>
                        <span class="row-sub">Pick it in compose</span>
                      </Show>
                    </span>
                  </button>
                </li>
              )}
            </For>
          </ul>
        </section>

        <Show
          when={current()}
          fallback={
            <div class="settings-empty">
              <p>No signature for this account yet. New signature starts one.</p>
            </div>
          }
        >
          {(s) => (
            <section class="detail panel signature-editor" aria-label="Edit signature">
              <Group title="Signature">
                <label class="field narrow">
                  <span class="title">Name</span>
                  <input value={s().name} onInput={(e) => edit({ name: e.currentTarget.value })} />
                </label>
                <fieldset class="field">
                  <legend class="title">Format</legend>
                  <span class="segmented">
                    <label classList={{ on: !s().custom }}>
                      <input
                        type="radio"
                        name="signature-kind"
                        checked={!s().custom}
                        onChange={() => {
                          if (s().html) keptHtml.set(s().id, s().html!);
                          edit({ custom: false, html: null });
                          setVersion(version() + 1);
                        }}
                      />
                      Write it here
                    </label>
                    <label classList={{ on: !!s().custom }}>
                      <input
                        type="radio"
                        name="signature-kind"
                        checked={!!s().custom}
                        onChange={() => {
                          const kept = keptHtml.get(s().id);
                          edit(kept ? { custom: true, html: kept, body: htmlText(kept) } : { custom: true });
                        }}
                      />
                      Paste from another app
                    </label>
                  </span>
                  <span class="help">
                    For a signature with a logo or a layout of its own: copy it in Gmail's or Outlook's settings and paste
                    it below. It goes out exactly as it is.
                  </span>
                </fieldset>
                <Show when={s().custom}>
                  <div class="field">
                    <div
                      class="paste-box"
                      contentEditable
                      role="textbox"
                      aria-label="Paste the signature here"
                      onBeforeInput={(e) => e.preventDefault()}
                      onPaste={(e) => {
                        e.preventDefault();
                        if (e.clipboardData) setHtml(pastedHtml(e.clipboardData));
                      }}
                    >
                      {s().html ? "Click here and press Ctrl+V to paste a new one" : "Click here and press Ctrl+V"}
                    </div>
                  </div>
                  <details class="field html-details">
                    <summary>Edit the HTML</summary>
                    <textarea
                      class="html-source"
                      rows={8}
                      spellcheck={false}
                      value={s().html ?? ""}
                      onInput={(e) => setHtml(e.currentTarget.value)}
                    />
                  </details>
                  <Show when={localPictures(s().html ?? "")}>
                    {(n) => (
                      <p class="help warn">
                        {n() === 1 ? "A picture is" : `${n()} pictures are`} only on this computer, so the people you write to
                        won't see {n() === 1 ? "it" : "them"}. Use pictures with a web address (https://…).
                      </p>
                    )}
                  </Show>
                </Show>
                <Show when={!s().custom}>
                <div class="field">
                  <span class="field-head">
                    <span class="title">Text</span>
                    <Show when={s().html}>
                      <button class="link plain" onClick={() => (edit({ html: null }), setVersion(version() + 1))}>
                        Take off the formatting
                      </button>
                    </Show>
                  </span>
                  <div class="textbox">
                    <Suspense fallback={<div class="editor-body" />}>
                      <Show when={version()} keyed>
                        {(_) => (
                          <Editor
                            text={s().body}
                            html={s().html}
                            toolbar
                            lineBreaks
                            onChange={(text, html) => edit({ body: text, html: formatted(html) ? html : null })}
                          />
                        )}
                      </Show>
                    </Suspense>
                  </div>
                </div>
                </Show>
              </Group>

              <Group title="When it's used">
              <div class="pair">
                <label class="field">
                  <span class="title">New messages</span>
                  <select onChange={(e) => void setDefault(false, e.currentTarget.value)}>
                    <Index each={mine()}>
                      {(x) => (
                        <option value={String(x().id)} selected={x().id === forNew()}>
                          {x().name || "Untitled"}
                        </option>
                      )}
                    </Index>
                    <option value="" selected={forNew() == null}>
                      None
                    </option>
                  </select>
                </label>
                <label class="field">
                  <span class="title">Replies and forwards</span>
                  <select onChange={(e) => void setDefault(true, e.currentTarget.value)}>
                    <Index each={mine()}>
                      {(x) => (
                        <option value={String(x().id)} selected={x().id === forReply()}>
                          {x().name || "Untitled"}
                        </option>
                      )}
                    </Index>
                    <option value="" selected={forReply() == null}>
                      None
                    </option>
                  </select>
                </label>
              </div>

              <fieldset class="field">
                <legend class="title">In replies, put it</legend>
                <span class="segmented">
                  <label classList={{ on: !settings.signatureBelow }}>
                    <input
                      type="radio"
                      name="signature-place"
                      checked={!settings.signatureBelow}
                      onChange={() => setSetting("signatureBelow", false)}
                    />
                    Above the quoted message
                  </label>
                  <label classList={{ on: settings.signatureBelow }}>
                    <input
                      type="radio"
                      name="signature-place"
                      checked={settings.signatureBelow}
                      onChange={() => setSetting("signatureBelow", true)}
                    />
                    Below it
                  </label>
                </span>
                <span class="help">
                  Above is where people read it; below is the older custom. Tern adds a “-- ” line before it so other
                  apps can fold it away.
                </span>
              </fieldset>

              </Group>

              <Group title="Preview">
                <MailPreview
                  head={[
                    ["From", from()],
                    ["To", "Ana Rossi <ana.rossi@example.com>"],
                    ["Subject", "Re: Q4 offer"],
                  ]}
                >
                  <p class="preview-text">Thanks, the offer follows tomorrow.</p>
                  <Show when={settings.signatureBelow}>
                    <p class="preview-quote">On Monday, Ana Rossi wrote: Could you send the offer by Friday?</p>
                  </Show>
                  <Show
                    when={s().custom && s().html}
                    fallback={<p class="preview-text preview-signature">{`-- \n${s().body.trim() || "(empty)"}`}</p>}
                  >
                    {(html) => <HtmlFrame html={html()} title="The signature as it goes out" />}
                  </Show>
                  <Show when={!settings.signatureBelow}>
                    <p class="preview-quote">On Monday, Ana Rossi wrote: Could you send the offer by Friday?</p>
                  </Show>
                </MailPreview>
              </Group>

              <footer class="detail-foot">
                <span class="meta">Changes save as you type.</span>
                <button class="link danger" onClick={() => void remove(s().id)}>
                  Delete
                </button>
              </footer>
            </section>
          )}
        </Show>
      </div>
    </div>
  );
}

/** One account: its name on sent mail, what else Tern knows of it, and a way to its signatures. */
function AccountPage(props: { account: Account; onSignatures: () => void; onRenamed: () => void }) {
  const security = (s: string) => (s === "tls" ? "TLS" : "STARTTLS");
  const [error, setError] = createSignal("");
  const rename = async (name: string) => {
    if (name.trim() === props.account.displayName) return;
    setError("");
    try {
      await api.setAccountName(props.account.id, name);
      props.onRenamed();
    } catch (e) {
      setError(String(e));
    }
  };
  const [google, setGoogle] = createSignal(false);
  void api.googleAvailable().then(setGoogle, () => setGoogle(false));
  const [signing, setSigning] = createSignal(false);
  const gmail = () => props.account.imapHost.toLowerCase() === "imap.gmail.com";
  const signIn = async () => {
    setError("");
    setSigning(true);
    try {
      await api.googleSignIn(props.account.displayName, props.account.email);
      props.onRenamed();
    } catch (e) {
      setError(String(e));
    } finally {
      setSigning(false);
    }
  };
  return (
    <>
      <label class="setting">
        <span class="title">Your name</span>
        <input
          value={props.account.displayName}
          placeholder="Ada Lovelace"
          onChange={(e) => void rename(e.currentTarget.value)}
          onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
        />
        <span class="help">
          What people see as the sender: “{props.account.displayName || "Your name"} &lt;{props.account.email}&gt;”. Also
          the name in Settings and in the From picker.
        </span>
      </label>
      <Show when={error()}>
        <p class="setting-error">{error()}</p>
      </Show>
      <div class="setting">
        <span class="title">Address</span>
        <span>{props.account.email}</span>
      </div>
      <div class="setting">
        <span class="title">Sign-in</span>
        <span class="value-action">
          {props.account.auth === "google" ? "With Google, in the browser" : gmail() ? "App password" : "Password"}
          <Show when={google() && (props.account.auth === "google" || gmail())}>
            <button onClick={() => void signIn()} disabled={signing()}>
              {signing() ? "Waiting for the browser…" : props.account.auth === "google" ? "Sign in again" : "Switch to Google sign-in"}
            </button>
          </Show>
        </span>
        <Show when={google() && (props.account.auth === "google" || gmail())}>
          <span class="help">
            {props.account.auth === "google"
              ? "Opens Google in your browser. Use it if Tern says the sign-in expired or was removed."
              : "Opens Google in your browser. Tern then forgets the app password; remove it in your Google account too."}
          </span>
        </Show>
      </div>
      <div class="setting">
        <span class="title">Incoming mail</span>
        <span class="mono">
          {props.account.imapHost}:{props.account.imapPort} · {security(props.account.imapSecurity)}
        </span>
      </div>
      <div class="setting">
        <span class="title">Outgoing mail</span>
        <span class="mono">
          {props.account.smtpHost}:{props.account.smtpPort} · {security(props.account.smtpSecurity)}
        </span>
      </div>
      <div class="setting">
        <span class="title">Signatures</span>
        <button onClick={props.onSignatures}>Edit signatures</button>
      </div>
    </>
  );
}

type Section = {
  /** Unique: a section name, or "account:<id>". */
  id: string;
  name: string;
  group: "General" | "Writing" | "Accounts";
  /** What search finds it by, besides its name. */
  words: string;
  body: () => JSX.Element;
  dot?: string;
};

/** Ctrl+, : settings over the list (docs/design/ui.md §4.8). Changes apply and are saved at once. */
export function SettingsPage(props: {
  accounts: Account[];
  onClose: () => void;
  /** An account was changed here (renamed): read them again. */
  onAccountsChanged: () => void;
  section?: string;
}) {
  const [signatureAccount, setSignatureAccount] = createSignal<number | null>(null);
  const sections = (): Section[] => [
    {
      id: "Appearance",
      name: "Appearance",
      group: "General",
      words: "theme dark light density rows inbox zero empty tern scene",
      body: () => <AppearanceSettings />,
    },
    {
      id: "Reading",
      name: "Reading",
      group: "General",
      words: "open conversations mark read inbox split important other images logos designed dark",
      body: () => <ReadingSettings />,
    },
    { id: "Notifications", name: "Notifications", group: "General", words: "notify new mail quiet hours", body: () => <NotificationSettings /> },
    { id: "Desktop", name: "Desktop", group: "General", words: "background tray close login start email links mailto default", body: () => <DesktopSettings /> },
    {
      id: "AI",
      name: "AI",
      group: "General",
      words: "ai claude anthropic openai gpt gemini google api key summary summarize replies suggest write rewrite style voice model privacy",
      body: () => <AiSettingsPage accounts={props.accounts} />,
    },
    { id: "About", name: "About", group: "General", words: "version log bug report problem help beta", body: () => <AboutSettings /> },
    { id: "Compose", name: "Compose", group: "Writing", words: "undo send delay attachment forgotten attached prilog anhang", body: () => <ComposeSettings /> },
    { id: "Snippets", name: "Snippets", group: "Writing", words: "saved replies templates shortcut text", body: () => <SnippetSettings accounts={props.accounts} /> },
    {
      id: "Signatures",
      name: "Signatures",
      group: "Writing",
      words: "signature replies quoted below above",
      body: () => <SignatureSettings accounts={props.accounts} account={signatureAccount()} onAccount={setSignatureAccount} />,
    },
    ...props.accounts.map(
      (a): Section => ({
        id: `account:${a.id}`,
        name: accountName(a),
        group: "Accounts",
        words: `${a.email} server imap smtp account`,
        dot: colourOf(props.accounts, a.id),
        body: () => (
          <AccountPage
            account={props.accounts.find((x) => x.id === a.id) ?? a}
            onSignatures={() => (setSignatureAccount(a.id), setSection("Signatures"))}
            onRenamed={props.onAccountsChanged}
          />
        ),
      }),
    ),
  ];
  const [section, setSection] = createSignal(props.section && sections().some((s) => s.id === props.section) ? props.section : "Appearance");
  const [query, setQuery] = createSignal("");
  const found = createMemo(() => {
    const q = query().trim().toLowerCase();
    return q ? sections().filter((s) => `${s.name} ${s.words}`.toLowerCase().includes(q)) : sections();
  });
  // Searching shows the first section found when the open one doesn't match.
  createEffect(() => {
    const hits = found();
    if (hits.length && !hits.some((s) => s.id === section())) setSection(hits[0].id);
  });
  const open = () => sections().find((s) => s.id === section()) ?? sections()[0];
  // Made again only when another section is picked. The account list is read again whenever sync reports, and
  // remaking the page then would take the focus from the field being typed in.
  const body = createMemo(() => {
    section();
    return untrack(() => open().body());
  });
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
      <nav aria-label="Settings sections">
        <div class="nav-head">
          <h2>Settings</h2>
          <kbd>Ctrl ,</kbd>
        </div>
        <input
          type="search"
          class="find"
          placeholder="Search settings"
          aria-label="Search settings"
          value={query()}
          onInput={(e) => setQuery(e.currentTarget.value)}
        />
        <For each={["General", "Writing", "Accounts"] as const}>
          {(group) => (
            <Show when={found().some((s) => s.group === group)}>
              <span class="nav-group">{group}</span>
              <For each={found().filter((s) => s.group === group)}>
                {(s) => (
                  <a href="#" classList={{ active: s.id === section() }} aria-current={s.id === section() ? "page" : undefined} onClick={(e) => (e.preventDefault(), setSection(s.id))}>
                    <Show when={s.dot}>
                      <span class="dot" style={{ background: s.dot }} />
                    </Show>
                    {s.name}
                  </a>
                )}
              </For>
            </Show>
          )}
        </For>
        <Show when={!found().length}>
          <p class="nav-none">No setting matches.</p>
        </Show>
        <button class="link close" onClick={props.onClose}>
          Close settings <kbd>Esc</kbd>
        </button>
      </nav>
      <div class="settings-body">
        <div class="settings-content" classList={{ wide: open().id === "Snippets" || open().id === "Signatures" }}>
          <h1>{open().name}</h1>
          {body()}
        </div>
      </div>
    </div>
  );
}
