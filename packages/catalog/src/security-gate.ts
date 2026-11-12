// The run bodies of `security-gate` and `security-rescan` (specs/runs/gate.md § Security gate): the scan's
// preconditions, the checkout, the scanners and baseline checks, then a verdict and a check summary. Every path ends in
// `success` or `failure`; neither recipe reads a draft state, an author, a label or any other skip fact, and no path
// concludes `skipped` (FD-GATE-085, FD-GATE-086).
//
// The preconditions run in two parts, both before any scanner: the bundle pin, the bundle's digest and schema, the
// image's scanner versions and baseline-check tools first, since the checkout reads the bundle's suppression section;
// then, once the checkout has read the scan range, the advisory snapshot of each ecosystem whose lockfile it changes.
import { Intents } from "@fractalboxdev/mameko-run";
import { Clock, Context, Effect, Match } from "effect";
import type { GateExec } from "./command.ts";
import type { SecurityGateBase, SecurityGateInput, SecurityRescanInput } from "./inputs.ts";
import type { GateContext } from "./manifest.ts";
import type { AdvisorySnapshots, ScanBundleStore, ScanImage } from "./ports.ts";
import { Outcome, type Reason } from "./reasons.ts";
import { advisoryPreconditions, prepareScan, SCANNERS, type PreparedScan } from "./scan-bundle.ts";
import { prepareScanCheckout, ScanBase } from "./scan-checkout.ts";
import { runScanTools, type ScanFiles, type ScanStep } from "./scan.ts";
import { StepFindings, type ScanFinding } from "./scan-findings.ts";

/** The two scan recipes, each reporting under `flare-dispatch/<run>` with no label (FD-GATE-111). */
export type ScanRunName = "security-gate" | "security-rescan";

/** The check name a scan run reports under. */
export const scanCheckName = (run: ScanRunName): string => `flare-dispatch/${run}`;

/**
 * What the deployment fixes for every scan, outside any run input: the overlay's `scan.bundleDigest`, absent where the
 * overlay pins none (FD-GATE-101), `scan.advisoryMaxAgeHours`, and where the executor placed the bundle's scanner
 * configurations and the advisory snapshot (FD-GATE-104). The executor kind that serves the scan runs supplies it.
 */
export class ScanSettings extends Context.Service<
  ScanSettings,
  {
    readonly bundleDigest: string | undefined;
    readonly advisoryMaxAgeHours: number;
    readonly files: ScanFiles;
  }
>()("@fractalboxdev/flare-dispatch-catalog/ScanSettings") {}

/** The services a scan run's body reads. */
export type ScanServices =
  | GateExec
  | ScanBundleStore
  | ScanImage
  | AdvisorySnapshots
  | ScanSettings
  | Intents;

/** What a scan concluded, and the facts its check summary names. */
export interface ScanFacts {
  readonly outcome: Outcome;
  /** The bundle, scanner versions and snapshots, from the point the preconditions that read them held. */
  readonly prepared: PreparedScan | undefined;
  /** Each scanner's and baseline check's result, in run order; empty where no scanner ran. */
  readonly steps: readonly ScanStep[];
}

const verdictText = (outcome: Outcome): string =>
  Match.value(outcome).pipe(
    Match.tagsExhaustive({
      success: () => "success",
      failure: ({ reason }) => `failure: ${reason}`,
      cancelled: ({ cause }) => `cancelled: ${cause}`,
      skipped: ({ detail }) => `skipped: ${detail}`,
    }),
  );

/** A table cell: one line, with each `|` escaped. */
const cell = (text: string): string => text.replace(/[\r\n]+/g, " ").replace(/\|/g, "\\|");

/** A scan result's detail: a tool error's reason, a finding's count. A matched value never enters it (FD-GATE-098). */
const stepDetail = (step: ScanStep): string =>
  Match.value(step).pipe(
    Match.when({ result: "tool-error" }, (s) => s.reason),
    Match.orElse((s) =>
      s.findings === undefined
        ? ""
        : Match.value(s.findings).pipe(
            Match.tagsExhaustive({
              Read: ({ findings }) => `${findings.length} finding${findings.length === 1 ? "" : "s"}`,
              Unreadable: () => "report unreadable",
            }),
          ),
    ),
  );

/**
 * The check summary of a scan (FD-GATE-099): the verdict, the scan bundle's digest and version, each advisory
 * snapshot's digest and `Last-Modified` time, each scanner's version and each scan result. A part the scan did not
 * reach says so rather than being left out.
 */
export const scanSummary = (
  run: ScanRunName,
  facts: ScanFacts,
): { readonly title: string; readonly markdown: string } => {
  const verdict = verdictText(facts.outcome);
  const prepared = facts.prepared;
  const snapshots = prepared === undefined ? [] : Object.values(prepared.snapshots);
  const lines = [
    `**${run}**: ${verdict}`,
    "",
    "#### Scan bundle",
    "",
    prepared === undefined
      ? "Not verified: the scan stopped before the bundle's preconditions held."
      : `Version \`${prepared.bundle.payload.version}\`, digest \`sha256:${prepared.bundle.digest}\``,
    "",
    "#### Advisory snapshots",
    "",
    ...(snapshots.length === 0
      ? ["None read: the scan range changes no lockfile, or the scan stopped before it read one."]
      : [
          "| Ecosystem | Digest | Last-Modified |",
          "| --- | --- | --- |",
          ...snapshots.map(
            (s) =>
              `| ${cell(s.ecosystem)} | \`sha256:${s.digest}\` | ${new Date(s.lastModified).toUTCString()} |`,
          ),
        ]),
    "",
    "#### Scanners",
    "",
    ...(prepared === undefined
      ? ["Not read: the scan stopped before it read the image's scanner versions."]
      : [
          "| Scanner | Version |",
          "| --- | --- |",
          ...SCANNERS.map((s) => `| ${s} | \`${cell(prepared.versions[s])}\` |`),
        ]),
    "",
    "#### Scan results",
    "",
    ...(facts.steps.length === 0
      ? ["None: no scanner or baseline check ran."]
      : [
          "| Scanner or control | Result | Detail |",
          "| --- | --- | --- |",
          ...facts.steps.map((s) => `| ${cell(s.id)} | ${s.result} | ${cell(stepDetail(s))} |`),
        ]),
  ];
  return { title: `${run}: ${verdict}`.slice(0, 255), markdown: `${lines.join("\n")}\n` };
};

/** The most findings a scan reports in its `report`, the most a `verdict.record` holds. */
export const REPORTED_FINDINGS_MAX = 200;

/** One finding as a scan reports it, with the identity FD-GATE-096 gives it. */
export interface ReportedScanFinding {
  readonly ruleId: string;
  readonly fingerprint: string;
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly level: ScanFinding["level"];
}

/**
 * The `report` member of a scan's `check.summary` payload, which the control plane copies into the execution's
 * `verdict.record` (specs/github-output.md FD-GH-096; decoded by `RunReport` in `packages/github/src/records.ts`).
 */
export interface ScanRunReport {
  readonly scan?: {
    readonly bundle_digest: string;
    readonly advisory_snapshots: readonly { readonly ecosystem: string; readonly digest: string }[];
    readonly scanners: readonly {
      readonly name: string;
      readonly version: string;
      readonly result: ScanStep["result"] | null;
    }[];
  };
  readonly findings?: readonly ReportedScanFinding[];
  readonly findingsTruncated?: boolean;
}

/**
 * What a scan reports of itself: from the point its bundle and scanner versions held, the bundle's digest, each
 * advisory snapshot's digest and each scanner's name, version and result, null for a scanner the scan stopped before;
 * and once a scanner ran, at most 200 findings, with `findingsTruncated` true where it found more, or a step reported a
 * finding the list does not hold: a scanner whose report could not be read, or a baseline check. A scan that ran no scanner reports no finding list, so none reads as none found.
 */
export const scanReport = (facts: ScanFacts): ScanRunReport => {
  const prepared = facts.prepared;
  const read = facts.steps.flatMap((s) =>
    s.findings === undefined
      ? []
      : Match.value(s.findings).pipe(
          Match.tagsExhaustive({
            Read: ({ findings }) => findings,
            Unreadable: () => [],
          }),
        ),
  );
  const unlisted = facts.steps.some(
    (s) =>
      s.result === "finding" && (s.findings === undefined || StepFindings.$is("Unreadable")(s.findings)),
  );
  return {
    ...(prepared === undefined
      ? {}
      : {
          scan: {
            bundle_digest: `sha256:${prepared.bundle.digest}`,
            advisory_snapshots: Object.values(prepared.snapshots).map((s) => ({
              ecosystem: s.ecosystem,
              digest: `sha256:${s.digest}`,
            })),
            scanners: SCANNERS.map((name) => ({
              name,
              version: prepared.versions[name],
              result: facts.steps.find((s) => s.id === name)?.result ?? null,
            })),
          },
        }),
    ...(facts.steps.length === 0
      ? {}
      : {
          findings: read.slice(0, REPORTED_FINDINGS_MAX).map((f) => ({
            ruleId: f.ruleId,
            fingerprint: f.fingerprint,
            path: f.path,
            startLine: f.startLine,
            endLine: f.startLine,
            level: f.level,
          })),
          findingsTruncated: read.length > REPORTED_FINDINGS_MAX || unlisted,
        }),
  };
};

/**
 * One scan of `ctx.sha` from `base`: the preconditions, the checkout, every scanner and baseline check, then the
 * verdict. A refused precondition records its `config` reason and runs no scanner; a checkout that fails records
 * `infra: CheckoutFailed`.
 */
export const scanFacts = (
  ctx: GateContext,
  base: ScanBase,
): Effect.Effect<ScanFacts, never, Exclude<ScanServices, Intents>> =>
  Effect.gen(function* () {
    const settings = yield* ScanSettings;
    // One sampled time for every age check of the scan.
    const now = yield* Clock.currentTimeMillis;
    let prepared: PreparedScan | undefined;
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const ready = yield* prepareScan({
          pin: settings.bundleDigest,
          changedPaths: [],
          now,
          advisoryMaxAgeHours: settings.advisoryMaxAgeHours,
        });
        prepared = ready;
        const checkout = yield* prepareScanCheckout(ctx, base, ready.bundle.payload.suppression);
        const snapshots = yield* advisoryPreconditions({
          changedPaths: checkout.range.changed,
          now,
          advisoryMaxAgeHours: settings.advisoryMaxAgeHours,
        });
        const scanned: PreparedScan = { ...ready, snapshots };
        prepared = scanned;
        const report = yield* runScanTools({ ctx, prepared: scanned, checkout, files: settings.files });
        return { outcome: report.outcome, prepared: scanned, steps: report.steps } satisfies ScanFacts;
      }),
    ).pipe(
      Effect.catchTags({
        ScanRefused: (refused) =>
          Effect.succeed<ScanFacts>({
            outcome: Outcome.failure(refused.reason as Reason),
            prepared,
            steps: [],
          }),
        CheckoutFailed: () =>
          Effect.succeed<ScanFacts>({
            outcome: Outcome.failure("infra: CheckoutFailed"),
            prepared,
            steps: [],
          }),
      }),
    );
  });

/**
 * A scan run: the scan, then its check summary as a `check.summary` intent carrying the scan's `report`; the run
 * answers the scan's verdict.
 */
const scanRun = (
  run: ScanRunName,
  ctx: GateContext,
  base: ScanBase,
): Effect.Effect<Outcome, never, ScanServices> =>
  Effect.gen(function* () {
    const facts = yield* scanFacts(ctx, base);
    const summary = scanSummary(run, facts);
    const intents = yield* Intents;
    yield* intents.emit("summary", {
      kind: "check.summary",
      payload: { name: scanCheckName(run), head_sha: ctx.sha, ...summary, report: scanReport(facts) },
    });
    return facts.outcome;
  }).pipe(
    Effect.catchTags({
      DuplicateIntentKey: () => Effect.succeed(Outcome.failure("infra: DuplicateIntentKey")),
      IntentLimitExceeded: () => Effect.succeed(Outcome.failure("infra: IntentLimitExceeded")),
    }),
  );

/** The scan base of a `security-gate` input. */
export const gateScanBase = (base: SecurityGateBase): ScanBase =>
  Match.value(base).pipe(
    Match.tagsExhaustive({
      TargetBranch: ({ branch }) => ScanBase.TargetBranch({ branch }),
      MergeGroup: ({ baseSha }) => ScanBase.MergeGroup({ baseSha }),
    }),
  );

/** The commit fields of a scan input as the checkout reads them. */
const contextOf = (input: SecurityRescanInput): GateContext => ({
  repo: input.repo,
  sha: input.sha,
  ref: input.ref,
  ...(input.scope === undefined ? {} : { scope: input.scope }),
  ...(input.deadlineAt === undefined ? {} : { deadlineAt: input.deadlineAt }),
});

/**
 * `security-gate`: a scan of the pull request's or merge group's head from the base its input names. The input holds
 * no draft state, author or label, so every request the decoder admits is scanned (FD-GATE-085).
 */
export const runSecurityGate = (input: SecurityGateInput) =>
  scanRun("security-gate", contextOf(input), gateScanBase(input.base));

/**
 * `security-rescan`: a scan of the dispatched commit from the merge base of that commit and the default branch head
 * (FD-GATE-112).
 */
export const runSecurityRescan = (input: SecurityRescanInput) =>
  scanRun("security-rescan", contextOf(input), ScanBase.DefaultBranch());
