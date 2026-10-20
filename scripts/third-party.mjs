// The JavaScript and fonts the window ships with, for THIRD_PARTY.md: every package `dependencies` reaches (not
// devDependencies, which only build it), with its licence and licence text. Run by scripts/third-party.sh.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const read = (dir) => JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));

const seen = new Map();
const visit = (name) => {
  if (seen.has(name)) return;
  const dir = join(root, "node_modules", name);
  if (!existsSync(dir)) return;
  const pkg = read(dir);
  const file = readdirSync(dir).find((f) => /^(licen[cs]e|copying)(\.(md|txt))?$/i.test(f));
  seen.set(name, {
    version: pkg.version,
    license: typeof pkg.license === "string" ? pkg.license : (pkg.license?.type ?? "see package"),
    text: file ? readFileSync(join(dir, file), "utf8").trim() : null,
  });
  for (const dep of Object.keys(pkg.dependencies ?? {})) visit(dep);
};
for (const dep of Object.keys(read(root).dependencies ?? {})) visit(dep);

const out = ["", "## JavaScript and fonts", "", "The window's code and fonts, bundled into the app.", ""];
for (const [name, p] of [...seen].sort(([a], [b]) => a.localeCompare(b))) {
  out.push(`### ${name} ${p.version}`, "", `Licence: ${p.license}. https://www.npmjs.com/package/${name}`, "");
  if (p.text) out.push("```text", p.text, "```", "");
}
process.stdout.write(out.join("\n"));
