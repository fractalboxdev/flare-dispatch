// The `stagedWriteGate` subject of the `diff` job (specs/verification.md § V-DIFF, FD-VER-019): each event is one
// call of the gate, answered by the TypeScript gate and by the `oracle` executable compiled from
// `formal/FdFormal/StagedWrite.lean`. The generators draw paths, globs and texts from vocabularies that reach every
// reason kind, letter-case folding outside ASCII, the 1024-byte path bound, UTF-16 surrogate pairs in globs and
// lengths, and URL hosts the WHATWG parser rewrites or refuses. URL hosts stay inside the domain `hostOf` in
// `formal/FdFormal/JsText.lean` models: ASCII letters, digits, `-` and `.`.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import type { DiffSubject } from "../../../ops/src/verification/diff.ts";
import { pipeOracle, type PipeOracle } from "../../../ops/src/verification/pipe-oracle.ts";
import { stagedWriteGate } from "../../src/staged-write/gate.ts";
import type {
  GateVerdict,
  Manifest,
  StoredBlob,
  WritebackSpec,
} from "../../src/staged-write/manifest.ts";

/** One gate call: its four arguments, with the base commit's texts as a list. */
export interface GateEvent {
  readonly manifest: Manifest;
  readonly spec: WritebackSpec;
  readonly modelAuthored: boolean;
  readonly evidence: {
    readonly blobs: readonly StoredBlob[];
    readonly base: readonly { readonly path: string; readonly text: string | null }[];
    readonly issuedCredentials: readonly string[];
    readonly githubHost: string;
  };
}

/** The TypeScript gate on one event; the first base entry for a path answers `baseText`. */
export const runGate = (e: GateEvent): GateVerdict =>
  stagedWriteGate(e.manifest, e.spec, e.modelAuthored, {
    blobs: e.evidence.blobs,
    baseText: (path) => e.evidence.base.find((b) => b.path === path)?.text ?? null,
    issuedCredentials: e.evidence.issuedCredentials,
    githubHost: e.evidence.githubHost,
  });

const SEGMENTS = [
  "src",
  "docs",
  "lib",
  "a.ts",
  "README.md",
  "deep",
  "x",
  "runs",
  "RUNS",
  "Runs",
  "infra",
  "INFRA",
  "İnfra",
  ".github",
  ".GitHub",
  "workflows",
  "WORKFLOWS",
  "worKflows",
  "actions",
  ".circleci",
  "wrangler.jsonc",
  "Wrangler.JSONC",
  "wrangler.json",
  "WRANGLER.TOML",
  "package.json",
  "Cargo.toml",
  "pnpm-lock.yaml",
  "requirements.txt",
  "requirements-dev_1.txt",
  "requirements+x.txt",
  ".cargo",
  "config",
  "config.toml",
  ".npmrc",
  "Dockerfile",
  "dockerfile.prod",
  "app.Dockerfile",
  "Containerfile",
  "Jenkinsfile",
  "JENKINSFILE",
  ".gitlab-ci.yml",
  "azure-pipelines.yml",
  ".git",
  ".GIT",
  ".GİT",
  "..",
  ".",
  "",
  "a\\b",
  "a\u0000b",
  "café",
  "Été",
  "straße",
  "Ångström",
  "\u{1F600}",
  "line\nbreak",
  "q?",
];

const longPath = fc.oneof(
  fc.integer({ min: 1018, max: 1024 }).map((n) => `src/${"a".repeat(n)}`),
  fc.integer({ min: 508, max: 512 }).map((n) => `docs/${"é".repeat(n)}`),
);

const path = fc.oneof(
  {
    weight: 12,
    arbitrary: fc
      .array(fc.constantFrom(...SEGMENTS), { minLength: 1, maxLength: 4 })
      .map((s) => s.join("/")),
  },
  {
    weight: 1,
    arbitrary: fc
      .array(fc.constantFrom(...SEGMENTS), { minLength: 1, maxLength: 3 })
      .map((s) => `/${s.join("/")}`),
  },
  { weight: 1, arbitrary: longPath },
);

const GLOBS = [
  "**",
  "src/**",
  "**/*.ts",
  "docs/*",
  "*",
  "?",
  "src/?.ts",
  "**/",
  "runs/**",
  ".github/**",
  "*.md",
  "src/*/**",
  "**/config",
  "",
  "a.ts",
  "src/\u{1F600}",
  "src/??",
  "s?c/**",
  "***",
  "deep/**/x",
  "*/*",
  "line\nbreak",
  "**/line*",
];

const HOSTS = [
  "github.com",
  "GitHub.COM",
  "api.github.com",
  "evilgithub.com",
  "github.com.evil.net",
  "evil.com",
  "example.org",
  "docs.example.org",
  "localhost",
  "a-b.example.org",
  "github.com.",
  "127.0.0.1",
  "0x7f.1",
  "1.2",
  "evil.1",
  "10.0.0.300",
  "08.1",
];

const url = fc
  .tuple(
    fc.constantFrom("http://", "https://", "HTTP://", "Https://", "http:///", "https:/"),
    fc.constantFrom("", "", "", "user@", "github.com@", "a:b@", "@"),
    fc.constantFrom(...HOSTS),
    fc.constantFrom("", "", "", ":8080", ":99999", ":abc", ":", ":0443"),
    fc.constantFrom("", "", "/", "/x/y", "?q=1", "#frag", "/a@evil.com", "\\x", "/é"),
  )
  .map((parts) => parts.join(""));

const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const UPPER_DIGIT = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const run = (alphabet: string, min: number, max: number) =>
  fc
    .array(fc.constantFrom(...alphabet), { minLength: min, maxLength: max })
    .map((cs) => cs.join(""));

const credential = fc.oneof(
  fc
    .tuple(fc.constantFrom("ghp_", "gho_", "ghs_", "ghu_", "ghr_", "ghx_"), run(ALNUM, 18, 22))
    .map(([p, r]) => p + r),
  run(`${ALNUM}_`, 19, 22).map((r) => `github_pat_${r}`),
  fc
    .tuple(fc.constantFrom("AKIA", "ASIA", "ABIA", "ACCA", "AKIB"), run(UPPER_DIGIT, 15, 17))
    .map(([p, r]) => p + r),
  fc.constantFrom(
    "-----BEGIN RSA PRIVATE KEY-----",
    "-----BEGIN PRIVATE KEY-----",
    "-----BEGIN OPENSSH A1 PRIVATE KEY-----",
    "-----BEGIN ENCRYPTED  PRIVATE KEY-----",
    "-----BEGIN rsa PRIVATE KEY-----",
  ),
  fc
    .tuple(fc.constantFrom("a", "b", "p", "o", "s", "r", "z"), run(`${ALNUM}-`, 9, 12))
    .map(([c, r]) => `xox${c}-${r}`),
  fc
    .tuple(run(`${ALNUM}_-`, 7, 9), run(`${ALNUM}_-`, 7, 9), run(`${ALNUM}_-`, 7, 9))
    .map(([a, b, c]) => `eyJ${a}.eyJ${b}.${c}`),
);

const ISSUED = [
  "s3cr3t-value",
  "short",
  "AAAAAAAA",
  "\u{1F600}\u{1F600}\u{1F600}\u{1F600}",
  "\u{1F600}\u{1F600}\u{1F600}",
];

const token = fc.oneof(
  {
    weight: 6,
    arbitrary: fc.constantFrom(
      "fix",
      "the",
      "bug",
      "Hello",
      "café",
      "\u{1F600}",
      "http",
      "https:",
      "ghp",
      "x",
    ),
  },
  { weight: 4, arbitrary: url },
  { weight: 3, arbitrary: credential },
  { weight: 1, arbitrary: fc.constantFrom(...ISSUED) },
  { weight: 1, arbitrary: run(`${ALNUM}+/_-`, 62, 66) },
  {
    weight: 1,
    arbitrary: fc
      .tuple(fc.constantFrom("x", "_", "9", "("), fc.oneof(url, credential))
      .map(([a, b]) => a + b),
  },
);

const SEPARATORS = [" ", " ", "\n", "\r\n", "\r", "\t", ")", "]", "<", '"', " (", " ", " ", "'"];

const text = fc
  .array(fc.tuple(token, fc.constantFrom(...SEPARATORS)), { maxLength: 7 })
  .map((parts) => parts.map(([t, s]) => t + s).join(""));

const DIGESTS = ["a".repeat(64), "b".repeat(64)];

const entry = fc.record({
  path,
  mode: fc.constantFrom("100644", "100644", "100755", "100600", "120000"),
  digest: fc.constantFrom(...DIGESTS),
});

/** A base text derived from a blob's text: some of its lines kept, so the added-line scan has something to skip. */
const baseFor = (blobText: string | null) =>
  fc.oneof(
    fc.constant<string | null>(null),
    text,
    blobText === null
      ? fc.constant<string | null>(null)
      : fc.subarray(blobText.split("\n")).map((lines) => lines.join("\n")),
  );

export const gateEvent: fc.Arbitrary<GateEvent> = fc
  .record({
    branch: fc.constantFrom(
      "flare-dispatch/x",
      "flare-dispatch/",
      "main",
      "flare-dispatch/feat/\u{1F600}",
      "Flare-Dispatch/x",
    ),
    entries: fc.array(entry, { maxLength: 5 }),
    message: text,
    title: text,
    body: text,
    modelAuthored: fc.boolean(),
    allowlist: fc.subarray(GLOBS, { maxLength: 3 }),
    allowSensitivePaths: fc.boolean(),
    allowWorkflows: fc.boolean(),
    maxFiles: fc.constantFrom(undefined, undefined, 0, 1, 2, 5),
    maxBytes: fc.constantFrom(undefined, undefined, 0, 10, 1000),
    linkAllowlist: fc.option(fc.subarray(["example.org", "EXAMPLE.org", "docs.example.org", ""]), {
      nil: undefined,
    }),
    issuedCredentials: fc.subarray(ISSUED),
    githubHost: fc.constantFrom("github.com", "GitHub.com", "ghe.example.org"),
  })
  .chain((r) =>
    fc
      .tuple(
        fc.tuple(
          ...r.entries.map((e) =>
            fc.record({
              present: fc.constantFrom(true, true, true, false),
              digest: fc.constantFrom(e.digest, e.digest, e.digest, DIGESTS[0]!, DIGESTS[1]!),
              size: fc.oneof(
                fc.integer({ min: 0, max: 600 }),
                fc.integer({ min: 0, max: 3 * 1024 * 1024 }),
              ),
              text: fc.option(text, { nil: null, freq: 4 }),
            }),
          ),
        ),
        fc.array(
          fc.record({
            path,
            digest: fc.constantFrom(...DIGESTS),
            size: fc.nat(100),
            text: fc.option(text, { nil: null }),
          }),
          {
            maxLength: 1,
          },
        ),
      )
      .chain(([blobFacts, extra]) => {
        const blobs: StoredBlob[] = [];
        r.entries.forEach((e, i) => {
          const b = blobFacts[i] as {
            present: boolean;
            digest: string;
            size: number;
            text: string | null;
          };
          if (b.present) blobs.push({ path: e.path, digest: b.digest, size: b.size, text: b.text });
        });
        blobs.push(...(extra as StoredBlob[]));
        return fc
          .tuple(...blobs.map((b) => fc.option(baseFor(b.text), { nil: undefined, freq: 2 })))
          .map((bases): GateEvent => ({
            manifest: {
              branch: r.branch,
              baseBranch: "main",
              baseCommit: "c".repeat(40),
              message: r.message,
              pr: { title: r.title, body: r.body, draft: false, labels: [] },
              entries: r.entries,
            },
            spec: {
              branch: "flare-dispatch/x",
              baseBranch: "main",
              allowlist: r.allowlist,
              allowSensitivePaths: r.allowSensitivePaths,
              allowWorkflows: r.allowWorkflows,
              ...(r.maxFiles === undefined ? {} : { maxFiles: r.maxFiles }),
              ...(r.maxBytes === undefined ? {} : { maxBytes: r.maxBytes }),
              ...(r.linkAllowlist === undefined ? {} : { linkAllowlist: r.linkAllowlist }),
            },
            modelAuthored: r.modelAuthored,
            evidence: {
              blobs,
              base: blobs.flatMap((b, i) =>
                bases[i] === undefined ? [] : [{ path: b.path, text: bases[i] as string | null }],
              ),
              issuedCredentials: r.issuedCredentials,
              githubHost: r.githubHost,
            },
          }));
      }),
  );

/** One model call a capacity lease's usage report records: the lease and the execution it ran for. */
export interface UsageCall {
  readonly leaseId: string;
  readonly executionId: string;
}

/**
 * One `local.writeback` that proposes file changes (FD-LOCAL-094): the registered execution and its lease, the lease
 * usage reports' model calls, and the gate event the writeback gate reaches. The manifest is a `device-signed` draft
 * from a `flare-dispatch/` branch, so every event passes the checks before the gate, and the event's `modelAuthored`
 * is whether a usage report of the execution's lease records a model call for that execution.
 */
export interface WritebackEvent {
  readonly executionId: string;
  readonly leaseId: string;
  readonly usage: readonly UsageCall[];
  readonly gate: GateEvent;
}

export const WRITEBACK_EXECUTION = "01HWRITEBACK0000000000000";
export const WRITEBACK_LEASE = "L-writeback";

/** Whether the usage reports record a model call for the execution under its lease. */
export const modelAuthoredFrom = (
  usage: readonly UsageCall[],
  leaseId: string,
  executionId: string,
) => usage.some((c) => c.leaseId === leaseId && c.executionId === executionId);

const usageCall = fc.record({
  leaseId: fc.constantFrom(WRITEBACK_LEASE, WRITEBACK_LEASE, "L-other"),
  executionId: fc.constantFrom(WRITEBACK_EXECUTION, "01HOTHEREXECUTION00000000"),
});

export const writebackEvent: fc.Arbitrary<WritebackEvent> = fc
  .tuple(
    gateEvent,
    fc.array(usageCall, { maxLength: 3 }),
    fc.constantFrom("flare-dispatch/x", "flare-dispatch/", "flare-dispatch/feat/\u{1F600}"),
  )
  .map(([e, usage, branch]) => ({
    executionId: WRITEBACK_EXECUTION,
    leaseId: WRITEBACK_LEASE,
    usage,
    gate: {
      ...e,
      manifest: {
        ...e.manifest,
        branch,
        pr: { ...e.manifest.pr, draft: true, labels: ["device-signed"] },
      },
      modelAuthored: modelAuthoredFrom(usage, WRITEBACK_LEASE, WRITEBACK_EXECUTION),
    },
  }));

/** The oracle executable `lake build oracle` writes in `formal/`. */
export const ORACLE_PATH = fileURLToPath(
  new URL("../../../../formal/.lake/build/bin/oracle", import.meta.url),
);

let oracle: PipeOracle<GateEvent, GateVerdict> | undefined;

const startOracle = (): PipeOracle<GateEvent, GateVerdict> => {
  if (!existsSync(ORACLE_PATH))
    throw new Error(`no oracle at ${ORACLE_PATH}: run \`lake build oracle\` in formal/`);
  return pipeOracle<GateEvent, GateVerdict>(ORACLE_PATH);
};

export const subject: DiffSubject<GateEvent, GateVerdict> = {
  kernel: "stagedWriteGate",
  run: runGate,
  oracle: (e) => (oracle ??= startOracle()).ask(e),
  arbitrary: gateEvent,
  close: () => {
    oracle?.close();
    oracle = undefined;
  },
};
