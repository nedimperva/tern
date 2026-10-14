// The compose editor's document (package 03): paragraphs, quotes, lists and line breaks; bold, italic, underline,
// strike, inline code and links. Nothing else, so pasted Word/Docs styling falls away to this.

import { DOMParser, DOMSerializer, Schema, type Node } from "prosemirror-model";
import { schema as basic } from "prosemirror-schema-basic";
import { addListNodes } from "prosemirror-schema-list";

export const schema = new Schema({
  nodes: addListNodes(
    basic.spec.nodes.remove("heading").remove("code_block").remove("horizontal_rule").remove("image"),
    "paragraph block*",
    "block",
  ),
  marks: basic.spec.marks
    .addToEnd("underline", {
      parseDOM: [{ tag: "u" }, { style: "text-decoration=underline" }],
      toDOM: () => ["u", 0],
    })
    .addToEnd("strike", {
      parseDOM: [{ tag: "s" }, { tag: "del" }, { tag: "strike" }, { style: "text-decoration=line-through" }],
      toDOM: () => ["s", 0],
    }),
});

/** Inline styles mail clients need, since they drop <style> blocks. */
const QUOTE_STYLE = "margin:0 0 0 .8ex;border-left:2px solid #ccc;padding-left:1ex;color:#555";

/** The document as mail HTML. */
export function toHtml(doc: Node): string {
  const box = document.createElement("div");
  box.appendChild(DOMSerializer.fromSchema(schema).serializeFragment(doc.content));
  box.querySelectorAll("blockquote").forEach((q) => q.setAttribute("style", QUOTE_STYLE));
  box.querySelectorAll("p").forEach((p) => p.setAttribute("style", "margin:0 0 1em"));
  return box.innerHTML;
}

/** The document as plain text, for the text/plain part: written from the document, not from the HTML. */
export function toText(doc: Node): string {
  const blocks = (node: Node, prefix: string): string[] => {
    const out: string[] = [];
    node.forEach((child, _, index) => {
      if (child.type === schema.nodes.paragraph) {
        let line = "";
        child.forEach((inline) => {
          if (inline.type === schema.nodes.hard_break) line += "\n";
          else {
            const link = inline.marks.find((m) => m.type === schema.marks.link);
            line += inline.text ?? "";
            if (link && link.attrs.href !== inline.text) line += ` <${link.attrs.href}>`;
          }
        });
        out.push(line.split("\n").map((l) => prefix + l).join("\n"));
      } else if (child.type === schema.nodes.blockquote) {
        out.push(blocks(child, `${prefix}> `).join(`\n${prefix}>\n`));
      } else if (child.type === schema.nodes.bullet_list || child.type === schema.nodes.ordered_list) {
        const ordered = child.type === schema.nodes.ordered_list;
        const items: string[] = [];
        child.forEach((item, _, i) => {
          const mark = ordered ? `${i + 1}. ` : "- ";
          const text = blocks(item, " ".repeat(mark.length)).join("\n").slice(mark.length);
          items.push(prefix + mark + text.trimStart());
        });
        out.push(items.join("\n"));
      }
      void index;
    });
    return out;
  };
  return blocks(doc, "").join("\n\n");
}

/** A document from mail HTML (a saved draft). */
export function fromHtml(html: string): Node {
  const box = document.createElement("div");
  box.innerHTML = html;
  return DOMParser.fromSchema(schema).parse(box);
}

/** A document from plain text: blank lines part paragraphs, "> " lines become quotes. */
export function fromText(text: string): Node {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const toHtmlBlocks = (lines: string[]): string => {
    const html: string[] = [];
    let i = 0;
    while (i < lines.length) {
      if (lines[i].startsWith(">")) {
        const quoted: string[] = [];
        while (i < lines.length && lines[i].startsWith(">")) quoted.push(lines[i++].replace(/^> ?/, ""));
        html.push(`<blockquote>${toHtmlBlocks(quoted)}</blockquote>`);
      } else if (!lines[i].trim()) {
        i++;
      } else {
        const para: string[] = [];
        while (i < lines.length && lines[i].trim() && !lines[i].startsWith(">")) para.push(esc(lines[i++]));
        html.push(`<p>${para.join("<br>")}</p>`);
      }
    }
    return html.join("");
  };
  const lines = text.split("\n");
  // Leading blank lines are room to write in: keep one empty paragraph for the cursor.
  const lead = text.startsWith("\n") ? "<p></p>" : "";
  return fromHtml(lead + toHtmlBlocks(lines));
}
