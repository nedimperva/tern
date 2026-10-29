// What a reworked version changed, word by word, so the person sees the change they are about to keep (Write with
// AI's tone asks). A plain longest-common-subsequence over words. Unit-tested in
// src/test/wordDiff.test.ts.

export type Piece = { text: string; kind: "same" | "added" | "removed" };

/** Past this many word pairs the table would be too big to be quick: the new text is shown as it is. */
const LIMIT = 4_000_000;

export function wordDiff(before: string, after: string): Piece[] | null {
  // Each word with the space after it, so a run of changed words stays one change.
  const a = before.match(/\s+|\S+\s*/g) ?? [];
  const b = after.match(/\s+|\S+\s*/g) ?? [];
  if (a.length * b.length > LIMIT) return null;
  // lcs[i][j]: the longest common run of a[i..] and b[j..].
  const lcs = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const out: Piece[] = [];
  const push = (text: string, kind: Piece["kind"]) => {
    const last = out[out.length - 1];
    if (last?.kind === kind) last.text += text;
    else out.push({ text, kind });
  };
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) push(a[i++], (j++, "same"));
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) push(a[i++], "removed");
    else push(b[j++], "added");
  }
  while (i < a.length) push(a[i++], "removed");
  while (j < b.length) push(b[j++], "added");
  return out;
}
