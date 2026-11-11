import { createHash } from "node:crypto";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { stagedWriteGate } from "./gate.ts";
import type { GateEvidence, GateVerdict, Manifest, ReasonKind, WritebackSpec } from "./manifest.ts";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const BASE = "a".repeat(40);

const spec: WritebackSpec = {
  branch: "flare-dispatch/fix",
  baseBranch: "main",
  allowlist: ["**"],
  allowSensitivePaths: false,
  allowWorkflows: false,
};

type Files = Record<string, string>;

const write = (files: Files, over: Partial<Manifest> = {}): Manifest => ({
  branch: "flare-dispatch/fix",
  baseBranch: "main",
  baseCommit: BASE,
  message: "fix: a thing",
  pr: { title: "Fix a thing", body: "Body.", draft: true, labels: [] },
  entries: Object.entries(files).map(([path, text]) => ({
    path,
    mode: "100644",
    digest: sha(text),
  })),
  ...over,
});

const evidence = (
  files: Files,
  base: Files = {},
  issued: readonly string[] = [],
): GateEvidence => ({
  blobs: Object.entries(files).map(([path, text]) => ({
    path,
    digest: sha(text),
    size: Buffer.byteLength(text),
    text,
  })),
  baseText: (path) => base[path] ?? null,
  issuedCredentials: issued,
  githubHost: "github.com",
});

const gate = (
  files: Files,
  opts: {
    spec?: Partial<WritebackSpec>;
    model?: boolean;
    over?: Partial<Manifest>;
    base?: Files;
    issued?: string[];
  } = {},
): GateVerdict =>
  stagedWriteGate(
    write(files, opts.over),
    { ...spec, ...opts.spec },
    opts.model ?? false,
    evidence(files, opts.base, opts.issued),
  );

const kinds = (v: GateVerdict): readonly ReasonKind[] =>
  v._tag === "accept" ? [] : v.reasons.map((r) => r.kind);

describe("stagedWriteGate", () => {
  it("accepts a clean manifest", () => {
    expect(gate({ "src/a.ts": "export const a = 1;\n" })).toEqual({ _tag: "accept" });
  });

  it("[FD-AGT-014] rejects a stored blob whose digest differs from its entry", () => {
    const files = { "src/a.ts": "one" };
    const verdict = stagedWriteGate(
      { ...write(files), entries: [{ path: "src/a.ts", mode: "100644", digest: sha("two") }] },
      spec,
      false,
      evidence(files),
    );
    expect(kinds(verdict)).toEqual(["digest-mismatch"]);
  });

  it("[FD-AGT-017] rejects the whole manifest and returns every reason for every entry in one result", () => {
    const verdict = gate(
      { "../x": "a", "runs/r.ts": "b", "package.json": "{}", "ok.ts": "c" },
      { model: true, over: { branch: "main" } },
    );
    expect(kinds(verdict)).toEqual([
      "branch-invalid",
      "path-invalid",
      "protected-path",
      "sensitive-not-opted-in",
    ]);
  });

  it("[FD-AGT-019] rejects every malformed path with path-invalid", () => {
    for (const path of [
      "/etc/passwd",
      "a/../b",
      "./a",
      "a//b",
      "a/",
      ".git/config",
      "x/.GIT/hooks",
      "a\\b",
      "a\0b",
      "a".repeat(1025),
    ])
      expect(kinds(gate({ [path]: "x" })), path).toContain("path-invalid");
    expect(kinds(gate({ "a/.gitignore": "x", ".github/CODEOWNERS": "x" }))).toEqual([]);
  });

  it("[FD-AGT-020] rejects runs/, infra/, .github/workflows/ and wrangler.jsonc in any case for model-authored writes, whatever the opt-ins", () => {
    for (const path of [
      "runs/x.ts",
      "INFRA/Dockerfile.sandbox",
      ".github/Workflows/ci.yml",
      "apps/x/Wrangler.JSONC",
    ])
      expect(
        kinds(
          gate(
            { [path]: "x" },
            { model: true, spec: { allowSensitivePaths: true, allowWorkflows: true } },
          ),
        ),
        path,
      ).toContain("protected-path");
    expect(kinds(gate({ "runs/x.ts": "x" }, { model: false }))).toEqual([]);
  });

  it("[FD-AGT-021] rejects wrangler.json and wrangler.toml for model-authored writes", () => {
    expect(kinds(gate({ "a/WRANGLER.json": "x", "wrangler.toml": "y" }, { model: true }))).toEqual([
      "protected-path",
      "protected-path",
    ]);
  });

  it("[FD-AGT-022] rejects a human-authored workflow change unless the recipe sets allowWorkflows", () => {
    expect(kinds(gate({ ".github/workflows/ci.yml": "x" }))).toEqual(["workflows-not-opted-in"]);
    expect(
      kinds(gate({ ".github/workflows/ci.yml": "x" }, { spec: { allowWorkflows: true } })),
    ).toEqual([]);
  });

  it("[FD-AGT-023] rejects sensitive paths without allowSensitivePaths, in any case", () => {
    const sensitive = [
      "package.json",
      "sub/Cargo.toml",
      "pnpm-lock.yaml",
      "yarn.lock",
      ".npmrc",
      "Dockerfile",
      "infra2/Dockerfile.sandbox",
      ".github/actions/x/action.yml",
      ".circleci/config.yml",
      ".gitlab-ci.yml",
      "JENKINSFILE",
      "azure-pipelines.yml",
      "requirements-dev.txt",
    ];
    for (const path of sensitive)
      expect(kinds(gate({ [path]: "x" })), path).toEqual(["sensitive-not-opted-in"]);
    for (const path of sensitive)
      expect(kinds(gate({ [path]: "x" }, { spec: { allowSensitivePaths: true } })), path).toEqual(
        [],
      );
  });

  it("[FD-AGT-024] rejects a path no allowlist glob matches, and an empty allowlist rejects every entry", () => {
    expect(
      kinds(gate({ "specs/a.md": "x", "src/b.ts": "y" }, { spec: { allowlist: ["specs/**"] } })),
    ).toEqual(["outside-allowlist"]);
    expect(kinds(gate({ "a.md": "x" }, { spec: { allowlist: [] } }))).toEqual([
      "outside-allowlist",
    ]);
    expect(
      kinds(
        gate(
          { ".flare-dispatch/triage/x.md": "x" },
          { spec: { allowlist: [".flare-dispatch/triage/**"] } },
        ),
      ),
    ).toEqual([]);
    expect(kinds(gate({ "docs/a/b.md": "x" }, { spec: { allowlist: ["docs/*.md"] } }))).toEqual([
      "outside-allowlist",
    ]);
  });

  it("[FD-AGT-025] rejects more entries than maxFiles, default 200", () => {
    const many = Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`f/${i}.txt`, `${i}`]));
    expect(kinds(gate(many))).toEqual(["too-many-files"]);
    expect(kinds(gate({ a: "1", b: "2" }, { spec: { maxFiles: 1 } }))).toEqual(["too-many-files"]);
  });

  it("[FD-AGT-026] rejects blobs over maxBytes, default 5 MiB", () => {
    expect(kinds(gate({ big: "x".repeat(5 * 1024 * 1024 + 1) }))).toEqual(["too-large"]);
    expect(kinds(gate({ a: "12345" }, { spec: { maxBytes: 4 } }))).toEqual(["too-large"]);
  });

  it("[FD-AGT-027] rejects a mode other than 100644 or 100755", () => {
    const files = { "a.sh": "x", "b.sh": "y", link: "z" };
    const m = write(files);
    const verdict = stagedWriteGate(
      {
        ...m,
        entries: m.entries.map((e, i) => ({
          ...e,
          mode: ["100755", "100644", "120000"][i] as string,
        })),
      },
      spec,
      false,
      evidence(files),
    );
    expect(verdict).toEqual({ _tag: "reject", reasons: [{ kind: "mode-invalid", path: "link" }] });
  });

  it("[FD-AGT-028] rejects a branch that does not start with flare-dispatch/", () => {
    expect(kinds(gate({ a: "x" }, { over: { branch: "feature/x" } }))).toEqual(["branch-invalid"]);
    expect(kinds(gate({ a: "x" }, { over: { branch: "flare-dispatch" } }))).toEqual([
      "branch-invalid",
    ]);
    expect(kinds(gate({ a: "x" }, { over: { branch: "flare-dispatch/" } }))).toEqual([]);
  });

  it("[FD-AGT-029] rejects credential patterns in added lines and text fields, and issued credentials", () => {
    const secrets = [
      `ghp_${"a".repeat(36)}`,
      `gho_${"B".repeat(36)}`,
      `ghs_${"c".repeat(36)}`,
      `ghu_${"d".repeat(36)}`,
      `ghr_${"e".repeat(36)}`,
      `github_pat_${"f".repeat(40)}`,
      "AKIAABCDEFGHIJKLMNOP",
      "-----BEGIN RSA PRIVATE KEY-----",
      "-----BEGIN PRIVATE KEY-----",
      "xoxb-1234567890-abcdef",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
    ];
    for (const s of secrets)
      expect(kinds(gate({ "a.ts": `const x = "${s}";` })), s).toEqual(["secret-detected"]);
    expect(kinds(gate({ "a.ts": "x" }, { over: { message: `leak ${secrets[0]}` } }))).toEqual([
      "secret-detected",
    ]);
    expect(
      kinds(
        gate(
          { "a.ts": "x" },
          { over: { pr: { title: secrets[6] as string, body: "", draft: true, labels: [] } } },
        ),
      ),
    ).toEqual(["secret-detected"]);
    expect(
      kinds(gate({ "a.ts": "token=lease-token-1234" }, { issued: ["lease-token-1234"] })),
    ).toEqual(["secret-detected"]);
    // A line present at the base commit is not an added line.
    const kept = `const x = "${secrets[0]}";`;
    expect(kinds(gate({ "a.ts": `${kept}\nnew line` }, { base: { "a.ts": kept } }))).toEqual([]);
  });

  it("[FD-AGT-030] names the path and line of a secret and never the matched value", () => {
    const token = `ghp_${"z".repeat(36)}`;
    const verdict = gate({ "src/a.ts": `one\ntwo ${token}\n` });
    expect(verdict).toEqual({
      _tag: "reject",
      reasons: [{ kind: "secret-detected", path: "src/a.ts", line: 2, detail: "github-token" }],
    });
    expect(JSON.stringify(verdict)).not.toContain(token);
  });

  it("[FD-AGT-031] rejects a model-authored message, title or body linking outside the link allowlist", () => {
    const body = (text: string) => ({ pr: { title: "t", body: text, draft: true, labels: [] } });
    expect(
      kinds(gate({ a: "x" }, { model: true, over: body("see https://evil.example/x") })),
    ).toEqual(["url-not-allowed"]);
    expect(
      kinds(gate({ a: "x" }, { model: true, over: body("see https://github.com/o/r/pull/1") })),
    ).toEqual([]);
    expect(
      kinds(
        gate(
          { a: "x" },
          {
            model: true,
            over: body("see https://Example.ORG/p"),
            spec: { linkAllowlist: ["example.org"] },
          },
        ),
      ),
    ).toEqual([]);
    // A subdomain of an allowlisted host is not in the allowlist, and an empty entry admits no host.
    for (const [text, allow] of [
      ["see https://docs.example.org/p", ["example.org"]],
      ["see http://evil.com./x", [""]],
    ] as const)
      expect(
        kinds(
          gate({ a: "x" }, { model: true, over: body(text), spec: { linkAllowlist: [...allow] } }),
        ),
      ).toEqual(["url-not-allowed"]);
    expect(kinds(gate({ a: "x" }, { model: true, over: { message: "http://x.test/" } }))).toEqual([
      "url-not-allowed",
    ]);
    expect(
      kinds(gate({ a: "x" }, { model: false, over: body("see https://evil.example/x") })),
    ).toEqual([]);
  });

  it("[FD-AGT-032] rejects an added model-authored line linking a host neither allowlisted nor in the file at base", () => {
    expect(kinds(gate({ "README.md": "go to https://new.example/" }, { model: true }))).toEqual([
      "url-not-allowed",
    ]);
    expect(
      kinds(
        gate(
          { "README.md": "old https://kept.example/a\nnew https://kept.example/b" },
          { model: true, base: { "README.md": "old https://kept.example/a" } },
        ),
      ),
    ).toEqual([]);
    expect(kinds(gate({ "README.md": "go to https://new.example/" }, { model: false }))).toEqual(
      [],
    );
  });

  it("[FD-AGT-033] rejects a run of 64 base64 or hex characters in model-authored text fields", () => {
    expect(
      kinds(gate({ a: "x" }, { model: true, over: { message: `fix ${"ab12".repeat(16)}` } })),
    ).toEqual(["encoded-run"]);
    expect(
      kinds(gate({ a: "x" }, { model: true, over: { message: `fix ${"Zm9v".repeat(16)}` } })),
    ).toEqual(["encoded-run"]);
    expect(
      kinds(gate({ a: "x" }, { model: true, over: { message: `fix ${"a".repeat(63)}` } })),
    ).toEqual([]);
    expect(
      kinds(gate({ a: "x" }, { model: false, over: { message: `fix ${"a".repeat(64)}` } })),
    ).toEqual([]);
  });
});

// Property S8 of specs/verification.md: a model-authored staged write never touches a protected path, and one failing
// entry rejects the whole manifest. These generated traces stand beside the planned Lean theorems
// `StagedWrite.model_authored_protected_paths` and `StagedWrite.reject_whole_manifest`.
describe("S8 properties", () => {
  const segment = fc.stringMatching(/^[A-Za-z0-9_-]{1,8}$/);
  const protectedPath = fc.oneof(
    fc
      .tuple(
        fc.constantFrom("runs", "RUNS", "infra", "Infra", ".github/workflows", ".GitHub/Workflows"),
        segment,
      )
      .map(([dir, f]) => `${dir}/${f}`),
    fc
      .tuple(
        segment,
        fc.constantFrom("wrangler.jsonc", "Wrangler.JSONC", "wrangler.json", "wrangler.toml"),
      )
      .map(([d, f]) => `${d}/${f}`),
  );
  const plainPath = fc
    .tuple(fc.constantFrom("src", "docs", "lib"), segment)
    .map(([d, f]) => `${d}/${f}.txt`);
  const optIns = fc.record({ allowSensitivePaths: fc.boolean(), allowWorkflows: fc.boolean() });

  it("[FD-AGT-020] [FD-AGT-016] no model-authored manifest holding a protected path is accepted, whatever the opt-ins", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(plainPath, { maxLength: 5 }),
        protectedPath,
        optIns,
        (plain, bad, opts) => {
          const files = Object.fromEntries([...plain, bad].map((p) => [p, "x"]));
          const verdict = gate(files, { model: true, spec: opts });
          return (
            verdict._tag === "reject" &&
            verdict.reasons.some((r) => r.kind === "protected-path" && r.path === bad)
          );
        },
      ),
      { numRuns: 2000 },
    );
  });

  it("[FD-AGT-017] a manifest is accepted only when each of its entries is accepted alone", () => {
    const anyPath = fc.oneof(
      plainPath,
      protectedPath,
      fc.constantFrom("../x", "package.json", "a//b"),
    );
    fc.assert(
      fc.property(
        fc.uniqueArray(anyPath, { minLength: 1, maxLength: 6 }),
        fc.boolean(),
        (paths, model) => {
          const files = Object.fromEntries(paths.map((p) => [p, "x"]));
          const whole = gate(files, { model })._tag === "accept";
          const each = paths.every((p) => gate({ [p]: "x" }, { model })._tag === "accept");
          const perEntryReasons = paths.flatMap((p) => kinds(gate({ [p]: "x" }, { model })));
          return (
            whole === each &&
            (whole || kinds(gate(files, { model })).length === perEntryReasons.length)
          );
        },
      ),
      { numRuns: 2000 },
    );
  });
});
