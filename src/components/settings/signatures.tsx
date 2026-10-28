// Settings → Signatures.

import { createEffect, createSignal, For, Index, lazy, onCleanup, onMount, Show, Suspense } from "solid-js";
import { api, type Account, type Signature } from "../../api";
import { colourOf } from "../../colours";
import { setSetting, settings } from "../../settings";
import { Icon } from "../Icon";
import { HtmlFrame } from "../HtmlFrame";
import { htmlText, localPictures, pastedHtml } from "../../htmlSignature";
import { accountName, Group, MailPreview } from "./shared";
import { formatted, keptHtml } from "./snippets";

const Editor = lazy(() => import("../Editor").then((m) => ({ default: m.Editor })));


export function SignatureSettings(props: { accounts: Account[]; account: number | null; onAccount: (id: number) => void }) {
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
    // The setter's own form: reading version() here would make this effect wake itself, forever when the account
    // has no signature yet.
    if (!ids.includes(picked() ?? -1)) (setPicked(ids[0] ?? null), setVersion((v) => v + 1));
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
                    {/* biome-ignore lint/a11y/useSemanticElements: it takes pasted HTML (a logo, a layout), which a textarea can't */}
                    <div
                      class="paste-box"
                      contentEditable
                      tabIndex={0}
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
