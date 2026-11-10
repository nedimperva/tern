// Appearance, Reading, Compose, About, Notifications and Desktop.

import { createSignal, For, onMount, Show } from "solid-js";
import { api, type About } from "../../api";
import { omarchyAvailable, ROW_HEIGHTS, setSetting, settings } from "../../settings";
import { labelColour } from "../../colours";
import { NIGHT_SHIFT, SCENES, TIDE_REPORT } from "../../zero";
import { radioKeys } from "../../a11y";
import { Chip, Group, Preview, Row, Segmented, Segments, Select, Switch, Toggle } from "./shared";
import { Icon } from "../Icon";

export function AppearanceSettings() {
  const moods = () => [
    { value: "system" as const, name: "System", note: "Follows your desktop", swatch: "linear-gradient(135deg, #fcfbf9 50%, #201f1d 50%)" },
    { value: "light" as const, name: "Dawn", note: "Warm light", swatch: "#fcfbf9" },
    { value: "dark" as const, name: "Dusk", note: "Warm dark", swatch: "#201f1d" },
    { value: "sea" as const, name: "Night Sea", note: "Deep blue dark", swatch: "#131926" },
    ...(omarchyAvailable() || settings.theme === "omarchy"
      ? [{ value: "omarchy" as const, name: "Omarchy", note: "Your desktop theme", swatch: "linear-gradient(135deg, #1a1b26, #7aa2f7)" }]
      : []),
  ];
  return (
    <>
      <LookPreview />
      <section class="settings-group">
        <div class="settings-group-head">
          <h2 id="mood-head">Mood</h2>
        </div>
        {/* A visual choice, so its choices are pictures (idea 56). */}
        <div class="moods" role="radiogroup" aria-labelledby="mood-head" onKeyDown={radioKeys}>
          <For each={moods()}>
            {(m) => (
              // biome-ignore lint/a11y/useSemanticElements: a styled radio; radioKeys gives it the arrow keys of a native one
              <button
                type="button"
                role="radio"
                aria-checked={settings.theme === m.value}
                tabIndex={settings.theme === m.value ? 0 : -1}
                classList={{ mood: true, on: settings.theme === m.value }}
                onClick={() => setSetting("theme", m.value)}
              >
                <span class="swatch" style={{ background: m.swatch }} />
                <span class="name">{m.name}</span>
                <span class="note">{m.note}</span>
              </button>
            )}
          </For>
        </div>
      </section>
      <Group title="Layout">
        <Segments
          name="density"
          title="Density"
          help="How tall each row in the list is."
          choices={[
            { label: "Dense", value: "dense" },
            { label: "Comfortable", value: "comfortable" },
            { label: "Spacious", value: "spacious" },
          ]}
        />
        <Segments
          name="sidebar"
          title="Sidebar"
          help="Accounts and folders. Ctrl+\ or the button at the top left shows or hides it."
          choices={[
            { label: "Beside the list", value: true },
            { label: "When asked", value: false },
          ]}
        />
      </Group>
      <Group title="Inbox Zero">
        <Select
          name="zeroScene"
          title="What an empty inbox shows"
          help="Flock, Streak and Your migration count what you clear in Tern on this computer."
          choices={[
            { label: "A different tern each day", value: "rotate" },
            ...[...SCENES, NIGHT_SHIFT, TIDE_REPORT].map((s) => ({ label: s.name, value: s.id as string })),
          ]}
        />
      </Group>
    </>
  );
}

/** Two list rows and an open message drawn with the list's own classes, so a change of mood or density shows here
 * at once (canvas "Tern polish, now and after", 5). Made-up mail: nothing in it is the person's. */
function LookPreview() {
  const rows = [
    { who: "Ada Lovelace", subject: "Offsite", snippet: "Can you bring the Q3 deck?", label: "Work", date: "3:58 PM", unread: true },
    { who: "GitHub", subject: "CI passed", snippet: "All checks have passed.", date: "Thu", unread: false },
  ];
  return (
    <Preview>
      <div class="look-preview" aria-hidden="true">
      <div class="look-rows">
        {rows.map((r, i) => (
          <div style={{ height: `${ROW_HEIGHTS[settings.density]}px` }}>
            <div class="crow" classList={{ focused: i === 0, unread: r.unread }}>
              <span class="who">
                <span class="names">{r.who}</span>
              </span>
              <span class="what">
                <span class="subject">{r.subject}</span>
                <Show when={r.label}>
                  {(l) => (
                    <span class="labels">
                      <span class="label-chip" style={{ "--label": labelColour(l()) }}>
                        {l()}
                      </span>
                    </span>
                  )}
                </Show>
                <span class="snippet">{r.snippet}</span>
              </span>
              <span class="date">{r.date}</span>
            </div>
          </div>
        ))}
      </div>
      <div class="look-card">
        <strong>Ada Lovelace</strong>
        <p>The offsite is set for Monday 16 November. Can you bring the Q3 deck?</p>
        <span class="look-actions">
          <span class="look-done">Done</span>
          <span class="look-link">A link</span>
        </span>
      </div>
      </div>
    </Preview>
  );
}

export function ReadingSettings() {
  return (
    <>
      {/* A sender's line as these choices draw it: logo or initials, pictures held back, reading view (idea 55). */}
      <Preview note="It follows the choices below: logos, pictures and newsletters.">
        <div class="preview-sheet reading-preview" aria-hidden="true">
          <span class="who-mark" classList={{ logo: settings.senderLogos }}>
            {settings.senderLogos ? <Icon name="globe" size={16} /> : "GH"}
          </span>
          <span class="who-text">
            <strong>GitHub</strong> <span class="small">· notifications@github.com</span>
            <span class="small block">{settings.senderLogos ? "Logo from github.com" : "Initials: logos are off"}</span>
          </span>
          <span class="state-chip">{settings.newsletterReading ? "Reading view" : "As sent"}</span>
          <Show
            when={settings.loadImages === "ask"}
            fallback={<span class="images-line small">Pictures from the web load as the mail opens.</span>}
          >
            <span class="images-line">
              3 pictures from the web are held back. <span class="look-link">Load images</span>
            </span>
          </Show>
        </div>
      </Preview>
      <Group title="Opening mail">
        <Segments
          name="dayStart"
          title="Start of the day"
          help="The morning screen on the first open of a day. G then O shows it any time."
          choices={[
            { label: "Morning screen", value: "screen" },
            { label: "Inbox", value: "off" },
          ]}
        />
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
          help="U marks it either way by hand."
          choices={[
            { label: "Immediately", value: 0 },
            { label: "After 1 second", value: 1000 },
            { label: "Only when I mark it", value: -1 },
          ]}
        />
      </Group>
      <Group title="Inbox">
        <Toggle
          name="splitInbox"
          title="Split the inbox"
          help="Other holds mail sent to many: newsletters, notifications, receipts. Ctrl+K → Move sender moves one."
        />
        <Toggle
          name="readingFacts"
          title="In this message"
          help="The day, place and codes the newest message names, in the companion (i). Found on this computer."
        />
      </Group>
      <Group title="Privacy">
        <Segments
          name="loadImages"
          title="Pictures from the web"
          help="They can tell the sender when you read their mail."
          choices={[
            { label: "Ask each time", value: "ask" },
            { label: "Always load", value: "always" },
          ]}
        />
        <Toggle
          name="senderLogos"
          title="Sender logos"
          help="A company's logo instead of initials, from its own website once a month. Personal addresses keep initials."
        />
      </Group>
      <Group title="Designed mail">
        <Segments
          name="newsletterReading"
          title="Newsletters"
          help="Reading view shows their words and pictures in Tern's type. The book icon switches."
          choices={[
            { label: "Reading view", value: true },
            { label: "As sent", value: false },
          ]}
        />
        <Segments
          name="darkMail"
          title="In dark mode"
          help="Darkened, their backgrounds go dark and their text light; pictures stay as they are."
          choices={[
            { label: "Darken", value: "darken" },
            { label: "Keep colours", value: "original" },
          ]}
        />
      </Group>
    </>
  );
}

export function ComposeSettings() {
  const [word, setWord] = createSignal("");
  const addWord = () => {
    const w = word().trim();
    if (w && !settings.attachmentWords.includes(w)) setSetting("attachmentWords", [...settings.attachmentWords, w]);
    setWord("");
  };
  return (
    <>
      {/* Both safety nets as they show: the leaving pill after Send, the forgotten-file line before it (idea 65). */}
      <Preview>
        <div class="preview-pair" aria-hidden="true">
          <div class="preview-sheet">
            <span class="small">After Send</span>
            <span class="leaving-pill">
              {settings.sendDelay ? (
                <>
                  Sending “Q3 offer” in {settings.sendDelay} s <span class="dim">Z undo</span>
                </>
              ) : (
                "Sent “Q3 offer”"
              )}
            </span>
          </div>
          <div class="preview-sheet">
            <span class="small">Before Send</span>
            <p class="forgot-text">
              Here is the offer, <mark>attached</mark> as a PDF.
            </p>
            <Show when={settings.attachmentCheck} fallback={<span class="small">No check: it would go without the file.</span>}>
              <span class="forgot-line">You wrote “attached”, but nothing is attached.</span>
            </Show>
          </div>
        </div>
      </Preview>
      <Group title="Sending">
        <Segments
          name="sendDelay"
          title="Undo send"
          help="How long a sent message waits, so Z can take it back."
          choices={[
            { label: "Off", value: 0 },
            { label: "5 s", value: 5 },
            { label: "10 s", value: 10 },
            { label: "20 s", value: 20 },
          ]}
        />
      </Group>
      <Group title="Forgotten files">
        <Toggle
          name="attachmentCheck"
          title="Check before sending"
          help="When you write that something is attached (“attached”, “u prilogu”, “im Anhang”…) and nothing is."
        />
        <Show when={settings.attachmentCheck}>
          <Row
            title="Your own words"
            class="sub"
            help="Tern knows the usual ones in English, Bosnian, Croatian, Serbian, German, French, Spanish, Italian, Portuguese, Dutch, Polish and Turkish."
          >
            <span class="word-tags">
              <For each={settings.attachmentWords}>
                {(w) => (
                  <span class="word-tag">
                    {w}
                    <button
                      type="button"
                      aria-label={`Remove ${w}`}
                      onClick={() => setSetting("attachmentWords", settings.attachmentWords.filter((x) => x !== w))}
                    >
                      ×
                    </button>
                  </span>
                )}
              </For>
              <input
                aria-label="Add a word"
                placeholder="Add a word"
                value={word()}
                onInput={(e) => setWord(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === ",") (e.preventDefault(), addWord());
                }}
                onBlur={addWord}
              />
            </span>
          </Row>
        </Show>
      </Group>
    </>
  );
}

const ISSUES = "https://github.com/nedimperva/tern/issues/new?template=bug_report.yml";
const BETA_GUIDE = "https://github.com/nedimperva/tern/blob/main/docs/beta.md";
const CACHE_LIMIT = 1_000_000_000;

/** The version, and what a bug report needs: details without addresses, the log, the issue form. */
const megabytes = (bytes: number) => (bytes < 1_000_000 ? `${Math.round(bytes / 1000)} KB` : `${Math.round(bytes / 1_000_000)} MB`);

export function AboutSettings() {
  // Plain signals, not resources: a resource read inside Settings' Suspense blanked the whole page until it came.
  const [about, setAbout] = createSignal<About | null>(null);
  onMount(() => void api.about().then(setAbout, () => {}));
  const [copied, setCopied] = createSignal<"yes" | "no" | null>(null);
  const [showDetails, setShowDetails] = createSignal(false);
  let details: HTMLPreElement | undefined;
  const copy = async () => {
    const done = await navigator.clipboard.writeText(about()?.details ?? "").then(
      () => true,
      () => false,
    );
    // Refused (the window lost focus, say): the text is shown and selected instead, for Ctrl+C.
    if (!done) {
      setShowDetails(true);
      if (details) window.getSelection()?.selectAllChildren(details);
    }
    setCopied(done ? "yes" : "no");
    setTimeout(() => setCopied(null), 3000);
  };
  const [cacheSize, setCacheSize] = createSignal<number | null>(null);
  const weighCache = () => api.receivedCacheSize().then(setCacheSize, () => setCacheSize(0));
  onMount(() => void weighCache());
  const clearCache = async () => {
    await api.clearReceivedCache().catch(() => {});
    void weighCache();
  };
  return (
    <Show when={about()}>
      {(a) => (
        <>
          <div class="settings-card about-head">
            <div class="settings-empty-row">
              <img src="/tern.svg" alt="" width="40" height="40" />
              <span>
                <strong>Tern {a().version}</strong>
                <span>What works, what doesn't yet, and how to go back to an earlier version.</span>
              </span>
              <button type="button" class="link" onClick={() => api.openUrl(BETA_GUIDE)}>
                Beta guide
              </button>
            </div>
          </div>
          <Show when={a().updates}>
            <Group title="Updates">
              <Row
                title="Channel"
                help="Beta gets what comes next a week or two early. Tern never installs an older version: your mail database only moves forward."
              >
                <Segmented
                  label="Updates"
                  value={settings.updateChannel}
                  choices={[
                    { label: "Stable", value: "stable" as const },
                    { label: "Beta", value: "beta" as const },
                  ]}
                  onChange={(v) => {
                    setSetting("updateChannel", v);
                    void api.lookForUpdate();
                  }}
                />
              </Row>
            </Group>
          </Show>
          <Group title="Help">
            <Row title="Report a problem" help="On GitHub. Paste the details below, and the end of the log if something failed.">
              <button onClick={() => api.openUrl(`${ISSUES}&version=${encodeURIComponent(a().version)}`)}>Open the form</button>
            </Row>
            <Row title="Details for a bug report" help="Your version, system and each account's provider. No addresses or server names of your own.">
              <span class="value-action">
                <button onClick={() => void copy()}>{copied() === "yes" ? "Copied" : copied() === "no" ? "Selected: press Ctrl+C" : "Copy"}</button>
                <button
                  type="button"
                  class="icon-button"
                  aria-label={showDetails() ? "Hide the details" : "Show the details"}
                  aria-expanded={showDetails()}
                  onClick={() => setShowDetails(!showDetails())}
                >
                  <Icon name={showDetails() ? "chevron-up" : "chevron-down"} size={15} />
                </button>
              </span>
              <Show when={showDetails()}>
                <pre class="about-details" ref={details}>
                  {a().details}
                </pre>
              </Show>
            </Row>
            <Row title="Log" help={<span class="about-path">{a().logFile}</span>}>
              <button onClick={() => void api.openLogs()}>Open folder</button>
            </Row>
          </Group>
          <Group title="Storage">
            <Row
              title="Downloaded attachments"
              help={
                <>
                  <span class="mini-meter storage-meter">
                    <span class="track">
                      <span style={{ width: `${Math.min(100, ((cacheSize() ?? 0) / CACHE_LIMIT) * 100)}%` }} />
                    </span>
                    {cacheSize() == null ? "…" : `${megabytes(cacheSize()!)} of 1 GB`}
                  </span>
                  Files from received mail, kept after the first open so they open at once and offline. Cleared files download again when opened.
                </>
              }
            >
              <button class="danger-text" disabled={!cacheSize()} onClick={() => void clearCache()}>
                Clear
              </button>
            </Row>
          </Group>
        </>
      )}
    </Show>
  );
}

const minutes = (t: string) => {
  const [h, m] = t.split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
};

export function NotificationSettings() {
  const quiet = () => !!(settings.quietFrom && settings.quietTo);
  const setQuiet = (on: boolean) => {
    setSetting("quietFrom", on ? settings.quietFrom || "22:00" : "");
    setSetting("quietTo", on ? settings.quietTo || "07:00" : "");
  };
  // The quiet hours as stretches of a day, for the strip; past midnight is two stretches.
  const stretches = () => {
    if (!quiet()) return [];
    const a = minutes(settings.quietFrom) / 1440;
    const b = minutes(settings.quietTo) / 1440;
    return a <= b ? [[a, b]] : [[0, b], [a, 1]];
  };
  const now = () => {
    const d = new Date();
    return (d.getHours() * 60 + d.getMinutes()) / 1440;
  };
  return (
    <>
      <Preview>
        <div class="preview-pair notify-preview" aria-hidden="true">
          <div class="toast-sample" classList={{ off: !settings.notify }}>
            <span class="app">
              <Icon name="mail" size={12} /> Tern · now
            </span>
            <strong>Ada Lovelace</strong>
            <span>Offsite: can you bring the Q3 deck?</span>
            <span class="toast-actions">
              <span>Archive</span>
              <span>Reply</span>
            </span>
          </div>
          <div class="quiet-strip">
            <span class="small">{quiet() ? `Quiet ${settings.quietFrom} – ${settings.quietTo}` : "No quiet hours"}</span>
            <span class="day">
              <For each={stretches()}>{([a, b]) => <span class="quiet" style={{ left: `${a * 100}%`, width: `${(b - a) * 100}%` }} />}</For>
              <span class="now" style={{ left: `${now() * 100}%` }} />
            </span>
            <span class="hours">
              <span>00</span>
              <span>06</span>
              <span>12</span>
              <span>18</span>
              <span>24</span>
            </span>
          </div>
        </div>
      </Preview>
      <Group title="New mail">
        <Toggle name="notify" title="Notify me" help="When mail from someone else reaches the inbox. Muted conversations stay quiet." />
        <Show when={settings.notify}>
          <Segments
            name="notifyOther"
            title="For"
            help="Other holds newsletters and automatic mail; it never interrupts unless you ask. An account can have its own choice."
            choices={[
              { label: "Important", value: false },
              { label: "All mail", value: true },
            ]}
          />
        </Show>
      </Group>
      <Group title="Quiet">
        <Row title="Quiet hours" help="Mail that arrives then waits in the inbox, without a notice later.">
          <Switch label="Quiet hours" on={quiet()} onChange={setQuiet} />
        </Row>
        <Show when={quiet()}>
          <Row title="From" class="sub">
            <span class="quiet-hours">
              <input type="time" value={settings.quietFrom} aria-label="Quiet from" onChange={(e) => setSetting("quietFrom", e.currentTarget.value)} />
              <span>to</span>
              <input type="time" value={settings.quietTo} aria-label="Quiet until" onChange={(e) => setSetting("quietTo", e.currentTarget.value)} />
            </span>
          </Row>
        </Show>
        <Toggle name="wingBeat" title="Sound when mail leaves" help="A soft wing beat as a message goes out. Quiet hours keep it quiet too." />
      </Group>
    </>
  );
}

/** Running in the background, login start and mailto: links. The last two live with the system, so they are asked
 * for and set there rather than kept in Tern's settings. */
export function DesktopSettings() {
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
      <Group title="Window">
        <Segments
          name="background"
          title="When the window closes"
          help="In the background, Tern keeps syncing and notifying from the tray. Ctrl+Q or the tray's Quit ends it."
          choices={[
            { label: "Keep running", value: true },
            { label: "Quit", value: false },
          ]}
        />
        <Row title="Start at login" help="Tern starts without a window and fetches mail in the background.">
          <Switch
            label="Start at login"
            on={login()}
            onChange={(on) =>
              void attempt(async () => {
                await api.setAutostart(on);
                setLogin(on);
              })
            }
          />
        </Row>
      </Group>
      <Group title="Email links">
        {/* Who opens them now, beside the button that changes it (idea 59). */}
        <Row title="Open email links in Tern" help="Clicking an email address (mailto:) on a web page or in another app starts a message here.">
          <Show when={!isDefault()} fallback={<Chip tone="ok">Tern opens them</Chip>}>
            <span class="value-action">
              <Chip>Another app</Chip>
              <button
                onClick={() =>
                  void attempt(async () => {
                    await api.makeDefaultMailApp();
                    setIsDefault(await api.defaultMailApp());
                  })
                }
              >
                Use Tern
              </button>
            </span>
          </Show>
        </Row>
      </Group>
      <Show when={error()}>
        <p class="setting-error">{error()}</p>
      </Show>
    </>
  );
}
