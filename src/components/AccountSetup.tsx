import { createSignal, Show } from "solid-js";
import { api, type Account, type AccountConfig, type Security } from "../api";

/** The security each standard port implies, so typing a port also picks the right setting. */
const PORT_SECURITY: Record<number, Security> = { 993: "tls", 143: "starttls", 465: "tls", 587: "starttls" };

export function AccountSetup(props: { onAdded: (a: Account) => void; onClose?: () => void }) {
  const [config, setConfig] = createSignal<AccountConfig>({
    email: "",
    displayName: "",
    username: "",
    imapHost: "",
    imapPort: 993,
    imapSecurity: "tls",
    smtpHost: "",
    smtpPort: 465,
    smtpSecurity: "tls",
  });
  const [password, setPassword] = createSignal("");
  const [note, setNote] = createSignal<string | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [advanced, setAdvanced] = createSignal(false);

  const set = <K extends keyof AccountConfig>(key: K, value: AccountConfig[K]) => {
    const next = { ...config(), [key]: value };
    if (key === "imapPort" && PORT_SECURITY[value as number]) next.imapSecurity = PORT_SECURITY[value as number];
    if (key === "smtpPort" && PORT_SECURITY[value as number]) next.smtpSecurity = PORT_SECURITY[value as number];
    setConfig(next);
  };

  // Fill the servers in from the address, the moment it is typed.
  const onEmail = async (email: string) => {
    const prev = config();
    const username = !prev.username || prev.username === prev.email ? email : prev.username;
    setConfig({ ...prev, email, username });
    const preset = email.includes("@") ? await api.preset(email) : null;
    if (preset) {
      const { note, ...servers } = preset;
      setConfig({ ...config(), ...servers });
      setNote(note);
    }
  };

  const submit = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      props.onAdded(await api.addAccount(config(), password()));
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  const field = (label: string, key: keyof AccountConfig, type = "text") => (
    <label>
      {label}
      <input
        type={type}
        value={String(config()[key])}
        onInput={(e) => set(key, (type === "number" ? Number(e.currentTarget.value) : e.currentTarget.value) as never)}
      />
    </label>
  );

  const security = (label: string, key: "imapSecurity" | "smtpSecurity") => (
    <label>
      {label}
      <select value={config()[key]} onChange={(e) => set(key, e.currentTarget.value as Security)}>
        <option value="tls">TLS</option>
        <option value="starttls">STARTTLS</option>
      </select>
    </label>
  );

  return (
    <div class="overlay">
      <form class="setup" onSubmit={submit}>
        <h2>Add an account</h2>
        <label>
          Email
          <input type="email" autofocus value={config().email} onInput={(e) => onEmail(e.currentTarget.value)} />
        </label>
        {field("Your name", "displayName")}
        <label>
          Password or app password
          <input type="password" value={password()} onInput={(e) => setPassword(e.currentTarget.value)} />
        </label>
        <Show when={note()}>
          <p class="note">{note()}</p>
        </Show>
        <button type="button" class="link" onClick={() => setAdvanced(!advanced())}>
          {advanced() ? "Hide" : "Show"} server settings
        </button>
        <Show when={advanced()}>
          <div class="grid">
            {field("Username", "username")}
            {field("IMAP server", "imapHost")}
            {field("IMAP port", "imapPort", "number")}
            {security("IMAP security", "imapSecurity")}
            {field("SMTP server", "smtpHost")}
            {field("SMTP port", "smtpPort", "number")}
            {security("SMTP security", "smtpSecurity")}
          </div>
          <p class="note">TLS is usually port 993 for IMAP and 465 for SMTP; STARTTLS is 143 and 587.</p>
        </Show>
        <Show when={error()}>
          <p class="error">{error()}</p>
        </Show>
        <footer>
          <button type="submit" class="primary" disabled={busy() || !config().email || !password()}>
            {busy() ? "Signing in…" : "Add account"}
          </button>
          <Show when={props.onClose}>
            <button type="button" onClick={props.onClose}>
              Cancel
            </button>
          </Show>
        </footer>
      </form>
    </div>
  );
}
