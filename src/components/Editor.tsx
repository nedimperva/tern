import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { baseKeymap, setBlockType, toggleMark, wrapIn, lift } from "prosemirror-commands";
import { history, redo, undo } from "prosemirror-history";
import { inputRules, wrappingInputRule, InputRule } from "prosemirror-inputrules";
import { keymap } from "prosemirror-keymap";
import { liftListItem, sinkListItem, splitListItem, wrapInList } from "prosemirror-schema-list";
import { EditorState, TextSelection, type Command } from "prosemirror-state";
import { Slice } from "prosemirror-model";
import { EditorView } from "prosemirror-view";
import { fromHtml, fromText, schema, toHtml, toText } from "../editor/schema";
import type { Snippet } from "../api";

/** Where compose's snippets come from: the saved ones, their text with the places filled in, and a use counted. */
export type SnippetSource = {
  list: () => Snippet[];
  fill: (s: Snippet) => Promise<string>;
  used: (s: Snippet) => void;
};

/** `;` at the start of a word, then the shortcut typed so far. */
const TRIGGER = /(?:^|\s);([\p{L}\p{N}_-]*)$/u;
/** Marks where `{cursor}` was while the filled text goes in; never typed by a person. */
const CARET = "\u2063";

/** Shortcuts starting with what was typed first, then ones whose shortcut or name contains it. */
export function matchSnippets(all: Snippet[], typed: string): Snippet[] {
  const q = typed.toLowerCase();
  const starts = all.filter((s) => s.shortcut.toLowerCase().startsWith(q));
  const contains = all.filter(
    (s) => !starts.includes(s) && (s.shortcut.toLowerCase().includes(q) || s.name.toLowerCase().includes(q)),
  );
  return [...starts, ...contains].slice(0, 8);
}

const { strong, em, underline, strike, code, link } = schema.marks;
const { bullet_list, ordered_list, blockquote, list_item, paragraph } = schema.nodes;

/** Markdown habits: "- " or "* " starts a list, "1. " a numbered one, "> " a quote, `code` marks code. */
const rules = inputRules({
  rules: [
    wrappingInputRule(/^\s*([-*])\s$/, bullet_list),
    wrappingInputRule(/^(\d+)\.\s$/, ordered_list, (m) => ({ order: +m[1] })),
    wrappingInputRule(/^\s*>\s$/, blockquote),
    new InputRule(/`([^`]+)`$/, (state, match, start, end) =>
      state.tr.replaceWith(start, end, schema.text(match[1], [code.create()])),
    ),
  ],
});

/** In a list, the list command; elsewhere wrap. Toggling back out lifts. */
const toggleList =
  (type: typeof bullet_list): Command =>
  (state, dispatch) =>
    wrapInList(type)(state, dispatch) || liftListItem(list_item)(state, dispatch);
const toggleQuote: Command = (state, dispatch) => wrapIn(blockquote)(state, dispatch) || lift(state, dispatch);

/** Compose's body: rich text that writes plain text and HTML (docs/design/ui.md §4.4). */
export function Editor(props: {
  /** Saved HTML if any, else plain text. */
  html?: string | null;
  text: string;
  onChange: (text: string, html: string) => void;
  /** The view, to focus it from outside. */
  ref?: (view: EditorView) => void;
  autofocus?: "start" | false;
  /** Typing `;` offers these; `;shortcut` then Space puts one in at once. */
  snippets?: SnippetSource;
}) {
  let host!: HTMLDivElement;
  let view!: EditorView;
  let linkInput: HTMLInputElement | undefined;
  // The format bar shows over a selection; the link field inside it on Ctrl+K or its button.
  const [bar, setBar] = createSignal<{ left: number; top: number } | null>(null);
  const [linking, setLinking] = createSignal(false);
  const [active, setActive] = createSignal<Record<string, boolean>>({});
  // The quote at the end of a reply starts folded behind "···".
  const [hasQuote, setHasQuote] = createSignal(false);
  const [quoteOpen, setQuoteOpen] = createSignal(false);
  // The snippet picker: where its `;` is, what follows it, and which entry is pointed at.
  const [picker, setPicker] = createSignal<{ from: number; typed: string; left: number; top: number } | null>(null);
  const [pointed, setPointed] = createSignal(0);
  // Esc hides the picker until another `;` is typed.
  let dismissedAt = -1;
  const offered = () => {
    const p = picker();
    return p && props.snippets ? matchSnippets(props.snippets.list(), p.typed) : [];
  };

  const openLink = () => {
    setLinking(true);
    queueMicrotask(() => linkInput?.focus());
    return true;
  };

  const refresh = (state: EditorState) => {
    const sel = state.selection;
    const marks = state.storedMarks ?? sel.$from.marks();
    const has = (t: typeof strong) =>
      sel.empty ? marks.some((m) => m.type === t) : state.doc.rangeHasMark(sel.from, sel.to, t);
    setActive({ strong: has(strong), em: has(em), underline: has(underline), strike: has(strike), link: has(link) });
    if (sel.empty || !view?.hasFocus()) {
      if (!linking()) setBar(null);
    } else {
      const start = view.coordsAtPos(sel.from);
      const box = host.getBoundingClientRect();
      setBar({ left: start.left - box.left, top: start.top - box.top });
    }
    const last = state.doc.lastChild;
    setHasQuote(state.doc.childCount > 1 && last?.type === blockquote);
    findTrigger(state);
  };

  const findTrigger = (state: EditorState) => {
    const sel = state.selection;
    const before = sel.empty ? sel.$from.parent.textBetween(0, sel.$from.parentOffset, undefined, "\ufffc") : "";
    const m = props.snippets && view ? TRIGGER.exec(before) : null;
    const from = m ? sel.from - m[1].length - 1 : -1;
    if (!m) dismissedAt = -1;
    if (!m || from === dismissedAt) return setPicker(null);
    const at = view.coordsAtPos(from);
    const box = host.getBoundingClientRect();
    if (picker()?.typed !== m[1]) setPointed(0);
    setPicker({ from, typed: m[1], left: at.left - box.left, top: at.bottom - box.top + 4 });
  };

  /** Puts the snippet in place of `;typed`, with the caret where its `{cursor}` was or after it. */
  const insert = async (snippet: Snippet) => {
    const p = picker();
    if (!p || !props.snippets) return;
    setPicker(null);
    const text = await props.snippets.fill(snippet);
    props.snippets.used(snippet);
    const marked = text.includes("{cursor}") ? text.replace("{cursor}", CARET) : text + CARET;
    const doc = fromText(marked);
    // Open at both ends, so a one-line snippet joins the line it was typed on.
    const tr = view.state.tr.replaceRange(p.from, view.state.selection.from, new Slice(doc.content, 1, 1));
    let caret = -1;
    tr.doc.descendants((node, pos) => {
      if (caret < 0 && node.isText && node.text!.includes(CARET)) caret = pos + node.text!.indexOf(CARET);
      return caret < 0;
    });
    if (caret >= 0) tr.delete(caret, caret + 1).setSelection(TextSelection.create(tr.doc, caret));
    view.dispatch(tr.scrollIntoView());
    view.focus();
  };

  /** Arrows, Enter and Tab work the open picker; Esc closes it (not compose); Space after a whole shortcut
   * expands it. */
  const pickerKey = (event: KeyboardEvent): boolean => {
    const p = picker();
    const list = offered();
    if (!p) return false;
    const exact = list.find((s) => s.shortcut.toLowerCase() === p.typed.toLowerCase());
    if (event.key === " " && exact) void insert(exact);
    else if (!list.length) return false;
    else if (event.key === "ArrowDown") setPointed((pointed() + 1) % list.length);
    else if (event.key === "ArrowUp") setPointed((pointed() - 1 + list.length) % list.length);
    else if (event.key === "Enter" || event.key === "Tab") void insert(list[pointed()] ?? list[0]);
    else if (event.key === "Escape") ((dismissedAt = p.from), setPicker(null));
    else return false;
    event.preventDefault();
    event.stopPropagation();
    return true;
  };

  onMount(() => {
    const doc = props.html ? fromHtml(props.html) : fromText(props.text);
    view = new EditorView(host, {
      state: EditorState.create({
        doc,
        plugins: [
          history(),
          rules,
          keymap({
            "Mod-z": undo,
            "Mod-Shift-z": redo,
            "Mod-y": redo,
            "Mod-b": toggleMark(strong),
            "Mod-i": toggleMark(em),
            "Mod-u": toggleMark(underline),
            "Mod-Shift-x": toggleMark(strike),
            "Mod-e": toggleMark(code),
            "Mod-k": openLink,
            "Mod-Shift-7": toggleList(ordered_list),
            "Mod-Shift-8": toggleList(bullet_list),
            "Mod-Shift-9": toggleQuote,
            "Mod-]": sinkListItem(list_item),
            "Mod-[": liftListItem(list_item),
            Enter: splitListItem(list_item),
            "Shift-Enter": (state, dispatch) => {
              dispatch?.(state.tr.replaceSelectionWith(schema.nodes.hard_break.create()).scrollIntoView());
              return true;
            },
          }),
          keymap(baseKeymap),
        ],
      }),
      dispatchTransaction(tr) {
        const state = view.state.apply(tr);
        view.updateState(state);
        refresh(state);
        if (tr.docChanged) props.onChange(toText(state.doc), toHtml(state.doc));
      },
      handleKeyDown: (_, event) => pickerKey(event),
      handleDOMEvents: {
        blur: () => (window.setTimeout(() => (!linking() && setBar(null), setPicker(null)), 150), false),
      },
    });
    refresh(view.state);
    props.ref?.(view);
    if (props.autofocus === "start") {
      view.dispatch(view.state.tr.setSelection(TextSelection.atStart(view.state.doc)));
      view.focus();
    }
  });
  onCleanup(() => view?.destroy());

  const run = (command: Command) => {
    command(view.state, view.dispatch);
    view.focus();
  };

  const applyLink = (href: string) => {
    setLinking(false);
    const { from, to, empty } = view.state.selection;
    if (href.trim() && !empty) {
      const url = /^[a-z]+:/i.test(href) ? href.trim() : `https://${href.trim()}`;
      view.dispatch(view.state.tr.addMark(from, to, link.create({ href: url })));
    } else if (!href.trim() && !empty) {
      view.dispatch(view.state.tr.removeMark(from, to, link));
    }
    view.focus();
  };

  const button = (label: string, title: string, on: boolean, command: Command) => (
    <button
      type="button"
      classList={{ on }}
      title={title}
      aria-label={title}
      aria-pressed={on}
      onMouseDown={(e) => (e.preventDefault(), run(command))}
    >
      {label}
    </button>
  );

  return (
    <div class="editor" classList={{ "quote-folded": hasQuote() && !quoteOpen() }}>
      <div ref={host} class="editor-body" />
      <Show when={hasQuote()}>
        <button
          type="button"
          class="fold"
          title={quoteOpen() ? "Hide quoted text" : "Show quoted text"}
          aria-expanded={quoteOpen()}
          onClick={() => setQuoteOpen(!quoteOpen())}
        >
          ···
        </button>
      </Show>
      <Show when={picker() && offered().length ? picker() : null}>
        {(at) => (
          <ul
            class="suggestions snippet-picker"
            role="listbox"
            aria-label="Snippets"
            style={{ left: `${at().left}px`, top: `${at().top}px` }}
          >
            <For each={offered()}>
              {(s, i) => (
                <li
                  role="option"
                  aria-selected={i() === pointed()}
                  classList={{ pointed: i() === pointed() }}
                  onMouseDown={(e) => (e.preventDefault(), void insert(s))}
                >
                  <span class="snippet-key">;{s.shortcut}</span>
                  <span class="name">{s.name}</span>
                  <span class="addr">{s.body.replace(/\{cursor\}/g, "").split("\n").find((l) => l.trim())}</span>
                </li>
              )}
            </For>
          </ul>
        )}
      </Show>
      <Show when={bar()}>
        {(at) => (
          <div class="format-bar" style={{ left: `${at().left}px`, top: `${at().top - 40}px` }} onMouseDown={(e) => e.preventDefault()}>
            <Show
              when={!linking()}
              fallback={
                <input
                  ref={linkInput}
                  class="link-input"
                  placeholder="Paste a link, Enter to apply"
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === "Enter") (e.preventDefault(), applyLink(e.currentTarget.value));
                    if (e.key === "Escape") (e.preventDefault(), setLinking(false), view.focus());
                  }}
                />
              }
            >
              {button("B", "Bold (Ctrl+B)", !!active().strong, toggleMark(strong))}
              {button("I", "Italic (Ctrl+I)", !!active().em, toggleMark(em))}
              {button("U", "Underline (Ctrl+U)", !!active().underline, toggleMark(underline))}
              {button("S", "Strikethrough (Ctrl+Shift+X)", !!active().strike, toggleMark(strike))}
              <button type="button" classList={{ on: !!active().link }} title="Link (Ctrl+K)" aria-label="Link" onMouseDown={(e) => (e.preventDefault(), openLink())}>
                ⌁
              </button>
              {button("•", "Bulleted list (Ctrl+Shift+8)", false, toggleList(bullet_list))}
              {button("1.", "Numbered list (Ctrl+Shift+7)", false, toggleList(ordered_list))}
              {button("❝", "Quote (Ctrl+Shift+9)", false, toggleQuote)}
              {button("¶", "Plain paragraph", false, setBlockType(paragraph))}
            </Show>
          </div>
        )}
      </Show>
    </div>
  );
}
