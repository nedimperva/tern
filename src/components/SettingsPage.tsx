import {
  createEffect,
  createMemo,
  createSignal,
  For,
  lazy,
  on,
  onCleanup,
  onMount,
  Show,
  Suspense,
  untrack,
  type JSX,
} from "solid-js";
import { api, type Account, type Signature, type Snippet } from "../api";
import { colourOf } from "../colours";
import { setSetting, settings, type Settings } from "../settings";
import { fillSnippet, PLACES } from "../snippets";
import { Icon } from "./Icon";
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
              <button role="tab" aria-selected={a.id === account()} onClick={() => props.onAccount(a.id)}>
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
              </Group>

              <Group title="When it's used">
              <div class="pair">
                <label class="field">
                  <span class="title">New messages</span>
                  <select value={String(forNew() ?? "")} onChange={(e) => void setDefault(false, e.currentTarget.value)}>
                    <For each={mine()}>{(x) => <option value={String(x.id)}>{x.name || "Untitled"}</option>}</For>
                    <option value="">None</option>
                  </select>
                </label>
                <label class="field">
                  <span class="title">Replies and forwards</span>
                  <select value={String(forReply() ?? "")} onChange={(e) => void setDefault(true, e.currentTarget.value)}>
                    <For each={mine()}>{(x) => <option value={String(x.id)}>{x.name || "Untitled"}</option>}</For>
                    <option value="">None</option>
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
                  <p class="preview-text preview-signature">{`-- \n${s().body.trim() || "(empty)"}`}</p>
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
    { id: "Appearance", name: "Appearance", group: "General", words: "theme dark light density rows", body: () => <AppearanceSettings /> },
    {
      id: "Reading",
      name: "Reading",
      group: "General",
      words: "open conversations mark read inbox split important other images logos designed dark",
      body: () => <ReadingSettings />,
    },
    { id: "Notifications", name: "Notifications", group: "General", words: "notify new mail quiet hours", body: () => <NotificationSettings /> },
    { id: "Desktop", name: "Desktop", group: "General", words: "background tray close login start email links mailto default", body: () => <DesktopSettings /> },
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
            account={a}
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
          {open().body()}
        </div>
      </div>
    </div>
  );
}
