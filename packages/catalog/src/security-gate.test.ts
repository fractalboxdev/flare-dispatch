// `security-gate` and `security-rescan` end to end in the catalogue: the declarations, the manifest entry and input
// schemas, the request decoders, and each run body over a real git remote. Git runs as the recipe runs it, through
// `processGateExec`; the scanners and baseline checks answer from a script, so each scan result is the test's choice.
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { Effect, Layer, Option, Schema, SchemaAST } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CommandExit, GateExec, processGateExec, type ArgvOptions } from "./command.ts";
import type { DispatchEvent } from "./dispatch-event.ts";
import { fakeIntents } from "./gate.test-support.ts";
import { GateContextFields, GateManifest, SecurityGateEntrySchema } from "./manifest.ts";
import { SecurityGateInput, SecurityRescanInput } from "./inputs.ts";
import { Outcome } from "./reasons.ts";
import { registry, runsFor } from "./runs.ts";
import {
  digestOf,
  envelopeBytes,
  fakeScanImage,
  IMAGE_VERSIONS,
  memoryAdvisorySnapshots,
  memoryScanBundleStore,
  signingKey,
  validPayload,
  type StoredBundle,
  type StoredSnapshot,
} from "./scan-bundle.test-support.ts";
import { decodeRunReport, type RunReport } from "../../github/src/records.ts";
import { StepFindings, type ScanFinding } from "./scan-findings.ts";
import {
  REPORTED_FINDINGS_MAX,
  runSecurityGate,
  runSecurityRescan,
  scanCheckName,
  scanReport,
  ScanSettings,
} from "./security-gate.ts";
import {
  commandInputsOf,
  lookupRun,
  readOnlyScanRunsOf,
  RUN_CATALOG,
  validateReadOnlyScan,
} from "./spec.ts";
import { checkDecoder, securityGateDecoder, securityRescanDecoder } from "./triggers.ts";

const RUNS = ["security-gate", "security-rescan"] as const;

const entryOf = (name: string) => {
  const found = lookupRun("production", name);
  if (found._tag !== "Available") throw new Error(name);
  return found.entry;
};

/** Every property name of a schema, at any depth. */
const fieldNames = (ast: SchemaAST.AST): readonly string[] => {
  const names: string[] = [];
  const walk = (node: SchemaAST.AST): void => {
    if (SchemaAST.isObjects(node))
      for (const p of node.propertySignatures) {
        names.push(String(p.name));
        walk(p.type);
      }
    else if (SchemaAST.isUnion(node)) for (const t of node.types) walk(t);
  };
  walk(ast);
  return names;
};

describe("the security gate recipes in the catalogue", () => {
  it("[FD-GATE-083] ships security-gate and security-rescan, each enrolled by the manifest key securityGate", () => {
    for (const name of RUNS) {
      const entry = entryOf(name);
      expect(entry.manifestKey).toBe("securityGate");
      expect(entry.spec.name).toBe(name);
      expect(registry.map((r) => r.spec.name)).toContain(name);
    }
    expect(entryOf("security-gate").defaultClass).toBe("required");
    expect(entryOf("security-rescan").defaultClass).toBe("batch");
    expect(RUNS.map((r) => entryOf(r).spec.limits.maxDurationSec)).toEqual([1800, 1800]);
    expect(Schema.decodeUnknownSync(GateManifest)({ securityGate: {} })).toEqual({ securityGate: {} });
  });

  it("[FD-GATE-083] serves both recipes on the cloud executor that supplies the scan Layers, and on no device", () => {
    const layers = Layer.empty as never;
    const scan = Layer.empty as never;
    expect(runsFor("development", { kind: "cloud", layers, scan }).map((r) => r.spec.name)).toEqual(
      expect.arrayContaining([...RUNS]),
    );
    expect(runsFor("development", { kind: "cloud", layers }).map((r) => r.spec.name)).not.toContain(
      "security-gate",
    );
    expect(runsFor("development").map((r) => r.spec.name)).not.toContain("security-gate");
    for (const name of RUNS) expect(entryOf(name).executors).toEqual(["cloud"]);
  });

  it("[FD-GATE-084] refuses any field in the securityGate entry: no command, scanner, flag or skip", () => {
    expect(Schema.decodeUnknownSync(SecurityGateEntrySchema)({})).toEqual({});
    for (const field of [
      { command: "gitleaks detect" },
      { scanners: ["gitleaks"] },
      { flags: ["--no-git"] },
      { args: ["--redact=0"] },
      { skip: true },
      { skipAuthors: ["dependabot[bot]"] },
    ]) {
      expect(Option.isNone(Schema.decodeUnknownOption(SecurityGateEntrySchema)(field))).toBe(true);
      expect(Option.isNone(Schema.decodeUnknownOption(GateManifest)({ securityGate: field }))).toBe(
        true,
      );
    }
  });

  it("[FD-GATE-084] gives both input schemas only the commit and its range base: no command, scanner, flag or skip field", () => {
    expect(fieldNames(SecurityGateInput.ast)).toEqual([
      "repo",
      "sha",
      "ref",
      "scope",
      "deadlineAt",
      "base",
      "_tag",
      "branch",
      "_tag",
      "baseSha",
    ]);
    expect(fieldNames(SecurityRescanInput.ast)).toEqual(["repo", "sha", "ref", "scope", "deadlineAt"]);
    for (const input of [SecurityGateInput, SecurityRescanInput]) {
      expect(commandInputsOf(input.ast)).toEqual([]);
      // The gate context's skip facts are what every other gate reads; neither scan input carries them.
      expect(Object.keys(GateContextFields)).toContain("skipAuthors");
      expect(fieldNames(input.ast)).not.toContain("skipAuthors");
      expect(fieldNames(input.ast)).not.toContain("pullRequest");
    }
    const decoded = Schema.decodeUnknownSync(SecurityRescanInput)({
      repo: "https://github.com/o/r.git",
      sha: "a".repeat(40),
      ref: "refs/heads/main",
      command: "true",
      scanners: [],
      skipAuthors: ["octocat"],
    });
    expect(Object.keys(decoded).sort()).toEqual(["ref", "repo", "sha"]);
  });

  it("[FD-GATE-110] declares no grant in either egress phase and seals the job sandbox of both recipes", () => {
    for (const name of RUNS) {
      const entry = entryOf(name);
      expect(entry.spec.grants).toEqual({ setup: [], agent: [] });
      expect(entry.sealedSandbox).toBe(true);
      expect(entry.appCapabilities).toEqual([]);
      expect(registry.find((r) => r.spec.name === name)!.spec.grants).toEqual({ setup: [], agent: [] });
    }
    // The manifest entry carries no grants field either, unlike `workerDeploy`.
    expect(
      Option.isNone(Schema.decodeUnknownOption(SecurityGateEntrySchema)({ grants: ["cf-api"] })),
    ).toBe(true);
    expect(RUN_CATALOG["check"]!.sealedSandbox).toBeUndefined();
  });

  it("[FD-GATE-111] makes security-rescan the catalogue's read-only scan run", () => {
    expect(validateReadOnlyScan("security-rescan", RUN_CATALOG["security-rescan"]!)).toEqual([]);
    expect(entryOf("security-rescan").spec.readOnlyScan).toBe(true);
    expect([...readOnlyScanRunsOf(RUN_CATALOG)]).toEqual(["security-rescan"]);
    expect(scanCheckName("security-rescan")).toBe("flare-dispatch/security-rescan");
  });
});

const repository = (cloneUrl: string) => ({
  fullName: "o/r",
  cloneUrl,
  defaultBranch: "main",
});

const pullRequest = (
  action: string,
  facts: { readonly draft: boolean; readonly author: string },
  cloneUrl = "https://github.com/o/r.git",
  headSha = "a".repeat(40),
): DispatchEvent => ({
  _tag: "webhook",
  deliveryId: "d-1",
  delivery: {
    event: "pull_request",
    action,
    repository: repository(cloneUrl),
    pullRequest: {
      number: 7,
      draft: facts.draft,
      author: facts.author,
      headSha,
      headRef: "feature",
      baseRef: "main",
      baseSha: "c".repeat(40),
    },
  },
});

const mergeGroup = (baseSha?: string): DispatchEvent => ({
  _tag: "webhook",
  deliveryId: "d-2",
  delivery: {
    event: "merge_group",
    action: "checks_requested",
    repository: repository("https://github.com/o/r.git"),
    headSha: "9".repeat(40),
    headRef: "refs/heads/gh-readonly-queue/main/pr-7-9999999",
    baseRef: "refs/heads/main",
    ...(baseSha === undefined ? {} : { baseSha }),
  },
});

const dispatch = (run: string, inputs: unknown): DispatchEvent => ({
  _tag: "dispatch",
  run,
  repo: "o/r",
  ref: "refs/heads/main",
  sha: "a".repeat(40),
  inputs,
  caller: "operator@example.com",
});

describe("the security gate request decoders", () => {
  it("[FD-GATE-085] answers every gate pull-request action whatever the draft state or author, with no skip fact in the input", () => {
    const decode = securityGateDecoder();
    for (const action of ["opened", "synchronize", "reopened", "ready_for_review"])
      for (const facts of [
        { draft: true, author: "dependabot[bot]" },
        { draft: true, author: "octocat" },
        { draft: false, author: "dependabot[bot]" },
        { draft: false, author: "octocat" },
      ])
        expect(Option.getOrThrow(decode(pullRequest(action, facts)))).toEqual({
          repo: "https://github.com/o/r.git",
          sha: "a".repeat(40),
          ref: "refs/pull/7/head",
          scope: "o/r",
          base: { _tag: "TargetBranch", branch: "main" },
        });
    expect(Option.isNone(decode(pullRequest("closed", { draft: false, author: "octocat" })))).toBe(
      true,
    );
    // `check` answers the same delivery with the skip facts its body reads; the scan input has none to read.
    const checked = checkDecoder({ label: "unit", command: "pnpm test" })(
      pullRequest("opened", { draft: true, author: "dependabot[bot]" }),
    );
    expect(Option.getOrThrow(checked)).toMatchObject({
      pullRequest: { draft: true, author: "dependabot[bot]" },
    });
  });

  it("[FD-GATE-085] answers a merge group's check request from merge_group.base_sha, and no dispatch", () => {
    const decode = securityGateDecoder();
    expect(Option.getOrThrow(decode(mergeGroup("2".repeat(40))))).toMatchObject({
      sha: "9".repeat(40),
      base: { _tag: "MergeGroup", baseSha: "2".repeat(40) },
    });
    expect(Option.getOrThrow(decode(mergeGroup()))).toMatchObject({
      base: { _tag: "TargetBranch", branch: "main" },
    });
    expect(
      Option.isNone(
        decode(dispatch("security-gate", { repo: "r", sha: "a".repeat(40), ref: "main" })),
      ),
    ).toBe(true);
  });

  it("[FD-GATE-111] starts security-rescan from a dispatch alone", () => {
    const decode = securityRescanDecoder();
    const inputs = { repo: "https://github.com/o/r.git", sha: "a".repeat(40), ref: "refs/heads/main" };
    expect(Option.getOrThrow(decode(dispatch("security-rescan", inputs)))).toEqual(inputs);
    expect(
      Option.getOrThrow(decode({ ...dispatch("security-rescan", inputs), _tag: "mcp" } as DispatchEvent)),
    ).toEqual(inputs);
    expect(Option.isNone(decode(dispatch("security-gate", inputs)))).toBe(true);
    expect(Option.isNone(decode(pullRequest("opened", { draft: false, author: "octocat" })))).toBe(
      true,
    );
    expect(Option.isNone(decode(mergeGroup("2".repeat(40))))).toBe(true);
    expect(
      Option.isNone(
        decode({
          _tag: "cron",
          scheduledMinute: "2026-11-12T00:00:00Z",
          repo: "o/r",
          schedule: "0 0 * * *",
        }),
      ),
    ).toBe(true);
  });
});

// A real remote: `main` and a `feature` branch cut from it, with `main` moved on afterwards, so the merge base of the
// feature head and the default branch head is the branch point, not the default branch head.
describe("the security gate run bodies over a real git remote", () => {
  let root: string;
  let origin: string;
  const sha: Record<string, string> = {};
  const env = () => ({
    PATH: process.env["PATH"],
    HOME: root,
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@example.com",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.com",
  });
  const git = (...args: readonly string[]) =>
    execFileSync("git", args, { cwd: origin, encoding: "utf8", env: env() }).trim();
  const put = (path: string, content: string) => {
    mkdirSync(dirname(join(origin, path)), { recursive: true });
    writeFileSync(join(origin, path), content);
  };
  const commit = (name: string) => {
    git("add", "-A");
    git("commit", "-q", "--allow-empty", "-m", name);
    sha[name] = git("rev-parse", "HEAD");
  };

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "fd-security-gate-"));
    process.env["FD_WORKSPACE_ROOT"] = root;
    origin = join(root, "origin");
    mkdirSync(origin);
    git("init", "-q", "-b", "main");
    put("README.md", "base\n");
    commit("branchPoint");
    git("checkout", "-q", "-b", "feature");
    put("package-lock.json", '{"lockfileVersion":3}\n');
    put("src/a.ts", "export {};\n");
    commit("feature");
    git("checkout", "-q", "main");
    put("main.txt", "moved on\n");
    commit("mainHead");
    // A branch that is not the default one: a rescan of its head still bases on the default branch.
    git("checkout", "-q", "-b", "release", sha["branchPoint"]!);
    put("release.txt", "release\n");
    commit("release");
    git("checkout", "-q", "main");
    // A branch that changes a workflow, so zizmor has input.
    git("checkout", "-q", "-b", "workflows", sha["branchPoint"]!);
    put(".github/workflows/ci.yml", "on: push\njobs: {}\n");
    commit("workflows");
    git("checkout", "-q", "main");
  });

  afterAll(() => {
    delete process.env["FD_WORKSPACE_ROOT"];
    rmSync(root, { recursive: true, force: true });
  });

  const PIN: { digest: string; bytes: Uint8Array } = { digest: "", bytes: new Uint8Array() };
  beforeAll(async () => {
    const payload = {
      ...validPayload(),
      scanners: {
        gitleaks: { versions: "^8.18.0", exitMap: { "0": "clean", "42": "finding", "1": "tool-error" } },
        zizmor: { versions: ">=1.5.0 <2.0.0", exitMap: { "0": "clean", "11": "finding", "1": "tool-error" } },
        "osv-scanner": {
          versions: "~1.9.0",
          exitMap: { "0": "clean", "1": "finding", "127": "tool-error", "128": "nothing-in-scope" },
        },
      },
    };
    PIN.bytes = await envelopeBytes(payload, [await signingKey("k1")]);
    PIN.digest = await digestOf(PIN.bytes);
  });

  const snapshot = (lastModified = Date.now() - 3_600_000): StoredSnapshot => ({
    ecosystem: "npm",
    digest: "e".repeat(64),
    lastModified,
  });

  interface World {
    readonly pin?: string | null;
    readonly stored?: StoredBundle;
    readonly versions?: Readonly<Partial<Record<string, string>>>;
    readonly snapshots?: ReadonlyMap<string, StoredSnapshot>;
    /** Each tool's exit code by its argv's first element; 0 where unnamed. */
    readonly exits?: Readonly<Record<string, number>>;
    /** Called with each argv subprocess as it starts, while the scan's files are in place. */
    readonly onArgv?: (options: ArgvOptions) => void;
  }

  /** Runs `body` with git as the recipe runs it and the scanners answering from `world.exits`. */
  const run = async <A>(
    body: Effect.Effect<Outcome, never, A>,
    world: World = {},
  ) => {
    const ran: ArgvOptions[] = [];
    const exec = Layer.effect(
      GateExec,
      Effect.gen(function* () {
        const real = yield* GateExec;
        return {
          ...real,
          runArgv: (options: ArgvOptions) =>
            Effect.sync(() => {
              ran.push(options);
              world.onArgv?.(options);
              return {
                exit: CommandExit.Exited({ code: world.exits?.[options.argv[0]] ?? 0 }),
                output: new Uint8Array(),
              };
            }),
        };
      }),
    ).pipe(Layer.provide(processGateExec));
    const intents = fakeIntents();
    const store = memoryScanBundleStore(
      new Map([[PIN.digest, world.stored ?? PIN.bytes]] as const),
    );
    const settings = Layer.succeed(ScanSettings, {
      bundleDigest: world.pin === null ? undefined : (world.pin ?? PIN.digest),
      advisoryMaxAgeHours: 24,
      advisoryDir: "/opt/fd-scan/advisories",
    });
    const outcome = await Effect.runPromise(
      (body as Effect.Effect<Outcome, never, never>).pipe(
        Effect.provide(
          Layer.mergeAll(
            exec,
            intents.layer,
            store.layer,
            fakeScanImage(world.versions ?? IMAGE_VERSIONS, ["semgrep"]),
            memoryAdvisorySnapshots(world.snapshots ?? new Map([["npm", snapshot()]])).layer,
            settings,
          ),
        ),
      ),
    );
    const summary = intents.emitted.find((i) => i.kind === "check.summary")?.payload as
      | { name: string; head_sha: string; title: string; markdown: string }
      | undefined;
    return { outcome, ran, summary, tools: ran.map((r) => r.argv[0]) };
  };

  const gate = (head: string, base: SecurityGateInput["base"] = { _tag: "TargetBranch", branch: "main" }) =>
    runSecurityGate({ repo: origin, sha: head, ref: "refs/pull/7/head", base });
  const rescan = (head: string, ref = "refs/heads/feature") =>
    runSecurityRescan({ repo: origin, sha: head, ref });
  const logOpts = (ran: readonly ArgvOptions[]) =>
    ran.find((r) => r.argv[0] === "gitleaks")?.argv.find((a) => a.startsWith("--log-opts="));

  it("[FD-GATE-085] scans a draft pull request from dependabot[bot], running every scanner", async () => {
    const event = pullRequest("opened", { draft: true, author: "dependabot[bot]" }, origin, sha["feature"]);
    const input = Option.getOrThrow(securityGateDecoder()(event));
    const { outcome, tools } = await run(runSecurityGate(input));
    expect(tools).toEqual(["gitleaks", "osv-scanner", "semgrep"]);
    expect(outcome).toEqual(Outcome.success());
  });

  it("[FD-GATE-086] concludes success or failure on every path, never skipped", async () => {
    const outcomes = [
      await run(gate(sha["feature"]!)),
      await run(gate(sha["feature"]!), { exits: { semgrep: 1 } }),
      await run(gate(sha["feature"]!), { exits: { gitleaks: 1 } }),
      await run(gate(sha["feature"]!), { pin: null }),
      await run(gate(sha["feature"]!), { stored: "absent" }),
      await run(gate(sha["feature"]!), { stored: new TextEncoder().encode("{}") }),
      await run(gate(sha["feature"]!), { versions: { ...IMAGE_VERSIONS, gitleaks: "7.0.0" } }),
      await run(gate(sha["feature"]!), { snapshots: new Map() }),
      // An empty range: the head is the merge base, so no scanner has input.
      await run(gate(sha["branchPoint"]!)),
      await run(gate(sha["feature"]!, { _tag: "MergeGroup", baseSha: sha["branchPoint"]! })),
      await run(rescan(sha["feature"]!)),
      await run(rescan(sha["mainHead"]!, "refs/heads/main")),
      await run(rescan(sha["feature"]!), { pin: null }),
      await run(
        runSecurityRescan({ repo: join(root, "absent"), sha: sha["feature"]!, ref: "refs/heads/x" }),
      ),
    ].map((r) => r.outcome);
    expect(outcomes.map((o) => o._tag)).toEqual([
      "success",
      "failure",
      "failure",
      "failure",
      "failure",
      "failure",
      "failure",
      "failure",
      "success",
      "success",
      "success",
      "success",
      "failure",
      "failure",
    ]);
    expect(outcomes.slice(1, 8)).toEqual([
      Outcome.failure("scan: SC-28"),
      Outcome.failure("scan-error: gitleaks exit 1"),
      Outcome.failure("config: scan bundle not pinned"),
      Outcome.failure("config: scan bundle missing"),
      Outcome.failure("config: scan bundle digest"),
      Outcome.failure("config: scanner version gitleaks"),
      Outcome.failure("config: advisory snapshot missing npm"),
    ]);
    expect(outcomes.at(-1)).toEqual(Outcome.failure("infra: CheckoutFailed"));
  }, 60_000);

  it("[FD-GATE-099] lists every fact of a scan that ran in the check summary", async () => {
    const fresh = Date.now() - 3_600_000;
    const { summary, outcome } = await run(gate(sha["feature"]!), {
      snapshots: new Map([["npm", snapshot(fresh)]]),
      exits: { semgrep: 1 },
    });
    expect(outcome).toEqual(Outcome.failure("scan: SC-28"));
    const md = summary!.markdown;
    expect(summary!.title).toBe("security-gate: failure: scan: SC-28");
    expect(md).toContain(`Version \`${validPayload().version}\`, digest \`sha256:${PIN.digest}\``);
    expect(md).toContain(`| npm | \`sha256:${"e".repeat(64)}\` | ${new Date(fresh).toUTCString()} |`);
    for (const [scanner, version] of Object.entries(IMAGE_VERSIONS))
      expect(md).toContain(`| ${scanner} | \`${version}\` |`);
    expect(md).toContain("| gitleaks | clean |");
    expect(md).toContain("| zizmor | nothing-in-scope |");
    expect(md).toContain("| osv-scanner | clean |");
    expect(md).toContain("| SC-28 | finding |");
  });

  it("[FD-GATE-099] names the config reason, and what the scan did not reach, when a precondition stops it", async () => {
    const { summary } = await run(gate(sha["feature"]!), { snapshots: new Map() });
    expect(summary!.title).toBe("security-gate: failure: config: advisory snapshot missing npm");
    // The bundle and versions held before the snapshot check, so the summary still names them.
    expect(summary!.markdown).toContain(`digest \`sha256:${PIN.digest}\``);
    expect(summary!.markdown).toContain("| gitleaks | `8.18.4` |");
    expect(summary!.markdown).toContain("None: no scanner or baseline check ran.");
  });

  /** The `report` member of a scan's summary payload, as the control plane decodes it for the verdict record. */
  const reportOf = (summary: unknown): RunReport => {
    const decoded = decodeRunReport(summary);
    if (Option.isNone(decoded)) throw new Error("the summary carries no report");
    return Option.getOrThrow(decoded).report;
  };

  it("[FD-GH-096] reports the bundle digest, each snapshot digest, each scanner's version and result, and its findings", async () => {
    const { summary } = await run(gate(sha["feature"]!), { exits: { semgrep: 1 } });
    expect(reportOf(summary)).toEqual({
      scan: {
        bundle_digest: `sha256:${PIN.digest}`,
        advisory_snapshots: [{ ecosystem: "npm", digest: `sha256:${"e".repeat(64)}` }],
        scanners: [
          { name: "gitleaks", version: IMAGE_VERSIONS.gitleaks, result: "clean" },
          { name: "zizmor", version: IMAGE_VERSIONS.zizmor, result: "nothing-in-scope" },
          { name: "osv-scanner", version: IMAGE_VERSIONS["osv-scanner"], result: "clean" },
        ],
      },
      // The baseline check's finding is not a listed finding, so the empty list is not the whole of what the run found.
      findings: [],
      findingsTruncated: true,
    });

    // A scanner whose report cannot be read found findings the list does not hold.
    const unread = await run(gate(sha["feature"]!), { exits: { gitleaks: 42 } });
    expect(reportOf(unread.summary)).toMatchObject({ findings: [], findingsTruncated: true });
    expect(reportOf(unread.summary).scan?.scanners[0]).toEqual({
      name: "gitleaks",
      version: IMAGE_VERSIONS.gitleaks,
      result: "finding",
    });

    // Stopped after the bundle and versions held: no scanner result, and no finding list to read as none found.
    const stopped = reportOf((await run(gate(sha["feature"]!), { snapshots: new Map() })).summary);
    expect(stopped.scan?.bundle_digest).toBe(`sha256:${PIN.digest}`);
    expect(stopped.scan?.scanners.map((s) => s.result)).toEqual([null, null, null]);
    expect(stopped).not.toHaveProperty("findings");
    expect(stopped).not.toHaveProperty("findingsTruncated");
    // Stopped before the bundle held: no scan to report.
    expect(reportOf((await run(gate(sha["feature"]!), { pin: null })).summary)).toEqual({});
  });

  it("[FD-GATE-095] runs gitleaks and zizmor with --config files that hold the verified bundle's configurations, read-only and outside the checkout", async () => {
    const seen: Record<string, { cwd: string; config: string; text: string; mode: number }> = {};
    const { outcome, tools } = await run(gate(sha["workflows"]!), {
      onArgv: (options) => {
        const at = options.argv.indexOf("--config");
        if (options.argv[0] === "semgrep" || at === -1) return;
        const config = options.argv[at + 1]!;
        seen[options.argv[0]] = {
          cwd: options.cwd,
          config,
          text: readFileSync(config, "utf8"),
          mode: statSync(config).mode & 0o777,
        };
      },
    });
    expect(outcome).toEqual(Outcome.success());
    expect(tools).toEqual(["gitleaks", "zizmor", "semgrep"]);
    const payload = validPayload();
    expect(seen["gitleaks"]?.text).toBe(payload.gitleaks.config);
    expect(seen["zizmor"]?.text).toBe(payload.zizmor.config);
    for (const scanner of ["gitleaks", "zizmor"]) {
      const { cwd, config, mode } = seen[scanner]!;
      expect(mode & 0o222).toBe(0);
      expect(relative(cwd, config).startsWith("..")).toBe(true);
      // The configurations go when the scan ends.
      expect(existsSync(config)).toBe(false);
    }
  });

  it("[FD-GATE-111] reports security-rescan's summary under flare-dispatch/security-rescan", async () => {
    const { summary } = await run(rescan(sha["feature"]!));
    expect(summary!.name).toBe("flare-dispatch/security-rescan");
    expect(summary!.title).toBe("security-rescan: success");
  });

  it("[FD-GATE-112] bases the rescan range on the merge base of the dispatched commit and the default branch head", async () => {
    const featureRange = await run(rescan(sha["feature"]!));
    expect(logOpts(featureRange.ran)).toBe(`--log-opts=${sha["branchPoint"]}..${sha["feature"]}`);
    // The default branch head moved past the branch point; the range starts at the merge base, not at that head.
    expect(sha["mainHead"]).not.toBe(sha["branchPoint"]);
    const releaseRange = await run(rescan(sha["release"]!, "refs/heads/release"));
    expect(logOpts(releaseRange.ran)).toBe(`--log-opts=${sha["branchPoint"]}..${sha["release"]}`);
    // A rescan of the default branch head itself has an empty range.
    const head = await run(rescan(sha["mainHead"]!, "refs/heads/main"));
    expect(head.tools).toEqual(["semgrep"]);
  });

  it("[FD-GATE-112] follows the remote's default branch, not the ref the dispatch names", async () => {
    git("symbolic-ref", "HEAD", "refs/heads/release");
    try {
      const { ran } = await run(rescan(sha["feature"]!, "refs/heads/main"));
      expect(logOpts(ran)).toBe(`--log-opts=${sha["branchPoint"]}..${sha["feature"]}`);
      const { ran: onRelease } = await run(rescan(sha["mainHead"]!, "refs/heads/main"));
      expect(logOpts(onRelease)).toBe(`--log-opts=${sha["branchPoint"]}..${sha["mainHead"]}`);
    } finally {
      git("symbolic-ref", "HEAD", "refs/heads/main");
    }
  });
});

describe("the scan's report for the verdict record", () => {
  const found = (i: number): ScanFinding => ({
    scanner: "gitleaks",
    ruleId: "generic-api-key",
    path: `src/f${i}.ts`,
    startLine: i + 1,
    level: "failure",
    fingerprint: i.toString(16).padStart(64, "0"),
  });

  it("[FD-GH-096] reports at most 200 findings with ruleId, fingerprint, path, lines and level, and findingsTruncated beyond", () => {
    const step = (n: number) => ({
      id: "gitleaks",
      result: "finding" as const,
      invocation: undefined,
      exit: undefined,
      findings: StepFindings.Read({ findings: Array.from({ length: n }, (_, i) => found(i)) }),
    });
    const many = scanReport({ outcome: Outcome.failure("scan: gitleaks"), prepared: undefined, steps: [step(250)] });
    expect(many.findings).toHaveLength(REPORTED_FINDINGS_MAX);
    expect(many.findings?.[0]).toEqual({
      ruleId: "generic-api-key",
      fingerprint: "0".repeat(64),
      path: "src/f0.ts",
      startLine: 1,
      endLine: 1,
      level: "failure",
    });
    expect(many.findingsTruncated).toBe(true);
    const exactly = scanReport({ outcome: Outcome.failure("scan: gitleaks"), prepared: undefined, steps: [step(200)] });
    expect(exactly.findings).toHaveLength(200);
    expect(exactly.findingsTruncated).toBe(false);
    // The report decodes as the control plane reads it.
    expect(Option.isSome(decodeRunReport({ report: many }))).toBe(true);
  });
});
