// Settings → Backup: Tern's setup as one file, to move to another computer or keep a copy. The person picks the
// parts, on the way out and on the way in. Passwords and keys stay out unless ticked, with a warning when they are.

import { createSignal, For, onMount, Show } from "solid-js";
import { type Account, type AiProvider, api, type SecretParts, type UnlockedSettings } from "../../api";
import { setTodoistOn } from "../../app/tasks";
import { type Backup, countOf, dataFrom, makeBackup, type Part, PARTS, partsOf, readBackup, settingsFrom } from "../../backup";
import { setSetting, settings, type Settings } from "../../settings";
import { Chip, Group, Preview, Row, Switch } from "./shared";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const list = (names: string[]) => (names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`);

const PROVIDERS: { id: AiProvider; name: string }[] = [
  { id: "anthropic", name: "Anthropic" },
  { id: "openai", name: "OpenAI" },
  { id: "gemini", name: "Google" },
];

/** Each part's name, and a line on what it holds given how many. */
const PART: Record<Part, { title: string; help: (n: number) => string; chip: (n: number) => string }> = {
  settings: {
    title: "Settings",
    help: () => "Look, reading, notifications, compose, saved searches, account colours, and your AI and Todoist choices. Never a key.",
    chip: () => "Settings",
  },
  snippets: { title: "Snippets", help: (n) => plural(n, "snippet"), chip: (n) => plural(n, "snippet") },
  signatures: { title: "Signatures", help: (n) => `${plural(n, "signature")}, for the accounts with the same address`, chip: (n) => plural(n, "signature") },
  senders: { title: "Sender choices", help: (n) => `${plural(n, "sender")} sent to Important or Other, or blocked`, chip: (n) => plural(n, "sender choice") },
  notes: { title: "Notes on people", help: (n) => plural(n, "note"), chip: (n) => plural(n, "note") },
  styles: { title: "Writing style", help: (n) => plural(n, "style note"), chip: (n) => plural(n, "style note") },
};

/** The parts of a file worth offering: those with something in them. */
const offered = (b: Backup) => partsOf(b).filter((p) => countOf(b, p) > 0);

const NONE: SecretParts = { accounts: false, aiKeys: false, todoist: false };
const anySecret = (s: SecretParts) => s.accounts || s.aiKeys || s.todoist;

export function BackupSettings(props: { accounts: Account[]; onAccountsChanged: () => void }) {
  const [note, setNote] = createSignal("");
  const [error, setError] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const run = async (work: () => Promise<string | null>) => {
    setNote("");
    setError("");
    setBusy(true);
    try {
      const said = await work();
      if (said) setNote(said);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  // What there is here to save, for the rows' lines and the preview.
  const [counts, setCounts] = createSignal<Partial<Record<Part, number>>>({});
  const [keysHere, setKeysHere] = createSignal<string[]>([]);
  const [todoistHere, setTodoistHere] = createSignal(false);
  onMount(() => {
    void Promise.all([api.snippets(), api.signatures(), api.backupData()]).then(
      ([a, b, d]) => setCounts({ settings: 1, snippets: a.length, signatures: b.length, senders: d.senders?.length ?? 0, notes: d.notes?.length ?? 0, styles: d.styles?.length ?? 0 }),
      () => {},
    );
    void Promise.all(PROVIDERS.map((p) => api.aiHasKey(p.id).catch(() => false))).then((has) => setKeysHere(PROVIDERS.filter((_, i) => has[i]).map((p) => p.name)));
    void api.todoistConnected().then(setTodoistHere, () => {});
  });

  // Export: every everyday part is in unless taken out; every secret is out unless ticked.
  const [out, setOut] = createSignal<Part[]>([...PARTS]);
  const [outSecrets, setOutSecrets] = createSignal<SecretParts>(NONE);
  const [passphrase, setPassphrase] = createSignal("");
  const [again, setAgain] = createSignal("");
  const pick = (p: Part, on: boolean) => setOut((now) => (on ? PARTS.filter((x) => x === p || now.includes(x)) : now.filter((x) => x !== p)));
  const sealing = () => anySecret(outSecrets());

  const exportNow = () =>
    run(async () => {
      if (!out().length && !sealing()) throw new Error("Pick at least one part to save.");
      if (sealing() && passphrase().length < 8) throw new Error("Choose a passphrase of at least 8 characters.");
      if (sealing() && passphrase() !== again()) throw new Error("The two passphrases differ.");
      const [snippets, signatures, data] = await Promise.all([api.snippets(), api.signatures(), api.backupData()]);
      const backup = makeBackup({ settings: { ...settings }, accounts: props.accounts, snippets, signatures, data, parts: out() });
      const saved = await api.exportSettings(JSON.stringify(backup, null, 2), sealing() ? passphrase() : null, sealing() ? outSecrets() : null);
      if (!saved) return null;
      const what = out().filter((p) => countOf(backup, p) > 0).map((p) => (p === "settings" ? "your settings" : PART[p].chip(countOf(backup, p))));
      const secrets = [
        outSecrets().accounts ? `${plural(props.accounts.length, "account")} with ${props.accounts.length === 1 ? "its password" : "their passwords"}` : "",
        outSecrets().aiKeys && keysHere().length ? `your ${list(keysHere())} ${keysHere().length === 1 ? "key" : "keys"}` : "",
        outSecrets().todoist && todoistHere() ? "your Todoist token" : "",
      ].filter(Boolean);
      if (!sealing()) return `Exported ${list(what)}.`;
      setPassphrase("");
      setAgain("");
      return `Exported ${list([...what, ...secrets])}, locked with your passphrase.`;
    });

  // Import: the file read, and what of it to take. A sealed one is opened in the engine first.
  const [locked, setLocked] = createSignal(false);
  const [unlockWith, setUnlockWith] = createSignal("");
  const [incoming, setIncoming] = createSignal<{ backup: Backup; secrets: UnlockedSettings | null } | null>(null);
  const [inParts, setInParts] = createSignal<Part[]>([]);
  const [inSecrets, setInSecrets] = createSignal<SecretParts>(NONE);
  const inPick = (p: Part, on: boolean) => setInParts((now) => (on ? PARTS.filter((x) => x === p || now.includes(x)) : now.filter((x) => x !== p)));

  const offer = (text: string, secrets: UnlockedSettings | null) => {
    const backup = readBackup(text);
    setIncoming({ backup, secrets });
    setInParts(offered(backup));
    // A sealed file was made to carry its secrets, and the passphrase was given: they start ticked.
    setInSecrets({ accounts: !!secrets?.accounts.length, aiKeys: !!secrets?.aiKeys.length, todoist: !!secrets?.todoist });
  };
  const cancelImport = () => {
    setLocked(false);
    setUnlockWith("");
    setIncoming(null);
    void api.forgetBackup().catch(() => {});
  };

  const importNow = () =>
    run(async () => {
      setLocked(false);
      setIncoming(null);
      const picked = await api.importSettings();
      if (!picked) return null;
      if (picked.locked) {
        setLocked(true);
        return null;
      }
      offer(picked.text ?? "", null);
      return null;
    });

  const unlock = () =>
    run(async () => {
      const opened = await api.unlockSettings(unlockWith());
      setLocked(false);
      setUnlockWith("");
      offer(opened.text, opened);
      return null;
    });

  /** Takes the picked parts: secrets first, so the accounts they add are there for signatures and the rest. */
  const take = () =>
    run(async () => {
      const inc = incoming();
      if (!inc) return null;
      const parts = inParts();
      const secrets = inc.secrets ? inSecrets() : NONE;
      if (!parts.length && !anySecret(secrets)) throw new Error("Pick at least one part to import.");
      const said: string[] = [];
      const after: string[] = [];
      let accounts = props.accounts;
      if (anySecret(secrets)) {
        const r = await api.restoreSecrets(secrets);
        if (r.added.length) {
          props.onAccountsChanged();
          accounts = await api.accounts();
          after.push(`Added ${list(r.added)}; ${r.added.length === 1 ? "its" : "their"} mail starts downloading now.`);
        }
        if (r.present.length) after.push(`${list(r.present)} ${r.present.length === 1 ? "was" : "were"} here already and kept ${r.present.length === 1 ? "its" : "their"} password.`);
        if (r.aiKeys.length) said.push(`your ${list(r.aiKeys)} AI ${r.aiKeys.length === 1 ? "key" : "keys"}`);
        if (r.aiKept.length) after.push(`The ${list(r.aiKept)} AI ${r.aiKept.length === 1 ? "key" : "keys"} saved here ${r.aiKept.length === 1 ? "was" : "were"} kept.`);
        if (r.todoist === "added") {
          said.push("your Todoist token");
          setTodoistOn(true);
          setTodoistHere(true);
        }
        if (r.todoist === "kept") after.push("The Todoist token saved here was kept.");
      } else if (inc.secrets) {
        await api.forgetBackup();
      }
      const b = inc.backup;
      if (parts.includes("settings")) {
        for (const [key, value] of Object.entries(settingsFrom(b, accounts))) setSetting(key as keyof Settings, value as never);
        said.unshift("your settings");
      }
      const account = (email: string | null) => accounts.find((a) => a.email.toLowerCase() === email?.toLowerCase());
      const missing = new Set<string>();
      if (parts.includes("snippets")) {
        // A shortcut already here keeps what it has.
        const have = await api.snippets();
        let n = 0;
        for (const s of b.snippets) {
          if (have.some((h) => h.shortcut.toLowerCase() === s.shortcut.toLowerCase())) continue;
          await api.saveSnippet({ ...s, id: 0, accountId: account(s.account)?.id ?? null, used: 0, lastUsed: null });
          n++;
        }
        said.push(plural(n, "new snippet"));
      }
      if (parts.includes("signatures")) {
        // Only for accounts in Tern here, and not twice.
        const kept = await api.signatures();
        let n = 0;
        for (const s of b.signatures) {
          const a = account(s.account);
          if (!a) {
            missing.add(s.account);
            continue;
          }
          if (kept.some((k) => k.accountId === a.id && k.name === s.name && k.body === s.body)) continue;
          const id = await api.saveSignature({ id: 0, accountId: a.id, name: s.name, body: s.body, html: s.html, custom: s.custom, forNew: false, forReply: false });
          if (s.forNew) await api.setSignatureDefault(a.id, false, id);
          if (s.forReply) await api.setSignatureDefault(a.id, true, id);
          n++;
        }
        said.push(plural(n, "new signature"));
      }
      const data = dataFrom(b, parts);
      if (data.senders || data.notes || data.styles) {
        const r = await api.restoreData(data);
        if (data.senders) said.push(plural(r.senders, "new sender choice"));
        if (data.notes) said.push(plural(r.notes, "new note"));
        if (data.styles) said.push(plural(r.styles, "new style note", "new style notes"));
        for (const m of r.missing) missing.add(m);
      }
      setIncoming(null);
      if (missing.size) after.push(`What belongs to ${list([...missing])} was left out: add the account first, then import again.`);
      return [said.length ? `Imported ${list(said)}.` : "", ...after].filter(Boolean).join(" ");
    });

  /** The secrets a file holds, and which of them this computer has already (they keep what they have). */
  const held = (items: { name: string; here: boolean }[], kept: (names: string[]) => string) => {
    const here = items.filter((h) => h.here).map((h) => h.name);
    return `${list(items.map((h) => h.name))}${here.length ? `. ${kept(here)}` : ""}`;
  };
  const accountsKept = (names: string[]) => `${list(names)} ${names.length === 1 ? "is here already and keeps its" : "are here already and keep their"} password`;
  const keysKept = (names: string[]) => `The ${list(names)} ${names.length === 1 ? "key" : "keys"} saved here ${names.length === 1 ? "is" : "are"} kept`;

  return (
    <>
      <Preview label="What goes in the file">
        <div class="backup-chips">
          <For each={out().filter((p) => counts()[p] !== 0)}>{(p) => <Chip tone="ok">{counts()[p] != null ? PART[p].chip(counts()[p] ?? 0) : PART[p].title}</Chip>}</For>
          <Show when={outSecrets().accounts}>
            <Chip tone="warn">{plural(props.accounts.length, "account")} with passwords</Chip>
          </Show>
          <Show when={outSecrets().aiKeys}>
            <Chip tone="warn">AI keys</Chip>
          </Show>
          <Show when={outSecrets().todoist}>
            <Chip tone="warn">Todoist token</Chip>
          </Show>
          <Show when={!sealing()}>
            <Chip>Passwords and keys stay here</Chip>
          </Show>
        </div>
      </Preview>
      <Group title="Export" note="pick what goes in">
        <For each={PARTS}>
          {(p) => (
            <Row title={PART[p].title} help={p === "settings" ? PART.settings.help(1) : counts()[p] != null ? PART[p].help(counts()[p] ?? 0) : undefined}>
              <Switch label={`Export ${PART[p].title.toLowerCase()}`} on={out().includes(p)} onChange={(on) => pick(p, on)} />
            </Row>
          )}
        </For>
      </Group>
      <Group title="Passwords and keys" note="only when you turn them on">
        <Row title="Accounts and passwords" help={`${plural(props.accounts.length, "account")}: server details, aliases, and the password or Google sign-in`}>
          <Switch
            label="Export accounts and passwords"
            on={outSecrets().accounts}
            disabled={!props.accounts.length}
            onChange={(on) => setOutSecrets({ ...outSecrets(), accounts: on })}
          />
        </Row>
        <Row title="AI keys" help={keysHere().length ? `${list(keysHere())}` : "None saved here"}>
          <Switch label="Export AI keys" on={outSecrets().aiKeys} disabled={!keysHere().length} onChange={(on) => setOutSecrets({ ...outSecrets(), aiKeys: on })} />
        </Row>
        <Row title="Todoist token" help={todoistHere() ? "The API token Settings → Todoist connected with" : "Todoist isn't connected"}>
          <Switch label="Export the Todoist token" on={outSecrets().todoist} disabled={!todoistHere()} onChange={(on) => setOutSecrets({ ...outSecrets(), todoist: on })} />
        </Row>
        <Show when={sealing()}>
          <div class="setting sub backup-warning" role="note">
            <span class="title">This file will hold secrets</span>
            <span class="help">
              Anyone with the file and its passphrase can read your mail and use your keys. Keep it somewhere private and don't send it by mail. Without the passphrase
              the file can't be opened, and Tern can't get it back for you.
            </span>
          </div>
          <Row title="Passphrase" class="sub">
            <span class="ai-key backup-passphrase">
              <input type="password" aria-label="Passphrase" placeholder="Passphrase" value={passphrase()} onInput={(e) => setPassphrase(e.currentTarget.value)} />
              <input
                type="password"
                aria-label="Passphrase again"
                placeholder="Again"
                value={again()}
                onInput={(e) => setAgain(e.currentTarget.value)}
                onKeyDown={(e) => e.key === "Enter" && void exportNow()}
              />
            </span>
          </Row>
        </Show>
      </Group>
      <Group title="Save">
        <Row title="Save a backup" help={sealing() ? "One file with what you picked, locked with your passphrase." : "One file with what you picked."}>
          <button class="primary" onClick={() => void exportNow()} disabled={busy() || (!out().length && !sealing())}>
            Export…
          </button>
        </Row>
      </Group>
      <Group title="Import">
        <Row title="Open a backup" help="You pick what to take from it next. What you have here is kept: a snippet shortcut, a sender choice, a note, a key.">
          <button onClick={() => void importNow()} disabled={busy()}>
            Import…
          </button>
        </Row>
        <Show when={locked()}>
          <Row title="The file's passphrase" class="sub" help="This file holds passwords or keys. Nothing is taken until you pick.">
            <span class="ai-key backup-passphrase">
              <input
                type="password"
                aria-label="The file's passphrase"
                placeholder="Passphrase"
                value={unlockWith()}
                onInput={(e) => setUnlockWith(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && unlockWith()) void unlock();
                  else if (e.key === "Escape") (e.stopPropagation(), cancelImport());
                }}
                ref={(el) => queueMicrotask(() => el.focus())}
              />
              <button onClick={cancelImport}>Cancel</button>
              <button class="primary" disabled={!unlockWith() || busy()} onClick={() => void unlock()}>
                {busy() ? "Opening…" : "Open"}
              </button>
            </span>
          </Row>
        </Show>
      </Group>
      <Show when={incoming()}>
        {(inc) => (
          <Group title="In this file" note={`saved ${new Date(inc().backup.exported).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}`}>
            <For each={offered(inc().backup)}>
              {(p) => (
                <Row title={PART[p].title} help={PART[p].help(countOf(inc().backup, p))}>
                  <Switch label={`Import ${PART[p].title.toLowerCase()}`} on={inParts().includes(p)} onChange={(on) => inPick(p, on)} />
                </Row>
              )}
            </For>
            <Show when={inc().secrets}>
              {(s) => (
                <>
                  <Show when={s().accounts.length}>
                    <Row title="Accounts and passwords" help={held(s().accounts, accountsKept)}>
                      <Switch label="Import accounts and passwords" on={inSecrets().accounts} onChange={(on) => setInSecrets({ ...inSecrets(), accounts: on })} />
                    </Row>
                  </Show>
                  <Show when={s().aiKeys.length}>
                    <Row title="AI keys" help={held(s().aiKeys, keysKept)}>
                      <Switch label="Import AI keys" on={inSecrets().aiKeys} onChange={(on) => setInSecrets({ ...inSecrets(), aiKeys: on })} />
                    </Row>
                  </Show>
                  <Show when={s().todoist}>
                    {(t) => (
                      <Row title="Todoist token" help={t().here ? "The token saved here is kept" : "Connects Todoist here"}>
                        <Switch label="Import the Todoist token" on={inSecrets().todoist} onChange={(on) => setInSecrets({ ...inSecrets(), todoist: on })} />
                      </Row>
                    )}
                  </Show>
                </>
              )}
            </Show>
            <div class="setting backup-take">
              <button onClick={cancelImport}>Cancel</button>
              <button class="primary" disabled={busy() || (!inParts().length && !anySecret(inc().secrets ? inSecrets() : NONE))} onClick={() => void take()}>
                {busy() ? "Importing…" : "Import picked"}
              </button>
            </div>
          </Group>
        )}
      </Show>
      <Show when={note()}>
        <p class="setting-note">{note()}</p>
      </Show>
      <Show when={error()}>
        <p class="setting-error">{error()}</p>
      </Show>
    </>
  );
}
