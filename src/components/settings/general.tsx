// Appearance, Reading, Compose, About, Notifications and Desktop.

import { createResource, createSignal, onMount, Show } from "solid-js";
import { api } from "../../api";
import { omarchyAvailable, setSetting, settings } from "../../settings";
import { NIGHT_SHIFT, SCENES, TIDE_REPORT } from "../../zero";
import { Select } from "./shared";

export function AppearanceSettings() {
  return (
    <>
      <Select
        name="theme"
        title="Mood"
        help={
          omarchyAvailable()
            ? "System picks Dawn or Dusk from your desktop. Omarchy takes the colours of your Omarchy theme and changes with it."
            : "System picks Dawn or Dusk from your desktop's light or dark setting."
        }
        choices={[
          { label: "System", value: "system" },
          { label: "Dawn", value: "light" },
          { label: "Dusk", value: "dark" },
          { label: "Night Sea", value: "sea" },
          ...(omarchyAvailable() || settings.theme === "omarchy" ? [{ label: "Omarchy", value: "omarchy" as const }] : []),
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
        name="sidebar"
        title="Sidebar"
        help="Accounts and folders beside the list when the window is wide enough. Ctrl+\ or the button at the top left shows or hides it."
        choices={[
          { label: "Beside the list", value: true },
          { label: "Only when asked", value: false },
        ]}
      />
      <Select
        name="zeroScene"
        title="Inbox Zero"
        help="What an empty inbox shows. Flock, Streak and Your migration count what you clear in Tern on this computer."
        choices={[
          { label: "A different tern each day", value: "rotate" },
          ...[...SCENES, NIGHT_SHIFT, TIDE_REPORT].map((s) => ({ label: s.name, value: s.id as string })),
        ]}
      />
    </>
  );
}

export function ReadingSettings() {
  return (
    <>
      <Select
        name="dayStart"
        title="Start of the day"
        help="On the first open of a day, a screen with what waits on you, then a line above the inbox. Counted on this computer."
        choices={[
          { label: "Morning screen and the line", value: "screen" },
          { label: "Only the line above the inbox", value: "line" },
          { label: "Neither", value: "off" },
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
        name="readingFacts"
        title="In this message"
        help="Beside a conversation: the day and time it names, an address, what it asks of you, codes to copy and its links. Found on this computer."
        choices={[
          { label: "Show them", value: true },
          { label: "Don't show them", value: false },
        ]}
      />
      <Select
        name="newsletterReading"
        title="Newsletters"
        help="Mail its sender designed, sent to a list. Reading view shows its words and pictures in Tern's type, with its parts and links beside it. The book icon switches."
        choices={[
          { label: "Open in reading view", value: true },
          { label: "Open as sent", value: false },
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

export function ComposeSettings() {
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
const megabytes = (bytes: number) => (bytes < 1_000_000 ? `${Math.round(bytes / 1000)} KB` : `${Math.round(bytes / 1_000_000)} MB`);

export function AboutSettings() {
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
  const [cacheSize, { refetch: weighCache }] = createResource(() => api.receivedCacheSize().catch(() => 0));
  const clearCache = async () => {
    await api.clearReceivedCache().catch(() => {});
    void weighCache();
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
          <div class="setting">
            <span class="title">Downloaded attachments</span>
            <span class="value-action">
              {cacheSize() == null ? "…" : megabytes(cacheSize()!)}
              <button disabled={!cacheSize()} onClick={() => void clearCache()}>
                Clear
              </button>
            </span>
            <span class="help">
              Files and pictures from received mail, kept after the first open so they open at once and offline. Tern
              keeps up to 1 GB; cleared files download again when opened.
            </span>
          </div>
        </>
      )}
    </Show>
  );
}

export function NotificationSettings() {
  return (
    <>
      <Select
        name="notify"
        title="New mail"
        help="A notification when mail from someone else reaches the inbox. Muted conversations stay quiet. An account can have its own choice in Settings → the account."
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
      <Select
        name="wingBeat"
        title="Sound when mail leaves"
        help="A soft wing beat as a message goes out of the outbox. Quiet hours keep it quiet too."
        choices={[
          { label: "Off", value: false },
          { label: "Wing beat", value: true },
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
