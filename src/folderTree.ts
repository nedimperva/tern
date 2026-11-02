import type { Folder } from "./api";

/** A folder or label in the sidebar's tree: its own folder when the server lists one at that path (a parent like
 * "Projects" may exist only as a prefix), and what nests under it. */
export type TreeNode = { path: string; name: string; folder: Folder | null; children: TreeNode[] };

/** The separator an account's names use: "/" (Gmail, Stalwart, most servers), else "." when the server writes
 * folders under the inbox ("INBOX.Projects", Dovecot's default). */
export function separatorOf(names: string[]): string {
  if (names.some((n) => n.includes("/"))) return "/";
  return names.some((n) => /^INBOX\./i.test(n)) ? "." : "/";
}

/** Folders as a tree by their names, sorted by name; an "INBOX." prefix is left out, so they sit at the top. */
export function folderTree(folders: Folder[]): TreeNode[] {
  const sep = separatorOf(folders.map((f) => f.name));
  const root: TreeNode = { path: "", name: "", folder: null, children: [] };
  for (const f of folders) {
    const name = sep === "." ? f.name.replace(/^INBOX\./i, "") : f.name;
    let at = root;
    let path = "";
    for (const part of name.split(sep).filter(Boolean)) {
      path = path ? `${path}${sep}${part}` : part;
      let next = at.children.find((c) => c.path === path);
      if (!next) at.children.push((next = { path, name: part, folder: null, children: [] }));
      at = next;
    }
    if (at !== root) at.folder = f;
  }
  const sort = (n: TreeNode) => {
    n.children.sort((a, b) => a.name.localeCompare(b.name));
    n.children.forEach(sort);
  };
  sort(root);
  return root.children;
}

/** Unread under a node, itself included: what a folded parent shows, so nothing goes missing. */
export const unreadUnder = (n: TreeNode): number => (n.folder?.unread ?? 0) + n.children.reduce((s, c) => s + unreadUnder(c), 0);

/** Whether a node or anything under it passes `test` (the one open in the list, to keep its branch open). */
export const holds = (n: TreeNode, test: (f: Folder) => boolean): boolean =>
  (n.folder !== null && test(n.folder)) || n.children.some((c) => holds(c, test));
