// Settings → an account: its name, password and removal.

import { createSignal, For, Show } from "solid-js";
import { api, type Account } from "../../api";
import { ACCOUNT_COLOURS, COLOUR_NAMES } from "../../colours";
import { radioKeys } from "../../a11y";
import { setSetting, settings } from "../../settings";

/** One account: its name on sent mail, what else Tern knows of it, and a way to its signatures. */
export function AccountPage(props: { account: Account; onSignatures: () => void; onRenamed: () => void; onRemoved: () => void }) {
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
  // A new password: the field shows on "Change password", and saving checks it with the server first.
  const [changing, setChanging] = createSignal(false);
  const [password, setPassword] = createSignal("");
  const [checking, setChecking] = createSignal(false);
  const [passwordNote, setPasswordNote] = createSignal("");
  const savePassword = async () => {
    setError("");
    setPasswordNote("");
    setChecking(true);
    try {
      await api.setPassword(props.account.id, password());
      setChanging(false);
      setPassword("");
      setPasswordNote("Saved. Tern signs in with it now.");
    } catch (e) {
      setError(String(e));
    } finally {
      setChecking(false);
    }
  };
  const [removing, setRemoving] = createSignal(false);
  const remove = async () => {
    setError("");
    try {
      await api.removeAccount(props.account.id);
      props.onRemoved();
    } catch (e) {
      setError(String(e));
      setRemoving(false);
    }
  };
  // A colour picked for this account, by address so it survives an export to another computer.
  const key = () => props.account.email.toLowerCase();
  const picked = () => settings.accountColours[key()] ?? null;
  const pick = (c: string | null) => {
    const { [key()]: _, ...rest } = settings.accountColours;
    setSetting("accountColours", c ? { ...rest, [key()]: c } : rest);
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
        <span class="title">Colour</span>
        <span class="swatches" role="radiogroup" aria-label="Colour" onKeyDown={radioKeys}>
          <For each={ACCOUNT_COLOURS}>
            {(c, i) => (
              // biome-ignore lint/a11y/useSemanticElements: a swatch is a styled radio; radioKeys gives it the arrow keys of a native one
              <button
                type="button"
                role="radio"
                aria-checked={picked() === c}
                tabIndex={picked() === c || (!picked() && i() === 0) ? 0 : -1}
                aria-label={COLOUR_NAMES[i()]}
                title={COLOUR_NAMES[i()]}
                classList={{ on: picked() === c }}
                style={{ background: c }}
                onClick={() => pick(c)}
              />
            )}
          </For>
          <Show when={picked()}>
            <button type="button" class="link" onClick={() => pick(null)}>
              Default
            </button>
          </Show>
        </span>
        <span class="help">Its dot in mixed lists, its badge in the rail (Ctrl+\) and in the From picker.</span>
      </div>
      <div class="setting">
        <span class="title">Sign-in</span>
        <span class="value-action">
          {props.account.auth === "google" ? "With Google, in the browser" : gmail() ? "App password" : "Password"}
          <Show when={props.account.auth !== "google" && !changing()}>
            <button onClick={() => (setChanging(true), setPasswordNote(""))}>Change password</button>
          </Show>
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
        <Show when={changing()}>
          <span class="ai-key">
            <input
              type="password"
              aria-label={gmail() ? "New app password" : "New password"}
              placeholder={gmail() ? "New app password" : "New password"}
              value={password()}
              onInput={(e) => setPassword(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && password()) void savePassword();
                else if (e.key === "Escape") (e.stopPropagation(), setChanging(false));
              }}
              ref={(el) => queueMicrotask(() => el.focus())}
            />
            <button onClick={() => (setChanging(false), setPassword(""))}>Cancel</button>
            <button class="primary" disabled={!password() || checking()} onClick={() => void savePassword()}>
              {checking() ? "Checking…" : "Save"}
            </button>
          </span>
          <span class="help">For when the password changed and the server refuses the old one. Tern checks it with the server before saving it in the system keyring.</span>
        </Show>
        <Show when={passwordNote()}>
          <span class="help">{passwordNote()}</span>
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
      <div class="setting">
        <span class="title">Remove account</span>
        <span class="value-action">
          <Show
            when={removing()}
            fallback={<button onClick={() => setRemoving(true)}>Remove from Tern…</button>}
          >
            <button class="danger" onClick={() => void remove()}>
              Remove {props.account.email}
            </button>
            <button onClick={() => setRemoving(false)}>Cancel</button>
          </Show>
        </span>
        <span class="help">
          Tern deletes its copy of this account's mail, drafts and changes still waiting to go out, and forgets its
          password. The mail stays on the server.
        </span>
      </div>
    </>
  );
}
