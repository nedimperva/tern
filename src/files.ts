// The files a message carries, as the person sees them: a picture its own HTML shows (`cid:image002.jpg@…`, the
// logo and icons in a signature) is part of the message, not a file. The engine leaves those out of new mail
// (`mime::attachments`); this does the same for mail stored before it did. Each file keeps its index in
// `attachments`, which is how it is opened and saved.

type WithFiles = { attachments: { name: string; mime: string; size: number }[]; bodyHtml: string | null };

export function filesOf<M extends WithFiles>(m: M) {
  const html = m.bodyHtml?.toLowerCase() ?? "";
  return m.attachments
    .map((file, index) => ({ file, index }))
    .filter(({ file }) => !(file.mime.startsWith("image/") && file.name && html.includes(`cid:${file.name.toLowerCase()}`)));
}

/** What kind of file a name is, for its badge's label and colour. */
export function kind(name: string, mime: string): { label: string; tone: string } {
  const ext = /\.([a-z0-9]{1,5})$/i.exec(name)?.[1]?.toLowerCase() ?? "";
  const tone =
    ext === "pdf" ? "pdf"
    : /^(docx?|odt|rtf|pages)$/.test(ext) ? "doc"
    : /^(xlsx?|ods|csv|numbers)$/.test(ext) ? "sheet"
    : /^(pptx?|odp|key)$/.test(ext) ? "slides"
    : /^(zip|rar|7z|gz|tar)$/.test(ext) ? "archive"
    : mime.startsWith("image/") ? "image"
    : "other";
  return { label: (ext || "file").slice(0, 4).toUpperCase(), tone };
}

/** A long name cut in the middle: the end of a name ("final v2.pdf") is what tells two versions apart, so it stays
 * (idea 72). */
export function middleCut(name: string, max = 44): string {
  if (name.length <= max) return name;
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 && name.length - dot <= 6 ? name.slice(dot) : "";
  const stem = name.slice(0, name.length - ext.length);
  const tail = Math.min(10, Math.floor((max - ext.length) / 3));
  const head = max - ext.length - tail - 1;
  return `${stem.slice(0, head).trimEnd()}…${stem.slice(stem.length - tail).trimStart()}${ext}`;
}
