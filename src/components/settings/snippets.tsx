// Settings → Snippets.

import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show, untrack } from "solid-js";
import { api, type Account, type Snippet } from "../../api";
import { fillSnippet, PLACES } from "../../snippets";
import { Icon } from "../Icon";
import { accountName, Group, lastDay, MailPreview, Preview, Row } from "./shared";
import { Dropdown } from "../Dropdown";

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

  // In the settings grammar (canvas 66): the list as one card of rows with a find box, then the picked snippet as it
  // goes out, then its fields as groups of rows.
  return (
    <div class="snippets-settings">
      <Show when={error()}>
        <p class="setting-error">{error()}</p>
      </Show>
      <Group
        title="Your snippets"
        note={list().length ? `${list().length}` : undefined}
        end={
          <button type="button" class="link" onClick={() => add()}>
            <Icon name="plus" size={13} /> New snippet
          </button>
        }
      >
        <Show
          when={list().length}
          fallback={
            <div class="settings-empty-row">
              <span class="mark">
                <Icon name="file-text" size={18} />
              </span>
              <span>
                <strong>No snippets yet</strong>
                <span>Save the replies you write again and again, then type ; in a message to use one.</span>
              </span>
              <button type="button" class="primary" onClick={() => add()}>
                New snippet
              </button>
            </div>
          }
        >
          <div class="list-head">
            <input
              type="search"
              class="find"
              placeholder="Find a snippet"
              aria-label="Find a snippet"
              value={query()}
              onInput={(e) => setQuery(e.currentTarget.value)}
            />
            <fieldset class="list-filters" aria-label="Show">
              <button type="button" aria-pressed={filter() === "all"} onClick={() => setFilter("all")}>
                All
              </button>
              <Show when={props.accounts.length > 1}>
                <For each={props.accounts}>
                  {(a) => (
                    <button type="button" aria-pressed={filter() === a.id} onClick={() => setFilter(a.id)}>
                      {accountName(a)}
                    </button>
                  )}
                </For>
              </Show>
              <button type="button" aria-pressed={filter() === "used"} onClick={() => setFilter("used")}>
                Most used
              </button>
            </fieldset>
          </div>
          <div class="pick-list">
            <For each={shown()} fallback={<p class="list-none">Nothing matches.</p>}>
              {(s) => (
                <button
                  type="button"
                  class="list-row pick-row"
                  classList={{ picked: s.key === picked() }}
                  aria-current={s.key === picked()}
                  onClick={() => setPicked(s.key)}
                >
                  <span class="badge-mark square quiet">;</span>
                  <span class="who">
                    <strong>{s.name || "Untitled"}</strong>
                    <span class="sub">{firstLine(s.body)}</span>
                  </span>
                  <span class="end">
                    <span class="snippet-key">;{s.shortcut}</span>
                  </span>
                </button>
              )}
            </For>
          </div>
        </Show>
      </Group>

      <Show when={current()}>
        {(s) => (
          <div class="snippet-editor">
            <Preview label="As it goes out">
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
            </Preview>
            <Group title={s().name || "Untitled"} note={s().shortcut ? `;${s().shortcut}` : undefined}>
              <label class="setting">
                <span class="title">Name</span>
                <input value={s().name} onInput={(e) => edit({ name: e.currentTarget.value })} />
              </label>
              <Row
                title="Shortcut"
                help={
                  <Show when={shortcutNote(s())}>
                    {(note) => (
                      <span class="note" classList={{ ok: note().ok, bad: !note().ok && !!s().shortcut.trim() }}>
                        {note().text}
                      </span>
                    )}
                  </Show>
                }
              >
                <span class="prefixed snippet-key" classList={{ invalid: !shortcutNote(s())?.ok }}>
                  <span aria-hidden="true">;</span>
                  <input aria-label="Shortcut" value={s().shortcut} aria-invalid={!shortcutNote(s())?.ok} onInput={(e) => edit({ shortcut: e.currentTarget.value })} />
                </span>
              </Row>
              <div class="setting-block">
                <span class="field-head">
                  <span class="title" id="snippet-text">
                    Text
                  </span>
                  <span class="help">Click a field to put it where the cursor is</span>
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
              <Show when={props.accounts.length > 1}>
                <Row title="Available in" help="Keep a snippet to the account it is written for.">
                  <Dropdown
                    label="Available in"
                    value={String(s().accountId ?? "")}
                    choices={[{ value: "", label: "All accounts" }, ...props.accounts.map((a) => ({ value: String(a.id), label: `${accountName(a)} only` }))]}
                    onChange={(v) => edit({ accountId: v ? Number(v) : null })}
                  />
                </Row>
              </Show>
              <Row title="Also fill in" help="A snippet can set the subject or add people, too.">
                <Dropdown
                  label="Also fill in"
                  value={String(extras())}
                  choices={[
                    { value: "0", label: "Text only" },
                    { value: "1", label: "Text and subject" },
                    { value: "2", label: "Text, subject and Cc" },
                  ]}
                  onChange={(v) => {
                    const n = Number(v) as 0 | 1 | 2;
                    setExtras(n);
                    if (n === 0) edit({ subject: null, cc: [] });
                    else if (n === 1) edit({ cc: [] });
                  }}
                />
              </Row>
              <Show when={extras() > 0}>
                <label class="setting sub">
                  <span class="title">Subject</span>
                  <input value={s().subject ?? ""} placeholder="Used when the subject is empty" onInput={(e) => edit({ subject: e.currentTarget.value })} />
                </label>
              </Show>
              <Show when={extras() > 1}>
                <label class="setting sub">
                  <span class="title">Cc</span>
                  <input
                    value={s().cc.join(", ")}
                    placeholder="sales@example.com, …"
                    onChange={(e) => edit({ cc: e.currentTarget.value.split(/[,;\s]+/).filter(Boolean) })}
                  />
                </label>
              </Show>
              <div class="list-foot">
                <span>
                  {s().id === 0
                    ? "Not saved until it has a shortcut"
                    : s().used
                      ? `Saved · used ${s().used === 1 ? "once" : `${s().used} times`}${s().lastUsed ? `, last ${lastDay(s().lastUsed!)}` : ""}`
                      : "Saved · not used yet"}
                </span>
                <span class="style-foot-actions">
                  <button type="button" class="link" onClick={() => duplicate(s())} disabled={!s().shortcut.trim()}>
                    Duplicate
                  </button>
                  <button type="button" class="link danger" onClick={() => remove(s().key)}>
                    Delete
                  </button>
                </span>
              </div>
            </Group>
          </div>
        )}
      </Show>
    </div>
  );
}

/** Whether editor HTML has any formatting; plain text without it goes as plain text. */
export const formatted = (html: string) => /<(strong|em|u|s|a|code|ul|ol|blockquote)\b/i.test(html);

/** Signatures: several per account, one for new mail and one for replies, and where they go in a reply. */
/** HTML signatures set aside by a switch to "Write it here", by id: switching back brings them back. */
export const keptHtml = new Map<number, string>();
