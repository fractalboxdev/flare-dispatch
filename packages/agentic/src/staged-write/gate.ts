// `stagedWriteGate(manifest, writebackSpec, modelAuthored)`: the pure function the `pr.propose` applier and the
// writeback gate run before any GitHub call (specs/runs/agentic.md § Staged write, FD-AGT-014 to FD-AGT-033). It runs
// every check on every entry and returns every reason in one result.
import {
  BRANCH_PREFIX,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_FILES,
  type GateEvidence,
  type GateReason,
  type GateVerdict,
  type Manifest,
  type WritebackSpec,
} from "./manifest.ts";
import {
  addedLines,
  credentialIn,
  hasEncodedRun,
  hostAllowed,
  linesOf,
  urlHostsIn,
} from "./scan.ts";

const MAX_PATH_BYTES = 1024;
const ALLOWED_MODES: ReadonlySet<string> = new Set(["100644", "100755"]);

const utf8Length = (text: string): number => new TextEncoder().encode(text).length;

/** FD-AGT-019: absolute, over 1024 bytes, a `..`, `.` or empty segment, a `.git` segment, a backslash or a NUL. */
export const pathInvalid = (path: string): boolean =>
  path.startsWith("/") ||
  utf8Length(path) > MAX_PATH_BYTES ||
  path.includes("\\") ||
  path.includes("\0") ||
  path
    .split("/")
    .some(
      (segment) =>
        segment === "" || segment === "." || segment === ".." || segment.toLowerCase() === ".git",
    );

const lower = (path: string) => path.toLowerCase();
const fileName = (path: string) => lower(path.split("/").at(-1) ?? "");
const under = (path: string, prefix: string) => lower(path).startsWith(prefix);

/** FD-AGT-020, FD-AGT-021: paths a model-authored write never touches, whatever the recipe's opt-ins. */
export const modelDenied = (path: string): boolean =>
  under(path, "runs/") ||
  under(path, "infra/") ||
  under(path, ".github/workflows/") ||
  ["wrangler.jsonc", "wrangler.json", "wrangler.toml"].includes(fileName(path));

const PACKAGE_MANIFESTS = new Set([
  "package.json",
  "cargo.toml",
  "pyproject.toml",
  "setup.py",
  "setup.cfg",
  "go.mod",
  "gemfile",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "composer.json",
  "pipfile",
  "deno.json",
  "deno.jsonc",
]);
const LOCKFILES = new Set([
  "pnpm-lock.yaml",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "cargo.lock",
  "poetry.lock",
  "uv.lock",
  "pipfile.lock",
  "gemfile.lock",
  "go.sum",
  "composer.lock",
  "deno.lock",
]);
const REGISTRY_CONFIGS = new Set([
  ".npmrc",
  ".yarnrc",
  ".yarnrc.yml",
  ".pypirc",
  "pip.conf",
  "bunfig.toml",
  ".gemrc",
  "pnpm-workspace.yaml",
]);
const CI_FILES = new Set([".gitlab-ci.yml", "jenkinsfile", "azure-pipelines.yml"]);

/** FD-AGT-023: package manifests, lockfiles, registry configuration, Dockerfiles and CI definitions. */
export const sensitivePath = (path: string): boolean => {
  const name = fileName(path);
  return (
    PACKAGE_MANIFESTS.has(name) ||
    LOCKFILES.has(name) ||
    /^requirements[\w.-]*\.txt$/.test(name) ||
    REGISTRY_CONFIGS.has(name) ||
    /(^|\/)\.cargo\/config(\.toml)?$/.test(lower(path)) ||
    name === "dockerfile" ||
    name === "containerfile" ||
    name.startsWith("dockerfile.") ||
    name.endsWith(".dockerfile") ||
    under(path, ".github/actions/") ||
    under(path, ".circleci/") ||
    CI_FILES.has(name)
  );
};

const escapeRegex = (text: string) => text.replace(/[.+^${}()|[\]\\]/g, "\\$&");

/** A glob as a regular expression: `**` spans segments, `*` and `?` stay inside one. */
export const globRegex = (glob: string): RegExp => {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] as string;
    if (c === "*" && glob[i + 1] === "*") {
      if (glob[i + 2] === "/") {
        out += "(?:.*/)?";
        i += 2;
      } else {
        out += ".*";
        i += 1;
      }
    } else if (c === "*") out += "[^/]*";
    else if (c === "?") out += "[^/]";
    else out += escapeRegex(c);
  }
  return new RegExp(`^${out}$`);
};

export const inAllowlist = (path: string, allowlist: readonly string[]): boolean =>
  allowlist.some((glob) => globRegex(glob).test(path));

type TextField = "message" | "pr.title" | "pr.body";

const textFields = (manifest: Manifest): readonly (readonly [TextField, string])[] => [
  ["message", manifest.message],
  ["pr.title", manifest.pr.title],
  ["pr.body", manifest.pr.body],
];

/**
 * The staged-write gate. `modelAuthored` comes from the control plane's own records, never from the run's result
 * (specs/runs/agentic.md § Model).
 */
export const stagedWriteGate = (
  manifest: Manifest,
  spec: WritebackSpec,
  modelAuthored: boolean,
  evidence: GateEvidence,
): GateVerdict => {
  const reasons: GateReason[] = [];
  const maxFiles = spec.maxFiles ?? DEFAULT_MAX_FILES;
  const maxBytes = spec.maxBytes ?? DEFAULT_MAX_BYTES;
  const links = [evidence.githubHost, ...(spec.linkAllowlist ?? [])];
  const blobs = new Map(evidence.blobs.map((b) => [b.path, b]));

  if (!manifest.branch.startsWith(BRANCH_PREFIX) || manifest.branch.length === BRANCH_PREFIX.length)
    reasons.push({ kind: "branch-invalid" });
  if (manifest.entries.length > maxFiles)
    reasons.push({ kind: "too-many-files", detail: `${manifest.entries.length} > ${maxFiles}` });
  const total = manifest.entries.reduce((n, e) => n + (blobs.get(e.path)?.size ?? 0), 0);
  if (total > maxBytes) reasons.push({ kind: "too-large", detail: `${total} > ${maxBytes}` });

  const seen = new Set<string>();
  for (const entry of manifest.entries) {
    const path = entry.path;
    if (pathInvalid(path) || seen.has(path))
      reasons.push({
        kind: "path-invalid",
        path,
        ...(seen.has(path) ? { detail: "duplicate" } : {}),
      });
    seen.add(path);
    if (modelAuthored && modelDenied(path)) reasons.push({ kind: "protected-path", path });
    if (!modelAuthored && under(path, ".github/workflows/") && !spec.allowWorkflows)
      reasons.push({ kind: "workflows-not-opted-in", path });
    if (sensitivePath(path) && !spec.allowSensitivePaths)
      reasons.push({ kind: "sensitive-not-opted-in", path });
    if (!inAllowlist(path, spec.allowlist)) reasons.push({ kind: "outside-allowlist", path });
    if (!ALLOWED_MODES.has(entry.mode)) reasons.push({ kind: "mode-invalid", path });

    const blob = blobs.get(path);
    if (blob === undefined) {
      reasons.push({ kind: "blob-missing", path });
      continue;
    }
    if (blob.digest !== entry.digest) reasons.push({ kind: "digest-mismatch", path });
    if (blob.text === null) continue;
    const base = evidence.baseText(path);
    const baseHosts = new Set(base === null ? [] : urlHostsIn(base));
    for (const { line, text } of addedLines(blob.text, base)) {
      const credential = credentialIn(text, evidence.issuedCredentials);
      if (credential !== null)
        reasons.push({ kind: "secret-detected", path, line, detail: credential });
      if (
        modelAuthored &&
        urlHostsIn(text).some((host) => !hostAllowed(host, links) && !baseHosts.has(host))
      )
        reasons.push({ kind: "url-not-allowed", path, line });
    }
  }

  for (const [field, text] of textFields(manifest)) {
    linesOf(text).forEach((line, index) => {
      const credential = credentialIn(line, evidence.issuedCredentials);
      if (credential !== null)
        reasons.push({ kind: "secret-detected", path: field, line: index + 1, detail: credential });
    });
    if (!modelAuthored) continue;
    if (urlHostsIn(text).some((host) => !hostAllowed(host, links)))
      reasons.push({ kind: "url-not-allowed", path: field });
    if (hasEncodedRun(text)) reasons.push({ kind: "encoded-run", path: field });
  }

  return reasons.length === 0 ? { _tag: "accept" } : { _tag: "reject", reasons };
};
