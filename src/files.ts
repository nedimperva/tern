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
