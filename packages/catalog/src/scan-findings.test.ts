// The security gate's findings: each scanner's JSON report read into findings, each finding's fingerprint, and the
// matched values a gitleaks report holds kept out of findings, fingerprints and logs. Reports follow the JSON each
// scanner writes; subprocesses answer from a script, except where a suite runs a real process to show what reaches
// the log.
import { createHash } from "node:crypto";
import { Effect, Schema } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CommandExit, processGateExec, GateExec, type ArgvOptions } from "./command.ts";
import { ctx, fakeExec, type Scripted } from "./gate.test-support.ts";
import { Outcome } from "./reasons.ts";
import { ScanBundlePayload, type PreparedScan } from "./scan-bundle.ts";
import { validPayload } from "./scan-bundle.test-support.ts";
import type { ScanRange } from "./scan-checkout.ts";
import {
  matchedValues,
  reportJson,
  ScanFinding,
  scanFindings,
  scanLog,
  scanLogBytes,
  type StepFindings,
} from "./scan-findings.ts";
import { runScanTools, type ScanFiles } from "./scan.ts";

const DIR = "/ws/checkout";
const PLANTED = "AKIAFDSMOKEPLANTED01";
const PLANTED_LINE = `aws_access_key_id = ${PLANTED}`;

/** The sha256 of the canonical JSON `{"locator","ruleId","scanner"}`, computed apart from the implementation. */
const expectedFingerprint = (scanner: string, ruleId: string, locator: string) =>
  createHash("sha256")
    .update(
      `{"locator":${JSON.stringify(locator)},"ruleId":${JSON.stringify(ruleId)},"scanner":${JSON.stringify(scanner)}}`,
    )
    .digest("hex");

/** One gitleaks JSON report entry, as `gitleaks git --report-format json` writes it. */
const gitleaksEntry = (overrides: Record<string, unknown> = {}) => ({
  RuleID: "aws-access-token",
  Description: "Identified a pattern that may indicate AWS credentials.",
  StartLine: 3,
  EndLine: 3,
  StartColumn: 21,
  EndColumn: 40,
  Match: "REDACTED",
  Secret: "REDACTED",
  File: "config/app.conf",
  SymlinkFile: "",
  Commit: "2".repeat(40),
  Entropy: 3.6,
  Author: "dev",
  Email: "dev@example.com",
  Date: "2026-11-01T00:00:00Z",
  Message: "add config",
  Tags: [],
  Fingerprint: `${"2".repeat(40)}:config/app.conf:aws-access-token:3`,
  ...overrides,
});

/** One zizmor JSON finding, as `zizmor --format json` writes it; `row` is 0-based. */
const zizmorFinding = (ident: string, severity: string, row: number, options: { ignored?: boolean } = {}) => ({
  ident,
  desc: "a workflow weakness",
  url: `https://docs.zizmor.sh/audits/#${ident}`,
  determinations: { confidence: "High", severity, persona: "Regular" },
  locations: [
    {
      symbolic: {
        key: { Local: { prefix: null, given_path: ".github/workflows/ci.yml" } },
        annotation: "related",
        route: { components: [] },
        feature_kind: "Normal",
        kind: "Related",
      },
      concrete: {
        location: { start_point: { row: 1, column: 0 }, end_point: { row: 1, column: 9 } },
        feature: "on: push",
        comments: [],
      },
    },
    {
      symbolic: {
        key: { Local: { prefix: null, given_path: "./.github/workflows/ci.yml" } },
        annotation: "this step",
        route: { components: [] },
        feature_kind: "Normal",
        kind: "Primary",
      },
      concrete: {
        location: { start_point: { row, column: 8 }, end_point: { row, column: 30 } },
        feature: "run: echo ${{ github.event.issue.title }}",
        comments: [],
      },
    },
  ],
  ignored: options.ignored ?? false,
});

/** An OSV-Scanner JSON report, as `osv-scanner scan source --format json` writes it, with absolute source paths. */
const osvReport = () => ({
  results: [
    {
      source: { path: `${DIR}/pnpm-lock.yaml`, type: "lockfile" },
      packages: [
        {
          package: { name: "lodash", version: "4.17.20", ecosystem: "npm" },
          vulnerabilities: [
            { id: "GHSA-35jh-r3h4-6jhm", aliases: ["CVE-2021-23337"], summary: "Command injection" },
            { id: "GHSA-29mw-wpgm-hmr9", aliases: ["CVE-2020-28500"], summary: "ReDoS" },
          ],
          groups: [{ ids: ["GHSA-35jh-r3h4-6jhm"], max_severity: "7.2" }],
        },
        { package: { name: "left-pad", version: "1.3.0", ecosystem: "npm" }, vulnerabilities: [] },
      ],
    },
    {
      source: { path: `${DIR}/apps/web/package-lock.json`, type: "lockfile" },
      packages: [
        {
          package: { name: "lodash", version: "4.17.20", ecosystem: "npm" },
          vulnerabilities: [{ id: "GHSA-35jh-r3h4-6jhm" }],
        },
      ],
    },
  ],
});

const pretty = (value: unknown) => JSON.stringify(value, null, 2);

const read = (scanner: "gitleaks" | "zizmor" | "osv-scanner", output: string) =>
  Effect.runPromise(scanFindings(scanner, output, DIR));

const readFailure = (scanner: "gitleaks" | "zizmor" | "osv-scanner", output: string) =>
  Effect.runPromise(Effect.flip(scanFindings(scanner, output, DIR)));

describe("scan findings", () => {
  it("[FD-GATE-096] reports each gitleaks match with its rule id, file, start line and level", async () => {
    const findings = await read(
      "gitleaks",
      pretty([gitleaksEntry(), gitleaksEntry({ RuleID: "generic-api-key", File: "src/key.ts", StartLine: 12 })]),
    );
    expect(findings).toEqual([
      {
        scanner: "gitleaks",
        ruleId: "aws-access-token",
        path: "config/app.conf",
        startLine: 3,
        level: "failure",
        fingerprint: expectedFingerprint("gitleaks", "aws-access-token", "config/app.conf:3"),
      },
      {
        scanner: "gitleaks",
        ruleId: "generic-api-key",
        path: "src/key.ts",
        startLine: 12,
        level: "failure",
        fingerprint: expectedFingerprint("gitleaks", "generic-api-key", "src/key.ts:12"),
      },
    ]);
    for (const f of findings) expect(Schema.is(ScanFinding)(f)).toBe(true);
  });

  it("[FD-GATE-096] reports each zizmor finding with its audit id, primary location and severity level", async () => {
    const findings = await read(
      "zizmor",
      pretty([
        zizmorFinding("template-injection", "High", 14),
        zizmorFinding("artipacked", "Medium", 9),
        zizmorFinding("unpinned-uses", "Low", 20),
        zizmorFinding("excessive-permissions", "High", 4, { ignored: true }),
      ]),
    );
    expect(findings.map(({ fingerprint: _, ...f }) => f)).toEqual([
      { scanner: "zizmor", ruleId: "template-injection", path: ".github/workflows/ci.yml", startLine: 15, level: "failure" },
      { scanner: "zizmor", ruleId: "artipacked", path: ".github/workflows/ci.yml", startLine: 10, level: "warning" },
      { scanner: "zizmor", ruleId: "unpinned-uses", path: ".github/workflows/ci.yml", startLine: 21, level: "notice" },
    ]);
  });

  it("[FD-GATE-096] reports each OSV advisory against its lockfile, relative to the checkout", async () => {
    const findings = await read("osv-scanner", pretty(osvReport()));
    expect(findings.map(({ fingerprint: _, ...f }) => f)).toEqual([
      { scanner: "osv-scanner", ruleId: "GHSA-35jh-r3h4-6jhm", path: "pnpm-lock.yaml", startLine: 1, level: "failure" },
      { scanner: "osv-scanner", ruleId: "GHSA-29mw-wpgm-hmr9", path: "pnpm-lock.yaml", startLine: 1, level: "failure" },
      {
        scanner: "osv-scanner",
        ruleId: "GHSA-35jh-r3h4-6jhm",
        path: "apps/web/package-lock.json",
        startLine: 1,
        level: "failure",
      },
    ]);
  });

  it("[FD-GATE-096] reads the report out of output that interleaves it with the scanner's log lines", async () => {
    const output = [
      "\u001b[2m2026-11-12T00:00:00Z\u001b[0m  INFO zizmor: collected 1 input",
      pretty([zizmorFinding("template-injection", "High", 14)]),
      "\u001b[2m2026-11-12T00:00:01Z\u001b[0m  INFO zizmor: 1 finding [ignored: 0, suppressed: 0]",
      "",
    ].join("\n");
    expect((await read("zizmor", output)).map((f) => f.ruleId)).toEqual(["template-injection"]);
    expect(reportJson(`Scanning dir ${DIR}\n${pretty(osvReport())}\nDone {1 lockfile}\n`)).toEqual(osvReport());
  });

  it("[FD-GATE-096] fails with ScanReportUnreadable where the output holds no report of the scanner's shape", async () => {
    expect((await readFailure("gitleaks", "8:52AM INF 1 commits scanned.\n8:52AM WRN leaks found: 1\n"))._tag).toBe(
      "ScanReportUnreadable",
    );
    const wrongShape = await readFailure("zizmor", pretty([{ ident: "template-injection" }]));
    expect(wrongShape).toMatchObject({ scanner: "zizmor", detail: "report does not match the zizmor schema" });
  });

  it("[FD-GATE-097] sets each fingerprint to the SHA-256 of the canonical JSON of scanner, ruleId and locator", async () => {
    const [gitleaks] = await read("gitleaks", pretty([gitleaksEntry()]));
    expect(gitleaks!.fingerprint).toBe(expectedFingerprint("gitleaks", "aws-access-token", "config/app.conf:3"));

    const [zizmor] = await read("zizmor", pretty([zizmorFinding("template-injection", "High", 14)]));
    expect(zizmor!.fingerprint).toBe(
      expectedFingerprint("zizmor", "template-injection", ".github/workflows/ci.yml:15"),
    );

    const osv = await read("osv-scanner", pretty(osvReport()));
    expect(osv.map((f) => f.fingerprint)).toEqual([
      expectedFingerprint("osv-scanner", "GHSA-35jh-r3h4-6jhm", "pnpm-lock.yaml:lodash@4.17.20"),
      expectedFingerprint("osv-scanner", "GHSA-29mw-wpgm-hmr9", "pnpm-lock.yaml:lodash@4.17.20"),
      expectedFingerprint("osv-scanner", "GHSA-35jh-r3h4-6jhm", "apps/web/package-lock.json:lodash@4.17.20"),
    ]);
  });

  it("[FD-GATE-097] gives the same rule at the same locator one fingerprint, and another scanner or line another", async () => {
    const findings = await read(
      "gitleaks",
      pretty([
        gitleaksEntry(),
        gitleaksEntry({ Commit: "3".repeat(40), Fingerprint: "other", Date: "2026-11-02T00:00:00Z" }),
        gitleaksEntry({ StartLine: 4 }),
      ]),
    );
    expect(findings.map((f) => f.startLine)).toEqual([3, 4]);
    expect(new Set(findings.map((f) => f.fingerprint)).size).toBe(2);
    expect(expectedFingerprint("zizmor", "aws-access-token", "config/app.conf:3")).not.toBe(findings[0]!.fingerprint);
  });
});

describe("matched values", () => {
  it("[FD-GATE-098] derives no fingerprint from, and writes no finding with, a matched secret's value", async () => {
    const redacted = await read("gitleaks", pretty([gitleaksEntry()]));
    const unredacted = await read(
      "gitleaks",
      pretty([gitleaksEntry({ Secret: PLANTED, Match: PLANTED_LINE })]),
    );
    const otherValue = await read(
      "gitleaks",
      pretty([gitleaksEntry({ Secret: "AKIAFDSMOKEOTHER0002", Match: "key = AKIAFDSMOKEOTHER0002" })]),
    );
    expect(unredacted).toEqual(redacted);
    expect(otherValue).toEqual(redacted);
    expect(JSON.stringify(unredacted)).not.toContain(PLANTED);
    expect(Object.keys(unredacted[0]!).sort()).toEqual(
      ["fingerprint", "level", "path", "ruleId", "scanner", "startLine"],
    );
  });

  it("[FD-GATE-098] withholds every matched value from a scanner's log, in the report and wherever the output repeats it", () => {
    const short = "pw=ab1";
    const output = [
      "8:52AM INF scanning",
      `Finding:     ${PLANTED_LINE}`,
      `Secret:      ${PLANTED}`,
      pretty([
        gitleaksEntry({ Secret: PLANTED, Match: PLANTED_LINE }),
        gitleaksEntry({ RuleID: "generic-password", Secret: short, Match: `"${short}"`, StartLine: 9 }),
      ]),
      "8:52AM WRN leaks found: 2",
    ].join("\n");
    expect(matchedValues(output)).toContain(PLANTED);
    const log = scanLog(output);
    expect(log).not.toContain(PLANTED);
    expect(log).not.toContain(short);
    expect(log).toContain('"Secret": "REDACTED"');
    expect(log).toContain('"Match": "REDACTED"');
    expect(log).toContain('"RuleID": "generic-password"');
    expect(log).toContain("8:52AM WRN leaks found: 2");

    // A report the output limit cut short still has its members withheld.
    const whole = pretty([gitleaksEntry({ Secret: "ghx-not-a-token-shape", Match: "x" })]);
    const truncated = whole.slice(0, whole.indexOf('"File"'));
    expect(matchedValues(truncated)).toEqual([]);
    expect(scanLog(truncated)).not.toContain("ghx-not-a-token-shape");
  });
});

const FILES: ScanFiles = {
  gitleaksConfig: "/opt/fd-scan/bundle/gitleaks.toml",
  zizmorConfig: "/opt/fd-scan/bundle/zizmor.yml",
  advisoryDir: "/opt/fd-scan/advisories",
};

const prepared = (): PreparedScan => ({
  bundle: {
    digest: "d".repeat(64),
    envelope: { payloadType: "application/vnd.flare-dispatch.scan-bundle.v1+json", payload: "", signatures: [] },
    payload: Schema.decodeUnknownSync(ScanBundlePayload)({
      ...validPayload(),
      scanners: {
        gitleaks: { versions: "^8.18.0", exitMap: { "0": "clean", "42": "finding", "1": "tool-error" } },
        zizmor: { versions: ">=1.5.0 <2.0.0", exitMap: { "0": "clean", "14": "finding", "1": "tool-error" } },
        "osv-scanner": { versions: "~1.9.0", exitMap: { "0": "clean", "1": "finding", "127": "tool-error" } },
      },
      baselineChecks: [
        {
          controlId: "SC-28",
          rule: "no plaintext secrets in config",
          tool: "semgrep",
          argv: ["semgrep", "--config", "p/secrets", "--error", "."],
          exitMap: { "0": "clean", "1": "finding" },
        },
      ],
    }),
  },
  versions: { gitleaks: "8.18.4", zizmor: "1.6.0", "osv-scanner": "1.9.2" },
  snapshots: {},
});

const RANGE: ScanRange = {
  base: "1".repeat(40),
  head: "2".repeat(40),
  commits: ["2".repeat(40)],
  changed: [".github/workflows/ci.yml", "pnpm-lock.yaml"],
  scannable: [".github/workflows/ci.yml", "pnpm-lock.yaml"],
};

const scan = (script: readonly Scripted[]) => {
  const exec = fakeExec(script);
  return Effect.runPromise(
    runScanTools({ ctx, prepared: prepared(), checkout: { dir: DIR, range: RANGE }, files: FILES }).pipe(
      Effect.provide(exec.layer),
    ),
  ).then((report) => ({ ...report, exec }));
};

describe("scan steps", () => {
  it("[FD-GATE-096] reports the findings of every scanner whose result is finding, and none for a clean one", async () => {
    const { steps } = await scan([
      {
        match: "gitleaks git",
        exit: CommandExit.Exited({ code: 42 }),
        output: `8:52AM INF 1 commits scanned.\n${pretty([gitleaksEntry({ Secret: PLANTED, Match: PLANTED_LINE })])}\n`,
      },
      { match: "zizmor", exit: CommandExit.Exited({ code: 0 }), output: "[]" },
      { match: "osv-scanner", exit: CommandExit.Exited({ code: 1 }), output: pretty(osvReport()) },
      { match: "semgrep", exit: CommandExit.Exited({ code: 1 }), output: pretty([gitleaksEntry()]) },
    ]);
    const byId: Record<string, StepFindings | undefined> = Object.fromEntries(
      steps.map((s) => [s.id, s.findings]),
    );
    expect(byId["gitleaks"]).toMatchObject({
      _tag: "Read",
      findings: [{ scanner: "gitleaks", ruleId: "aws-access-token", path: "config/app.conf", startLine: 3 }],
    });
    expect(byId["osv-scanner"]).toMatchObject({ _tag: "Read" });
    expect(byId["zizmor"]).toBeUndefined();
    expect(byId["SC-28"]).toBeUndefined();
    expect(JSON.stringify(steps)).not.toContain(PLANTED);
  });

  it("[FD-GATE-096] reports an unreadable report as unreadable, never as no findings", async () => {
    const { steps, outcome } = await scan([
      { match: "gitleaks git", exit: CommandExit.Exited({ code: 42 }), output: "8:52AM WRN leaks found: 1\n" },
    ]);
    expect(steps.find((s) => s.id === "gitleaks")?.findings).toEqual(
      expect.objectContaining({ _tag: "Unreadable", detail: "no JSON report in the output" }),
    );
    expect(outcome).toEqual(Outcome.failure("scan: gitleaks"));
  });

  it("[FD-GATE-098] runs every scanner with a log that withholds matched values, and leaves baseline checks live", async () => {
    const { exec } = await scan([]);
    const byTool = new Map<string, ArgvOptions>(exec.ranArgv.map((o) => [o.argv[0], o]));
    for (const scanner of ["gitleaks", "zizmor", "osv-scanner"]) expect(byTool.get(scanner)?.logAs).toBe(scanLogBytes);
    expect(byTool.get("semgrep")?.logAs).toBeUndefined();
  });
});

describe("scan logs", () => {
  afterEach(() => vi.restoreAllMocks());

  it("[FD-GATE-098] writes a scanner's output to the log only as logAs rewrites it, after the process ends", async () => {
    const written: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      written.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
      return true;
    });
    const report = JSON.stringify([gitleaksEntry({ Secret: PLANTED, Match: PLANTED_LINE })]);
    const run = await Effect.runPromise(
      Effect.gen(function* () {
        const exec = yield* GateExec;
        return yield* exec.runArgv({
          argv: ["/bin/sh", "-c", `echo "Secret: ${PLANTED}" >&2; printf '%s\\n' '${report}'`],
          cwd: process.cwd(),
          env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin" },
          timeoutMs: 10_000,
          logAs: scanLogBytes,
        });
      }).pipe(Effect.provide(processGateExec)),
    );
    vi.restoreAllMocks();
    expect(run.exit).toEqual(CommandExit.Exited({ code: 0 }));
    const log = written.join("");
    expect(log).toContain('"Secret":"REDACTED"');
    expect(log).toContain("aws-access-token");
    expect(log).not.toContain(PLANTED);
  });
});
