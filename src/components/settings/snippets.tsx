// Settings → Snippets.

import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show, untrack } from "solid-js";
import { api, type Account, type Snippet } from "../../api";
import { fillSnippet, PLACES } from "../../snippets";
import { Icon } from "../Icon";
import { accountName, Group, MailPreview, lastDay } from "./shared";

/** Snippets: text typed after `;` in compose. A list on the left, the one picked on the right; changes save as they
 * are typed. */
export function SnippetSettings(props: { accounts: Account[] }) {
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
            <fieldset class="filters plain" aria-label="Show">
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
            </fieldset>
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
                      <span class="caret" role="img" aria-label="The cursor goes here" />
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
export const formatted = (html: string) => /<(strong|em|u|s|a|code|ul|ol|blockquote)\b/i.test(html);

/** Signatures: several per account, one for new mail and one for replies, and where they go in a reply. */
/** HTML signatures set aside by a switch to "Write it here", by id: switching back brings them back. */
export const keptHtml = new Map<number, string>();
