// Settings → Backup: everything set up in Tern as one file, to move to another computer or keep a copy.

import { createSignal, Show } from "solid-js";
import { api, type Account } from "../../api";
import { makeBackup, readBackup, settingsFrom } from "../../backup";
import { setSetting, settings, type Settings } from "../../settings";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function BackupSettings(props: { accounts: Account[] }) {
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

  const exportNow = () =>
    run(async () => {
      const [snippets, signatures] = await Promise.all([api.snippets(), api.signatures()]);
      const backup = makeBackup({ ...settings }, props.accounts, snippets, signatures);
      const saved = await api.exportSettings(JSON.stringify(backup, null, 2));
      return saved ? `Exported your settings, ${plural(backup.snippets.length, "snippet")} and ${plural(backup.signatures.length, "signature")}.` : null;
    });

  const importNow = () =>
    run(async () => {
      const text = await api.importSettings();
      if (text == null) return null;
      const backup = readBackup(text);
      for (const [key, value] of Object.entries(settingsFrom(backup, props.accounts))) setSetting(key as keyof Settings, value as never);
      const account = (email: string | null) => props.accounts.find((a) => a.email.toLowerCase() === email?.toLowerCase());
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
        <span class="help">
          Saves your settings, snippets, signatures, saved searches and account colours as one file. Passwords and AI
          keys stay in your system's keyring and are not in it.
        </span>
      </div>
      <div class="setting">
        <span class="title">Import</span>
        <span class="value-action">
          <button onClick={() => void importNow()} disabled={busy()}>
            Import settings…
          </button>
        </span>
        <span class="help">
          Takes the settings from such a file. Snippets and signatures are added to yours; a snippet whose shortcut you
          already use keeps yours. Signatures go to the accounts with the same address here.
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
