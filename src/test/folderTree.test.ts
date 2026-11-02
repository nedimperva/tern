import { describe, expect, it } from "vitest";
import type { Folder } from "../api";
import { folderTree, holds, separatorOf, unreadUnder } from "../folderTree";

let id = 0;
const f = (name: string, unread = 0): Folder => ({ id: ++id, accountId: 1, name, role: "label", unread });

describe("folder tree", () => {
  it("nests by slash and keeps a parent that is only a prefix", () => {
    const tree = folderTree([f("Projects/Beta", 3), f("Projects/Alpha", 14), f("Personal"), f("Archive")]);
    expect(tree.map((n) => n.name)).toEqual(["Archive", "Personal", "Projects"]);
    const projects = tree[2];
    expect(projects.folder).toBeNull();
    expect(projects.children.map((n) => n.name)).toEqual(["Alpha", "Beta"]);
    expect(unreadUnder(projects)).toBe(17);
  });

  it("uses dots for folders under INBOX., and leaves that prefix out", () => {
    expect(separatorOf(["INBOX", "INBOX.Clients", "INBOX.Clients.Acme"])).toBe(".");
    const tree = folderTree([f("INBOX.Clients"), f("INBOX.Clients.Acme", 2)]);
    expect(tree[0].name).toBe("Clients");
    expect(tree[0].children[0].name).toBe("Acme");
    expect(unreadUnder(tree[0])).toBe(2);
  });

  it("does not split a dotted name when the server uses slashes", () => {
    expect(folderTree([f("v1.2 release"), f("Ops/Oncall")]).map((n) => n.name)).toEqual(["Ops", "v1.2 release"]);
  });

  it("knows which branch holds the open folder", () => {
    const tree = folderTree([f("A/B/C"), f("D")]);
    const c = tree[0].children[0].children[0].folder!;
    expect(holds(tree[0], (x) => x.id === c.id)).toBe(true);
    expect(holds(tree[1], (x) => x.id === c.id)).toBe(false);
  });
});
