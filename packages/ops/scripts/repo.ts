// File access the verification scripts share: the repository's spec, formal and test files, and a base commit's specs.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/** The repository root: three directories above this file. */
export const ROOT = join(import.meta.dirname, "../../..");

const SKIP = new Set([
  "node_modules",
  ".git",
  ".tmp",
  ".wrangler",
  "dist",
  "vendor",
  ".claude",
  ".worktrees",
]);

/** Every file under `dir` whose path matches `keep`, keyed by its path relative to `base`. */
export const readTree = (
  dir: string,
  keep: (path: string) => boolean,
  base = dir,
): Map<string, string> => {
  const out = new Map<string, string>();
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory())
      for (const [k, v] of readTree(path, keep, base)) out.set(k, v);
    else {
      const rel = relative(base, path);
      if (keep(rel)) out.set(rel, readFileSync(path, "utf8"));
    }
  }
  return out;
};

/** The repository's spec Markdown files, keyed relative to specs/. */
export const readSpecs = (): Map<string, string> =>
  readTree(join(ROOT, "specs"), (p) => p.endsWith(".md"));

const git = (args: readonly string[]): string =>
  execFileSync("git", ["-C", ROOT, ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });

/** The spec Markdown files at a commit, keyed relative to specs/. */
export const readSpecsAt = (ref: string): Map<string, string> => {
  const out = new Map<string, string>();
  for (const path of git(["ls-tree", "-r", "--name-only", ref, "--", "specs"]).split("\n"))
    if (path.endsWith(".md")) out.set(path.slice("specs/".length), git(["show", `${ref}:${path}`]));
  return out;
};

/** A file's text at a commit, or null when the commit lacks it. */
export const readAt = (ref: string, path: string): string | null => {
  try {
    return git(["show", `${ref}:${path}`]);
  } catch {
    return null;
  }
};

/** The commit the vendored mameko submodule is checked out at. */
export const vendoredMamekoCommit = (): string =>
  execFileSync("git", ["-C", join(ROOT, "vendor/mameko"), "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();

/** mameko's spec files at the vendored commit. */
export const readMamekoSpecs = (): Map<string, string> =>
  readTree(join(ROOT, "vendor/mameko/specs"), (p) => p.endsWith(".md"));

/** Parses `--name value` and `--flag` arguments. */
export const args = (argv: readonly string[]): Map<string, string> => {
  const out = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) continue;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out.set(a.slice(2), "true");
    else {
      out.set(a.slice(2), next);
      i++;
    }
  }
  return out;
};
