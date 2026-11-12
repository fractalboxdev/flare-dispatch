// The security gate's scan (specs/runs/gate.md § Security gate, steps 5 and 6): gitleaks, zizmor and OSV-Scanner, each
// with the invocation the scanner table gives on the scope it names (FD-GATE-095), then each baseline check's argv
// (FD-GATE-108). Every one runs whatever an earlier one reported (FD-GATE-087); a scanner whose scope is empty records
// `nothing-in-scope` and is not invoked (FD-GATE-088). Each exit maps through the bundle's exit map to one scan
// result, and the results conclude the scan: `success` when every result is `clean` or `nothing-in-scope`
// (FD-GATE-089), otherwise `failure` with a `scan-error` reason ahead of a `scan` reason (FD-GATE-090, FD-GATE-091).
// No path concludes `skipped`.
//
// Every subprocess runs as an argv with no shell, so no path the range names is word-split or expanded.
import { Effect, Match } from "effect";
import { CommandExit, GateExec, type ArgvOptions } from "./command.ts";
import { jobEnv } from "./job.ts";
import type { GateContext } from "./manifest.ts";
import { Outcome, ScanReason, type Reason } from "./reasons.ts";
import {
  lockfileEcosystem,
  SCANNERS,
  type BaselineCheck,
  type PreparedScan,
  type Scanner,
  type ScanResult,
} from "./scan-bundle.ts";
import type { ScanRange } from "./scan-checkout.ts";
import { verdictOf } from "./verdict.ts";

/** A bundle exit map: each exit code, as a decimal string, to its scan result. */
type ExitMap = Readonly<Record<string, ScanResult>>;

/** The job timeout of each scanner and baseline check (FD-GATE-108). */
export const SCAN_TIMEOUT_SEC = 600;

/** The environment variable that points OSV-Scanner at the advisory snapshot. */
export const OSV_DB_ENV = "OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY";

/**
 * Where the executor placed the scan bundle's scanner configurations and the advisory snapshot: read-only paths
 * outside the checkout (FD-GATE-104).
 */
export interface ScanFiles {
  /** The bundle's `gitleaks.config` as a file. */
  readonly gitleaksConfig: string;
  /** The bundle's `zizmor.config` as a file. */
  readonly zizmorConfig: string;
  /** The directory OSV-Scanner reads the advisory snapshot from. */
  readonly advisoryDir: string;
}

/** One subprocess the scan runs: its argv and the variables it adds to the job environment. */
export interface ScanInvocation {
  readonly argv: readonly [string, ...string[]];
  readonly env: Readonly<Record<string, string>>;
}

/** A scan result, with the `failure` reason a `tool-error` records. */
export type ScanResultOf =
  | { readonly result: Exclude<ScanResult, "tool-error"> }
  | { readonly result: "tool-error"; readonly reason: Reason };

/** What one scanner or baseline check reported. */
export type ScanStep = ScanResultOf & {
  /** The scanner's name, or the baseline check's `controlId`. */
  readonly id: string;
  /** The subprocess, or `undefined` for a scanner with no input in the scan range. */
  readonly invocation: ScanInvocation | undefined;
  /** How the subprocess ended, or `undefined` where nothing ran. */
  readonly exit: CommandExit | undefined;
};

/** A scan's results in the order they ran, and the outcome they conclude. */
export interface ScanReport {
  readonly steps: readonly ScanStep[];
  readonly outcome: Outcome;
}

/** Whether `path` is a workflow GitHub reads, or an action definition. */
export const isWorkflowOrAction = (path: string): boolean =>
  /^\.github\/workflows\/[^/]+\.ya?ml$/.test(path) || /(^|\/)action\.ya?ml$/.test(path);

/** A path as one argument no option parser reads as a flag. */
const operand = (path: string): string => (path.startsWith("-") ? `./${path}` : path);

/**
 * Each scanner's invocation on its scope (specs/runs/gate.md § Security gate, scanner table), or `undefined` where the
 * scope is empty: gitleaks on every commit of the range, zizmor on each workflow and action file the range changes,
 * OSV-Scanner on each lockfile the range changes.
 */
export const scannerInvocation = (
  scanner: Scanner,
  range: Pick<ScanRange, "base" | "head" | "commits" | "scannable">,
  files: ScanFiles,
): ScanInvocation | undefined =>
  Match.value(scanner).pipe(
    Match.when("gitleaks", (): ScanInvocation | undefined =>
      range.commits.length === 0
        ? undefined
        : {
            argv: [
              "gitleaks",
              "git",
              `--log-opts=${range.base}..${range.head}`,
              "--config",
              files.gitleaksConfig,
              "--ignore-gitleaks-allow",
              "--redact=100",
              "--exit-code",
              "42",
              "--report-format",
              "json",
            ],
            env: {},
          },
    ),
    Match.when("zizmor", () => {
      const workflows = range.scannable.filter(isWorkflowOrAction);
      return workflows.length === 0
        ? undefined
        : {
            argv: [
              "zizmor",
              "--offline",
              "--no-progress",
              "--format",
              "json",
              "--config",
              files.zizmorConfig,
              ...workflows.map(operand),
            ] as const,
            env: {},
          };
    }),
    Match.when("osv-scanner", () => {
      const lockfiles = range.scannable.filter((p) => lockfileEcosystem(p) !== undefined);
      return lockfiles.length === 0
        ? undefined
        : {
            argv: [
              "osv-scanner",
              "scan",
              "source",
              "--offline-vulnerabilities",
              "--format",
              "json",
              ...lockfiles.flatMap((p) => ["-L", operand(p)]),
            ] as const,
            env: { [OSV_DB_ENV]: files.advisoryDir },
          };
    }),
    Match.exhaustive,
  );

/**
 * The scan result of one subprocess's end: an exit code reads through `exitMap`, and a code it does not list is a
 * tool error. An end with no exit code, at a signal, the job timeout, the deadline or the output limit, is a tool error
 * with that end's job reason (specs/runs/gate.md § Exit to verdict).
 */
export const resultOf = (id: string, exitMap: ExitMap, exit: CommandExit): ScanResultOf =>
  Match.value(exit).pipe(
    Match.tag("Exited", ({ code }): ScanResultOf => {
      const key = String(code);
      const result = Object.hasOwn(exitMap, key) ? exitMap[key] : undefined;
      return result === undefined || result === "tool-error"
        ? { result: "tool-error", reason: ScanReason.error(id, code) }
        : { result };
    }),
    Match.orElse(
      (ended): ScanResultOf => ({ result: "tool-error", reason: failureReason(verdictOf(ended)) }),
    ),
  );

/** A job end's `failure` reason; `verdictOf` gives every end without an exit code one. */
const failureReason = (outcome: Outcome): Reason =>
  Match.value(outcome).pipe(
    Match.tag("failure", ({ reason }) => reason),
    Match.orElse(() => "infra" as const),
  );

/**
 * The outcome scan results conclude (FD-GATE-089 to FD-GATE-091): the first `tool-error`'s reason, else `scan:` with
 * every id whose result is `finding`, else `success`. It never concludes `skipped`.
 */
export const scanVerdict = (steps: readonly ScanStep[]): Outcome => {
  for (const step of steps) if (step.result === "tool-error") return Outcome.failure(step.reason);
  const findings = steps.filter((s) => s.result === "finding").map((s) => s.id);
  return findings.length > 0 ? Outcome.failure(ScanReason.finding(findings)) : Outcome.success();
};

/** A baseline check's invocation: its argv as the bundle gives it, whose first element is its tool. */
export const baselineInvocation = (check: BaselineCheck): ScanInvocation => ({
  argv: [check.tool, ...check.argv.slice(1)],
  env: {},
});

export interface ScanToolsInput {
  readonly ctx: GateContext;
  readonly prepared: PreparedScan;
  /** The prepared checkout's directory and scan range. */
  readonly checkout: { readonly dir: string; readonly range: ScanRange };
  readonly files: ScanFiles;
}

/**
 * Runs every scanner and then every baseline check in the checkout, each with the job timeout of
 * `SCAN_TIMEOUT_SEC`, and concludes from their results.
 */
export const runScanTools = (input: ScanToolsInput): Effect.Effect<ScanReport, never, GateExec> =>
  Effect.gen(function* () {
    const exec = yield* GateExec;
    const { ctx, prepared, checkout, files } = input;
    const run = (id: string, invocation: ScanInvocation, exitMap: ExitMap) =>
      Effect.gen(function* () {
        const options: ArgvOptions = {
          argv: invocation.argv,
          cwd: checkout.dir,
          env: jobEnv(ctx, id, invocation.env),
          timeoutMs: SCAN_TIMEOUT_SEC * 1000,
          ...(ctx.deadlineAt === undefined ? {} : { deadlineAt: ctx.deadlineAt }),
        };
        const { exit } = yield* exec.runArgv(options);
        const step: ScanStep = { id, invocation, exit, ...resultOf(id, exitMap, exit) };
        return step;
      });

    const steps: ScanStep[] = [];
    const payload = prepared.bundle.payload;
    for (const scanner of SCANNERS) {
      const invocation = scannerInvocation(scanner, checkout.range, files);
      steps.push(
        invocation === undefined
          ? { id: scanner, result: "nothing-in-scope", invocation: undefined, exit: undefined }
          : yield* run(scanner, invocation, payload.scanners[scanner].exitMap),
      );
    }
    for (const check of payload.baselineChecks)
      steps.push(yield* run(check.controlId, baselineInvocation(check), check.exitMap));
    return { steps, outcome: scanVerdict(steps) };
  });
