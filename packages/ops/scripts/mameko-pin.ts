// Points every citation of mameko at the vendored commit: the pin of specs/README.md § Depends on mameko and every
// `blob` or `tree` link into mameko's repository in specs/, apps/docs/ and the root Markdown files, so the `spec-tags`
// pin checks hold (specs/verification.md FD-VER-035, FD-VER-036).
//
//   git -C vendor/mameko checkout <commit> && git add vendor/mameko
//   pnpm mameko:pin [--check]
//
// The commit is the gitlink in the index, which is HEAD's gitlink once the bump is committed. `--check` rewrites
// nothing and exits non-zero naming each file that cites another commit.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { repinMameko } from "../src/verification/spec-tags.ts";
import { args, readTree, ROOT } from "./repo.ts";

const opts = args(process.argv.slice(2));
const ls = execFileSync("git", ["-C", ROOT, "ls-files", "--stage", "--", "vendor/mameko"], {
  encoding: "utf8",
}).trim();
const gitlink = /^160000 ([0-9a-f]{40}) 0\tvendor\/mameko$/.exec(ls);
if (gitlink === null) {
  console.error(`vendor/mameko is not a submodule gitlink in the index: ${ls || "absent"}`);
  process.exit(1);
}
const commit = gitlink[1]!;

const markdown = (p: string) => p.endsWith(".md") || p.endsWith(".mdx");
const files = new Map<string, string>();
for (const [dir, keep] of [
  ["specs", markdown],
  ["apps/docs", (p: string) => markdown(p) || p.endsWith(".astro")],
] as const)
  for (const [path, text] of readTree(join(ROOT, dir), keep)) files.set(join(dir, path), text);
for (const name of readdirSync(ROOT))
  if (markdown(name)) files.set(name, readFileSync(join(ROOT, name), "utf8"));

const changed = [...files].filter(([, text]) => repinMameko(text, commit) !== text);
for (const [path, text] of changed) {
  if (!opts.has("check")) writeFileSync(join(ROOT, path), repinMameko(text, commit));
  console.log(`${opts.has("check") ? "cites another commit" : "repinned"}: ${path}`);
}
console.log(
  `mameko-pin: ${commit}, ${changed.length} file(s) ${opts.has("check") ? "off the pin" : "rewritten"}`,
);
process.exit(opts.has("check") && changed.length > 0 ? 1 : 0);
