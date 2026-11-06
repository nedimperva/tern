/** The writer's name from a reply's "On Nov 6, 2026, 9:47 PM, Ada Lovelace <ada@x.com> wrote:" line, else its address. */
export function quotedName(line: string): string {
  const m = /,\s*([^,<]+?)\s*<([^>]+)>\s*wrote:\s*$/.exec(line);
  if (m) return m[1].trim().replace(/^"|"$/g, "") || m[2];
  const bare = /,\s*([^,]+?)\s*wrote:\s*$/.exec(line);
  return bare ? bare[1].trim() : "";
}
