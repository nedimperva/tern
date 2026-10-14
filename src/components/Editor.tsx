import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { baseKeymap, setBlockType, toggleMark, wrapIn, lift } from "prosemirror-commands";
import { history, redo, undo } from "prosemirror-history";
import { inputRules, wrappingInputRule, InputRule } from "prosemirror-inputrules";
import { keymap } from "prosemirror-keymap";
import { liftListItem, sinkListItem, splitListItem, wrapInList } from "prosemirror-schema-list";
import { EditorState, TextSelection, type Command } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { fromHtml, fromText, schema, toHtml, toText } from "../editor/schema";

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
      handleDOMEvents: { blur: () => (window.setTimeout(() => !linking() && setBar(null), 150), false) },
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
