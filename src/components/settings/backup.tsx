// Settings → Backup: everything set up in Tern as one file, to move to another computer or keep a copy.

import { createSignal, Show } from "solid-js";
import { api, type Account } from "../../api";
import { makeBackup, readBackup, settingsFrom } from "../../backup";
import { setSetting, settings, type Settings } from "../../settings";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function BackupSettings(props: { accounts: Account[]; onAccountsChanged: () => void }) {
  const [note, setNote] = createSignal("");
  const [error, setError] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [withAccounts, setWithAccounts] = createSignal(false);
  const [passphrase, setPassphrase] = createSignal("");
  const [again, setAgain] = createSignal("");
  // A sealed file was picked; it waits in the engine for its passphrase.
  const [locked, setLocked] = createSignal(false);
  const [unlockWith, setUnlockWith] = createSignal("");
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

  const exportNow = () =>
    run(async () => {
      if (withAccounts() && passphrase().length < 8) throw new Error("Choose a passphrase of at least 8 characters.");
      if (withAccounts() && passphrase() !== again()) throw new Error("The two passphrases differ.");
      const [snippets, signatures] = await Promise.all([api.snippets(), api.signatures()]);
      const backup = makeBackup({ ...settings }, props.accounts, snippets, signatures);
      const saved = await api.exportSettings(JSON.stringify(backup, null, 2), withAccounts() ? passphrase() : null);
      if (!saved) return null;
      const what = `your settings, ${plural(backup.snippets.length, "snippet")} and ${plural(backup.signatures.length, "signature")}`;
      if (!withAccounts()) return `Exported ${what}.`;
      setPassphrase("");
      setAgain("");
      return `Exported ${what}, with ${plural(props.accounts.length, "account")} and their passwords, locked with your passphrase.`;
    });

  /** Takes a backup's settings, snippets and signatures; `accounts` are the ones here now. */
  const apply = async (text: string, accounts: Account[]) => {
    const backup = readBackup(text);
    for (const [key, value] of Object.entries(settingsFrom(backup, accounts))) setSetting(key as keyof Settings, value as never);
    const account = (email: string | null) => accounts.find((a) => a.email.toLowerCase() === email?.toLowerCase());
    // Snippets: a shortcut already here keeps what it has.
    const have = await api.snippets();
    let snippets = 0;
    for (const s of backup.snippets) {
      if (have.some((h) => h.shortcut.toLowerCase() === s.shortcut.toLowerCase())) continue;
      await api.saveSnippet({ ...s, id: 0, accountId: account(s.account)?.id ?? null, used: 0, lastUsed: null });
      snippets++;
    }
    // Signatures: only for accounts in Tern here, and not twice.
    const kept = await api.signatures();
    const missing = new Set<string>();
    let signatures = 0;
    for (const s of backup.signatures) {
      const a = account(s.account);
      if (!a) {
        missing.add(s.account);
        continue;
      }
      if (kept.some((k) => k.accountId === a.id && k.name === s.name && k.body === s.body)) continue;
      const id = await api.saveSignature({ id: 0, accountId: a.id, name: s.name, body: s.body, html: s.html, custom: s.custom, forNew: false, forReply: false });
      if (s.forNew) await api.setSignatureDefault(a.id, false, id);
      if (s.forReply) await api.setSignatureDefault(a.id, true, id);
      signatures++;
    }
    const left = missing.size ? ` Signatures for ${[...missing].join(", ")} were left out: add the account first, then import again.` : "";
    return `Imported your settings, ${plural(snippets, "new snippet")} and ${plural(signatures, "new signature")}.${left}`;
  };

  const importNow = () =>
    run(async () => {
      setLocked(false);
      const picked = await api.importSettings();
      if (!picked) return null;
      if (picked.locked) {
        setLocked(true);
        return null;
      }
      return apply(picked.text ?? "", props.accounts);
    });

  const unlock = () =>
    run(async () => {
      const opened = await api.unlockSettings(unlockWith());
      setLocked(false);
      setUnlockWith("");
      // Accounts first, so the signatures and colours for them find them.
      if (opened.added.length) props.onAccountsChanged();
      const said = await apply(opened.text, opened.added.length ? await api.accounts() : props.accounts);
      const added = opened.added.length ? ` Added ${opened.added.join(", ")}; their mail starts downloading now.` : "";
      const present = opened.present.length ? ` ${opened.present.join(", ")} ${opened.present.length === 1 ? "was" : "were"} here already and kept ${opened.present.length === 1 ? "its" : "their"} password.` : "";
      return `${said}${added}${present}`;
    });

  return (
    <>
      <div class="setting">
        <span class="title">Export</span>
        <span class="value-action">
          <button onClick={() => void exportNow()} disabled={busy()}>
            Export settings…
          </button>
        </span>
        <label class="backup-accounts">
          <input type="checkbox" checked={withAccounts()} onChange={(e) => setWithAccounts(e.currentTarget.checked)} />
          Include accounts and their passwords, locked with a passphrase
        </label>
        <Show when={withAccounts()}>
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
        </Show>
        <span class="help">
          <Show
            when={withAccounts()}
            fallback="Saves your settings, snippets, signatures, saved searches and account colours as one file. Passwords and AI keys stay in your system's keyring and are not in it."
          >
            The file also holds every account's server details and password (or Google sign-in), sealed with the
            passphrase: at least 8 characters. Without it the file can't be opened, and Tern can't get it back for
            you. AI keys are never in it.
          </Show>
        </span>
      </div>
      <div class="setting">
        <span class="title">Import</span>
        <span class="value-action">
          <button onClick={() => void importNow()} disabled={busy()}>
            Import settings…
          </button>
        </span>
        <Show when={locked()}>
          <span class="ai-key backup-passphrase">
            <input
              type="password"
              aria-label="The file's passphrase"
              placeholder="The file's passphrase"
              value={unlockWith()}
              onInput={(e) => setUnlockWith(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && unlockWith()) void unlock();
                else if (e.key === "Escape") (e.stopPropagation(), setLocked(false));
              }}
              ref={(el) => queueMicrotask(() => el.focus())}
            />
            <button onClick={() => (setLocked(false), setUnlockWith(""))}>Cancel</button>
            <button class="primary" disabled={!unlockWith() || busy()} onClick={() => void unlock()}>
              {busy() ? "Opening…" : "Open"}
            </button>
          </span>
        </Show>
        <span class="help">
          Takes the settings from such a file. Snippets and signatures are added to yours; a snippet whose shortcut you
          already use keeps yours. Signatures go to the accounts with the same address here. A file with accounts asks
          for its passphrase and adds the accounts that aren't here yet.
        </span>
      </div>
      <Show when={note()}>
        <p class="setting-note">{note()}</p>
      </Show>
      <Show when={error()}>
        <p class="setting-error">{error()}</p>
      </Show>
    </>
  );
}
