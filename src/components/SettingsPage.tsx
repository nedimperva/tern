import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show, untrack, type JSX } from "solid-js";
import type { Account } from "../api";
import { colourOf } from "../colours";
import { Icon, type IconName } from "./Icon";
import { accountName } from "./settings/shared";
import { AppearanceSettings, ReadingSettings, ComposeSettings, AboutSettings, NotificationSettings, DesktopSettings } from "./settings/general";
import { AiSettingsPage, AiStylePage } from "./settings/ai";
import { SnippetSettings } from "./settings/snippets";
import { SignatureSettings } from "./settings/signatures";
import { AccountPage } from "./settings/account";
import { BackupSettings } from "./settings/backup";

type Section = {
  /** Unique: a section name, or "account:<id>". */
  id: string;
  name: string;
  group: "General" | "Writing" | "Accounts";
  /** What search finds it by, besides its name. */
  words: string;
  body: () => JSX.Element;
  /** Drawn before the name; an account has its colour's dot instead. */
  icon?: IconName;
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
      icon: "palette",
      group: "General",
      words: "theme dark light density rows sidebar inbox zero empty tern scene",
      body: () => <AppearanceSettings />,
    },
    {
      id: "Reading",
      name: "Reading",
      icon: "book-open",
      group: "General",
      words: "open conversations mark read inbox split important other images logos designed dark start day morning",
      body: () => <ReadingSettings />,
    },
    { id: "Notifications", name: "Notifications",
      icon: "bell", group: "General", words: "notify new mail quiet hours", body: () => <NotificationSettings /> },
    { id: "Desktop", name: "Desktop",
      icon: "monitor", group: "General", words: "background tray close login start email links mailto default", body: () => <DesktopSettings /> },
    {
      id: "AI",
      name: "AI",
      icon: "sparkles",
      group: "General",
      words: "ai claude anthropic openai gpt gemini google api key summary summarize replies suggest write rewrite style voice model privacy",
      body: () => <AiSettingsPage accounts={props.accounts} onStyles={() => setSection("Writing style")} />,
    },
    {
      id: "Backup",
      name: "Backup",
      icon: "archive",
      group: "General",
      words: "export import move another computer copy file json settings snippets signatures accounts passwords passphrase encrypted",
      body: () => <BackupSettings accounts={props.accounts} onAccountsChanged={props.onAccountsChanged} />,
    },
    { id: "About", name: "About",
      icon: "info", group: "General", words: "version log bug report problem help beta downloaded attachments cache disk space clear", body: () => <AboutSettings /> },
    { id: "Compose", name: "Compose",
      icon: "send", group: "Writing", words: "undo send delay attachment forgotten attached prilog anhang", body: () => <ComposeSettings /> },
    { id: "Snippets", name: "Snippets",
      icon: "file-text", group: "Writing", words: "saved replies templates shortcut text", body: () => <SnippetSettings accounts={props.accounts} /> },
    {
      id: "Signatures",
      name: "Signatures",
      icon: "pen-line",
      group: "Writing",
      words: "signature replies quoted below above",
      body: () => <SignatureSettings accounts={props.accounts} account={signatureAccount()} onAccount={setSignatureAccount} />,
    },
    {
      id: "Writing style",
      name: "Writing style",
      icon: "feather",
      group: "Writing",
      words: "ai style voice learn sent tone length greetings sign-offs habits",
      body: () => <AiStylePage accounts={props.accounts} onAi={() => setSection("AI")} />,
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
            onRemoved={() => (setSection("Appearance"), props.onAccountsChanged())}
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
                  <button type="button" classList={{ active: s.id === section() }} aria-current={s.id === section() ? "page" : undefined} onClick={() => setSection(s.id)}>
                    <span class="slot">
                      <Show when={s.icon} fallback={<span class="dot" style={{ background: s.dot }} />}>
                        {(name) => <Icon name={name()} size={15} />}
                      </Show>
                    </span>
                    <span class="name">{s.name}</span>
                  </button>
                )}
              </For>
            </Show>
          )}
        </For>
        <Show when={!found().length}>
          <p class="nav-none">No setting matches.</p>
        </Show>
        <button type="button" class="close" onClick={props.onClose}>
          <span class="slot">
            <Icon name="x" size={15} />
          </span>
          <span class="name">Close settings</span>
          <kbd>Esc</kbd>
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
