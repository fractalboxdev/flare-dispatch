// The security gate's scan: each scanner's invocation on its scope, the baseline checks' argv, the exit maps and the
// verdict the scan results conclude. Subprocesses answer from a script, except where a suite runs a real checkout or a
// real process to show what the scope and the argv hold.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Effect, Schema } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CommandExit, processGateExec } from "./command.ts";
import { ctx, fakeExec, type Scripted } from "./gate.test-support.ts";
import { Outcome } from "./reasons.ts";
import { ScanBundlePayload, type PreparedScan } from "./scan-bundle.ts";
import { validPayload } from "./scan-bundle.test-support.ts";
import { prepareScanCheckout, ScanBase, type ScanRange } from "./scan-checkout.ts";
import {
  OSV_DB_ENV,
  runScanTools,
  scannerInvocation,
  scanVerdict,
  type ScanFiles,
  type ScanStep,
} from "./scan.ts";

const BASE = "1".repeat(40);
const HEAD = "2".repeat(40);
const DIR = "/ws/checkout";

const FILES: ScanFiles = {
  gitleaksConfig: "/opt/fd-scan/bundle/gitleaks.toml",
  zizmorConfig: "/opt/fd-scan/bundle/zizmor.yml",
  advisoryDir: "/opt/fd-scan/advisories",
};

/** A bundle with the exit maps of specs/runs/gate.md § Security gate and two baseline checks. */
const payload = (): ScanBundlePayload =>
  Schema.decodeUnknownSync(ScanBundlePayload)({
    ...validPayload(),
    scanners: {
      gitleaks: { versions: "^8.18.0", exitMap: { "0": "clean", "42": "finding", "1": "tool-error" } },
      zizmor: {
        versions: ">=1.5.0 <2.0.0",
        exitMap: {
          "0": "clean",
          "11": "finding",
          "12": "finding",
          "13": "finding",
          "14": "finding",
          "1": "tool-error",
          "2": "tool-error",
          "3": "tool-error",
        },
      },
      "osv-scanner": {
        versions: "~1.9.0",
        exitMap: { "0": "clean", "1": "finding", "127": "tool-error", "128": "nothing-in-scope" },
      },
    },
    baselineChecks: [
      {
        controlId: "SC-28",
        rule: "no plaintext secrets in config",
        tool: "semgrep",
        argv: ["semgrep", "--config", "p/secrets", "--error", "."],
        exitMap: { "0": "clean", "1": "finding" },
      },
      {
        controlId: "AC-6",
        rule: "least privilege in workflows",
        tool: "conftest",
        argv: ["conftest", "test", "--policy", "/opt/policy", ".github/workflows"],
        exitMap: { "0": "clean", "1": "finding", "2": "tool-error" },
      },
    ],
  });

const prepared = (p: ScanBundlePayload = payload()): PreparedScan => ({
  bundle: {
    digest: "d".repeat(64),
    envelope: { payloadType: "application/vnd.flare-dispatch.scan-bundle.v1+json", payload: "", signatures: [] },
    payload: p,
  },
  versions: { gitleaks: "8.18.4", zizmor: "1.6.0", "osv-scanner": "1.9.2" },
  snapshots: {},
});

/** A range whose every scanner has input: commits, a workflow and a lockfile. */
const fullRange = (scannable: readonly string[] = [".github/workflows/ci.yml", "pnpm-lock.yaml"]): ScanRange => ({
  base: BASE,
  head: HEAD,
  commits: [HEAD],
  changed: scannable,
  scannable,
});

const exited = (code: number) => CommandExit.Exited({ code });

/** Runs the scan with each tool's exit scripted by its argv's first words. */
const scan = (script: readonly Scripted[], range: ScanRange = fullRange(), p?: ScanBundlePayload) => {
  const exec = fakeExec(script);
  return Effect.runPromise(
    runScanTools({ ctx, prepared: prepared(p), checkout: { dir: DIR, range }, files: FILES }).pipe(
      Effect.provide(exec.layer),
    ),
  ).then((report) => ({ ...report, exec, ran: exec.ranArgv.map((r) => r.argv[0]) }));
};

const byId = (steps: readonly ScanStep[]) => Object.fromEntries(steps.map((s) => [s.id, s.result]));

describe("security-gate scanner invocations", () => {
  it("[FD-GATE-095] runs gitleaks on every commit of the range with exactly the table's invocation", async () => {
    const { exec } = await scan([]);
    const gitleaks = exec.ranArgv.find((r) => r.argv[0] === "gitleaks")!;
    expect(gitleaks.argv).toEqual([
      "gitleaks",
      "git",
      `--log-opts=${BASE}..${HEAD}`,
      "--config",
      FILES.gitleaksConfig,
      "--ignore-gitleaks-allow",
      "--redact=100",
      "--exit-code",
      "42",
      "--report-format",
      "json",
    ]);
    expect(gitleaks.cwd).toBe(DIR);
  });

  it("[FD-GATE-095] runs zizmor offline with the bundle config on each workflow and action file the range changes", async () => {
    const changed = [
      ".github/workflows/ci.yml",
      ".github/workflows/release.yaml",
      ".github/workflows/nested/not-a-workflow.yml",
      ".github/actions/setup/action.yml",
      "action.yaml",
      "-odd/action.yml",
      "docs/workflow.yml",
      "src/index.ts",
    ];
    const invocation = scannerInvocation("zizmor", fullRange(changed), FILES)!;
    expect(invocation.argv).toEqual([
      "zizmor",
      "--offline",
      "--no-progress",
      "--format",
      "json",
      "--config",
      FILES.zizmorConfig,
      ".github/workflows/ci.yml",
      ".github/workflows/release.yaml",
      ".github/actions/setup/action.yml",
      "action.yaml",
      "./-odd/action.yml",
    ]);
    expect(invocation.argv).not.toContain("--no-ignores");
    expect(invocation.env).toEqual({});
  });

  it("[FD-GATE-095] runs OSV-Scanner offline on each changed lockfile with the snapshot as its local database", async () => {
    const changed = ["pnpm-lock.yaml", "svc/Cargo.lock", "svc/osv-scanner.toml", "go.sum", "package.json"];
    const { exec } = await scan([], fullRange(changed));
    const osv = exec.ranArgv.find((r) => r.argv[0] === "osv-scanner")!;
    expect(osv.argv).toEqual([
      "osv-scanner",
      "scan",
      "source",
      "--offline-vulnerabilities",
      "--format",
      "json",
      "-L",
      "pnpm-lock.yaml",
      "-L",
      "svc/Cargo.lock",
    ]);
    expect(osv.argv).not.toContain("--download-offline-databases");
    expect(osv.argv).not.toContain("--config");
    expect(osv.env[OSV_DB_ENV]).toBe(FILES.advisoryDir);
    expect(osv.cwd).toBe(DIR);
    expect(exec.ranArgv.find((r) => r.argv[0] === "gitleaks")!.env[OSV_DB_ENV]).toBeUndefined();
  });

  it("[FD-GATE-095] runs every scanner as an argv with no shell", async () => {
    const { exec } = await scan([], fullRange(["pnpm-lock.yaml", ".github/workflows/$(touch x).yml"]));
    expect(exec.ran).toEqual([]);
    expect(exec.ranArgv.find((r) => r.argv[0] === "zizmor")!.argv.at(-1)).toBe(
      ".github/workflows/$(touch x).yml",
    );
  });
});

describe("security-gate scan scope from a real checkout", () => {
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
    root = mkdtempSync(join(tmpdir(), "fd-scan-scope-"));
    process.env["FD_WORKSPACE_ROOT"] = root;
    origin = join(root, "origin");
    mkdirSync(origin);
    git("init", "-q", "-b", "main");
    put("old/package-lock.json", "{}\n");
    put(".github/workflows/ci.yml", "on: push\n");
    commit("base");
    git("checkout", "-q", "-b", "feature");
    unlinkSync(join(origin, "old/package-lock.json"));
    put("src/a.ts", "export {};\n");
    symlinkSync("../outside.yml", join(origin, "action.yml"));
    commit("code");
  });

  afterAll(() => {
    delete process.env["FD_WORKSPACE_ROOT"];
    rmSync(root, { recursive: true, force: true });
  });

  const rangeOf = (head: string) =>
    Effect.runPromise(
      Effect.scoped(
        prepareScanCheckout(
          { repo: origin, sha: head, ref: "refs/pull/1/head" },
          ScanBase.TargetBranch({ branch: "main" }),
          validPayload().suppression,
        ).pipe(Effect.map((c) => c.range)),
      ).pipe(Effect.provide(processGateExec)),
    );

  it("[FD-GATE-088] records nothing-in-scope with no invocation for zizmor and OSV-Scanner when the range changes no input", async () => {
    // The range deletes a lockfile and adds a symbolic link named action.yml: neither is a file a scanner reads.
    const range = await rangeOf(sha["code"]!);
    expect(range.scannable).toEqual(["src/a.ts"]);
    const { steps, ran, outcome } = await scan([], range);
    expect(byId(steps)).toMatchObject({ zizmor: "nothing-in-scope", "osv-scanner": "nothing-in-scope" });
    expect(steps.find((s) => s.id === "zizmor")!.invocation).toBeUndefined();
    expect(ran).toEqual(["gitleaks", "semgrep", "conftest"]);
    expect(outcome).toEqual(Outcome.success());
  });

  it("[FD-GATE-088] records nothing-in-scope with no invocation for gitleaks when the range holds no commit", async () => {
    const range = await rangeOf(sha["base"]!);
    expect(range.commits).toEqual([]);
    const { steps, ran } = await scan([], range);
    expect(byId(steps)).toMatchObject({
      gitleaks: "nothing-in-scope",
      zizmor: "nothing-in-scope",
      "osv-scanner": "nothing-in-scope",
    });
    expect(steps.map((s) => s.exit)).toEqual([undefined, undefined, undefined, exited(0), exited(0)]);
    expect(ran).toEqual(["semgrep", "conftest"]);
  });
});

describe("security-gate baseline checks", () => {
  it("[FD-GATE-108] runs each baseline check's argv in the checkout with a 600 s job timeout", async () => {
    const { exec } = await scan([]);
    const checks = exec.ranArgv.filter((r) => r.argv[0] === "semgrep" || r.argv[0] === "conftest");
    expect(checks.map((r) => r.argv)).toEqual([
      ["semgrep", "--config", "p/secrets", "--error", "."],
      ["conftest", "test", "--policy", "/opt/policy", ".github/workflows"],
    ]);
    for (const check of checks) {
      expect(check.cwd).toBe(DIR);
      expect(check.timeoutMs).toBe(600_000);
    }
    expect(exec.ran).toEqual([]);
  });

  it("[FD-GATE-108] passes each argv element to the tool as one argument, with no shell", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fd-scan-argv-"));
    try {
      const script =
        "require('fs').writeFileSync('argv.json', JSON.stringify(process.argv.slice(1)))";
      const args = ["$(touch pwned)", "a b", "*", "; touch also"];
      const p = payload();
      const custom: ScanBundlePayload = {
        ...p,
        baselineChecks: [
          { controlId: "CM-7", rule: "argv", tool: "node", argv: ["node", "-e", script, ...args], exitMap: { "0": "clean" } },
        ],
      };
      const empty: ScanRange = { base: BASE, head: BASE, commits: [], changed: [], scannable: [] };
      const report = await Effect.runPromise(
        runScanTools({ ctx, prepared: prepared(custom), checkout: { dir, range: empty }, files: FILES }).pipe(
          Effect.provide(processGateExec),
        ),
      );
      expect(JSON.parse(readFileSync(join(dir, "argv.json"), "utf8"))).toEqual(args);
      expect(existsSync(join(dir, "pwned"))).toBe(false);
      expect(existsSync(join(dir, "also"))).toBe(false);
      expect(report.outcome).toEqual(Outcome.success());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("security-gate scan verdict", () => {
  it("[FD-GATE-087] runs every scanner and baseline check after the first one reports a finding", async () => {
    const { ran, steps } = await scan([
      { match: "gitleaks git", exit: exited(42) },
      { match: "zizmor", exit: exited(13) },
    ]);
    expect(ran).toEqual(["gitleaks", "zizmor", "osv-scanner", "semgrep", "conftest"]);
    expect(byId(steps)).toEqual({
      gitleaks: "finding",
      zizmor: "finding",
      "osv-scanner": "clean",
      "SC-28": "clean",
      "AC-6": "clean",
    });
  });

  it("[FD-GATE-087] runs every baseline check after a scanner's tool error", async () => {
    const { ran } = await scan([{ match: "osv-scanner", exit: exited(127) }]);
    expect(ran).toEqual(["gitleaks", "zizmor", "osv-scanner", "semgrep", "conftest"]);
  });

  it("[FD-GATE-089] records success when every result is clean or nothing-in-scope, including OSV-Scanner exit 128", async () => {
    const { outcome, steps } = await scan([{ match: "osv-scanner", exit: exited(128) }]);
    expect(byId(steps)).toEqual({
      gitleaks: "clean",
      zizmor: "clean",
      "osv-scanner": "nothing-in-scope",
      "SC-28": "clean",
      "AC-6": "clean",
    });
    expect(outcome).toEqual(Outcome.success());
  });

  it("[FD-GATE-090] records scan-error for an exit that maps to tool-error, ahead of a scan reason", async () => {
    const { outcome } = await scan([
      { match: "gitleaks git", exit: exited(42) },
      { match: "zizmor", exit: exited(2) },
      { match: "semgrep", exit: exited(1) },
    ]);
    expect(outcome).toEqual(Outcome.failure("scan-error: zizmor exit 2"));
  });

  it("[FD-GATE-090] records scan-error for an exit absent from the scanner's or baseline check's exit map", async () => {
    expect((await scan([{ match: "gitleaks git", exit: exited(7) }])).outcome).toEqual(
      Outcome.failure("scan-error: gitleaks exit 7"),
    );
    expect((await scan([{ match: "semgrep", exit: exited(3) }])).outcome).toEqual(
      Outcome.failure("scan-error: SC-28 exit 3"),
    );
    expect(
      (await scan([{ match: "conftest", exit: exited(2) }, { match: "zizmor", exit: exited(14) }])).outcome,
    ).toEqual(Outcome.failure("scan-error: AC-6 exit 2"));
  });

  it("[FD-GATE-090] names the first tool error in run order", () => {
    const step = (id: string, reason: `scan-error: ${string}`): ScanStep => ({
      id,
      result: "tool-error",
      reason,
      invocation: undefined,
      exit: undefined,
    });
    expect(
      scanVerdict([
        { id: "gitleaks", result: "finding", invocation: undefined, exit: undefined },
        step("osv-scanner", "scan-error: osv-scanner exit 127"),
        step("SC-28", "scan-error: SC-28 exit 9"),
      ]),
    ).toEqual(Outcome.failure("scan-error: osv-scanner exit 127"));
  });

  it("[FD-GATE-091] records scan with every scanner and control id that reports a finding", async () => {
    const { outcome } = await scan([
      { match: "gitleaks git", exit: exited(42) },
      { match: "osv-scanner", exit: exited(1) },
      { match: "conftest", exit: exited(1) },
    ]);
    expect(outcome).toEqual(Outcome.failure("scan: gitleaks, osv-scanner, AC-6"));
  });

  it("[FD-GATE-091] records scan for a lone baseline-check finding", async () => {
    const { outcome } = await scan([{ match: "semgrep", exit: exited(1) }]);
    expect(outcome).toEqual(Outcome.failure("scan: SC-28"));
  });

  it("a subprocess that ends without an exit code is a tool error with its job reason", async () => {
    const { outcome, steps } = await scan([
      { match: "gitleaks git", exit: exited(42) },
      { match: "semgrep", exit: CommandExit.TimedOut() },
    ]);
    expect(byId(steps)["SC-28"]).toBe("tool-error");
    expect(outcome).toEqual(Outcome.failure("timeout: job"));
  });
});
