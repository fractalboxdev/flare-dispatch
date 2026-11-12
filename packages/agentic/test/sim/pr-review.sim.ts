// The pr-review scenarios of the `sim` job (specs/verification.md § V-SIM, specs/runs/agentic.md § `pr-review`). A
// seed fixes how many pull requests an Actions workflow dispatches `pr-review` for and at what virtual gaps, when an
// executor claims the reviewed one inside its claim window, the size of its diff (so its change class and reviewer
// count), the repo manifest's mode, and for each reviewer call how long it takes on the virtual clock and how it ends:
// findings, `rate-limited` after its wait bound, or `unavailable`. Each dispatch goes through intake's admission
// into mameko's admission on a SQLite D1 under the production class catalogue; the reviewed execution's body then runs
// through `prReviewRun`'s workflow on `TestClock`. `scenarios` is what the `sim` job runs
// (packages/ops/scripts/harness.ts): each seed fails on any violation.
import { buildProfile } from "@fractalboxdev/flare-dispatch-profile";
import {
  DEFAULT_LEASE_WAIT_SEC,
  DEFAULT_SETTLE_MARGIN_SEC,
} from "@fractalboxdev/mameko-coordinator";
import type { RunResult } from "@fractalboxdev/mameko-run";
import { Clock, Effect, Layer } from "effect";
import { TestClock } from "effect/testing";
import { catalogRuns } from "../../../intake/src/catalog.ts";
import {
  admit,
  authenticated,
  BASE,
  HEAD,
  harness,
  manifest,
  REPO,
  repoWithManifest,
} from "../../../intake/src/harness.test-support.ts";
import {
  seededRandom,
  throwOnViolations,
  type SimScenario,
  type SimViolation,
} from "../../../ops/src/verification/harness.ts";
import { fakeServices, recorder, type Recorder } from "../../src/recipes/fakes.test-support.ts";
import {
  FULL_REVIEWERS,
  LITE_REVIEWERS,
  PR_REVIEW_MARKER,
  TRIVIAL_REVIEWERS,
  type Finding,
  type PrReviewInput,
} from "../../src/recipes/pr-review.ts";
import { prReviewRun } from "../../src/recipes/runs.ts";
import { ModelCallError, ModelClient, type ModelRequest } from "../../src/recipes/services.ts";

export const PLACEMENT_SCENARIO = "pr-review-placement";
export const CAPACITY_SCENARIO = "pr-review-capacity";

const SECOND = 1000;
/** The interactive class's claim deadline and `pr-review`'s run ceiling (FD-AGT-047). */
const CLAIM_DEADLINE_MS = 300 * SECOND;
const RUN_CEILING_SEC = 1500;

const INTERACTIVE = buildProfile("production").classes.find((c) => c.name === "interactive")!;
/** The interactive class's queue age: the instant its terminal outcome falls due, the wait bound of MAMEKO-MDL-046. */
const QUEUE_AGE_MS =
  typeof INTERACTIVE.queue_age === "object" ? INTERACTIVE.queue_age.seconds * SECOND : 0;

const MANIFEST = manifest([{ recipe: "pr-review", triggers: ["dispatch"] }]);

/** How one reviewer call ends: findings at a level, `rate-limited` at its wait bound, or `unavailable`. */
export type CallEnd =
  | { readonly _tag: "findings"; readonly level: Finding["level"] | null }
  | { readonly _tag: "rate-limited" }
  | { readonly _tag: "unavailable" };

/**
 * One reviewer call and how it ends: a `rate-limited` call ends at the wait bound, any other after its virtual
 * latency.
 */
export type PlannedCall =
  | { readonly end: Extract<CallEnd, { _tag: "rate-limited" }> }
  | { readonly latencyMs: number; readonly end: Exclude<CallEnd, { _tag: "rate-limited" }> };

/** Which way the seed makes the reviewers end. */
export type Mode = "all-rate-limited" | "all-failed-mixed" | "some-answer";

/** What the seed fixes for one run of the scenarios. */
export interface Plan {
  /** The virtual gap before each dispatch, one per pull request. */
  readonly gapsMs: readonly number[];
  /** The dispatch whose execution runs its body. */
  readonly reviewed: number;
  /** How long after admission an executor claims the reviewed execution; at most the claim deadline. */
  readonly claimAfterMs: number;
  /** Added lines in the diff, which set the change class. */
  readonly lines: number;
  readonly mode: Mode;
  readonly gating: boolean;
  /** Each reviewer's first call and its step retry. */
  readonly calls: Readonly<Record<string, readonly [PlannedCall, PlannedCall]>>;
}

export const plan = (seed: number): Plan => {
  const random = seededRandom(seed);
  const int = (n: number) => Math.floor(random() * n);
  const gapsMs = Array.from({ length: 1 + int(4) }, () => int(600) * SECOND);
  const roll = random();
  const mode: Mode =
    roll < 0.4 ? "all-rate-limited" : roll < 0.55 ? "all-failed-mixed" : "some-answer";
  const lineRoll = random();
  const lines = lineRoll < 0.34 ? 1 + int(25) : lineRoll < 0.67 ? 26 + int(175) : 201 + int(200);
  const latency = () => (1 + int(90)) * SECOND;
  const rateLimited = (): PlannedCall => ({ end: { _tag: "rate-limited" } });
  const failure = (): PlannedCall =>
    random() < 0.5 ? rateLimited() : { latencyMs: latency(), end: { _tag: "unavailable" } };
  const level = (): Finding["level"] | null =>
    [null, "notice", "warning", "failure"][int(4)] as Finding["level"] | null;
  const answer = (): PlannedCall => ({
    latencyMs: latency(),
    end: { _tag: "findings", level: level() },
  });
  const calls: Record<string, readonly [PlannedCall, PlannedCall]> = {};
  for (const reviewer of FULL_REVIEWERS) {
    // `code-quality` runs at every change class, so it decides the mode's guarantee.
    const decides = reviewer === "code-quality";
    calls[reviewer] =
      mode === "all-rate-limited"
        ? [rateLimited(), rateLimited()]
        : mode === "all-failed-mixed"
          ? decides
            ? [failure(), { latencyMs: latency(), end: { _tag: "unavailable" } }]
            : [failure(), failure()]
          : decides
            ? random() < 0.5
              ? [answer(), answer()]
              : [rateLimited(), answer()]
            : random() < 0.5
              ? [failure(), failure()]
              : [random() < 0.5 ? rateLimited() : answer(), answer()];
  }
  return {
    gapsMs,
    reviewed: int(gapsMs.length),
    claimAfterMs: int(CLAIM_DEADLINE_MS / SECOND + 1) * SECOND,
    lines,
    mode,
    gating: random() < 0.5,
    calls,
  };
};

/** The change class a diff of `lines` added lines to one ordinary path takes (FD-AGT-050). */
export const classOfLines = (lines: number): "full" | "lite" | "trivial" =>
  lines > 200 ? "full" : lines > 25 ? "lite" : "trivial";

/** How many reviewers each change class runs. */
const REVIEWER_COUNT = {
  full: FULL_REVIEWERS.length,
  lite: LITE_REVIEWERS.length,
  trivial: TRIVIAL_REVIEWERS.length,
} as const;

const diffOf = (lines: number) =>
  [
    "diff --git a/src/a.ts b/src/a.ts",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    `@@ -1,1 +1,${lines} @@`,
    ...Array.from({ length: lines }, (_, i) => `+line ${i}`),
  ].join("\n");

const inputOf = (number: number, gating: boolean): PrReviewInput => ({
  repo: { owner: "acme", name: "app" },
  number,
  baseSha: BASE,
  headSha: HEAD,
  draft: false,
  labels: [],
  authorLogin: "dev",
  authorAssociation: "MEMBER",
  forkHead: false,
  ...(gating ? { mode: "gating" as const } : {}),
  maxDiffChars: 100_000,
});

/** One admitted execution as the control plane's rows hold it. */
export interface Admitted {
  readonly executionId: string;
  readonly className: string;
  readonly enqueuedAt: number;
  readonly deadlineAt: number;
  readonly admittedAt: number;
  readonly cloudEligibleAt: number | null;
  readonly localOpen: boolean;
  readonly eligibleKinds: readonly string[];
}

/** What one run shows: every admitted execution, and the reviewed one's body. */
export interface Observation {
  readonly admitted: readonly Admitted[];
  readonly reviewed: Admitted;
  readonly result: RunResult;
  readonly rec: Recorder;
  /** Each reviewer call's call site, in the order the calls start. */
  readonly callSites: readonly string[];
  /** The virtual time the body started and ended at. */
  readonly startedAt: number;
  readonly endedAt: number;
}

/**
 * A `ModelClient` answer on the virtual clock: each call ends as planned. A `rate-limited` call ends after its wait
 * bound, the class's queue age after admission (MAMEKO-MDL-046), and at once when it starts past the bound; any other
 * call ends after its planned latency.
 */
const plannedModel = (
  p: Plan,
  waitBound: number,
  callSites: string[],
  sleeping: Set<{ readonly at: number }>,
) => {
  const seen = new Map<string, number>();
  return (request: ModelRequest) =>
    Effect.gen(function* () {
      callSites.push(request.callSite);
      const reviewer = request.callSite.slice("reviewer:".length);
      const attempt = seen.get(reviewer) ?? 0;
      seen.set(reviewer, attempt + 1);
      const call = p.calls[reviewer]![Math.min(attempt, 1)]!;
      const now = yield* Clock.currentTimeMillis;
      const until = "latencyMs" in call ? now + call.latencyMs : Math.max(now, waitBound);
      const timer = { at: until };
      sleeping.add(timer);
      yield* Effect.sleep(until - now).pipe(
        Effect.ensuring(Effect.sync(() => sleeping.delete(timer))),
      );
      if (call.end._tag === "rate-limited")
        return yield* new ModelCallError({
          kind: "rate-limited",
          detail: "429 past the wait bound",
        });
      if (call.end._tag === "unavailable")
        return yield* new ModelCallError({ kind: "unavailable", detail: "502" });
      const level = call.end.level;
      return JSON.stringify({
        findings:
          level === null
            ? []
            : [
                {
                  path: "src/a.ts",
                  startLine: 1,
                  endLine: 1,
                  level,
                  title: reviewer,
                  message: "m",
                },
              ],
      });
    });
};

const admittedRow = (row: Record<string, unknown>): Admitted => ({
  executionId: row["id"] as string,
  className: row["class"] as string,
  enqueuedAt: row["enqueued_at"] as number,
  deadlineAt: row["deadline_at"] as number,
  admittedAt: row["admitted_at"] as number,
  cloudEligibleAt: row["cloud_eligible_at"] as number | null,
  localOpen: row["local_open"] === 1,
  eligibleKinds: JSON.parse(row["eligible_kinds"] as string) as string[],
});

/** Runs the scenarios for one seed: the dispatches through admission, then the reviewed execution's body. */
export const runScenario = async (seed: number): Promise<Observation> => {
  const p = plan(seed);
  const h = await harness({
    settings: { catalog: catalogRuns("development") },
    profileResolver: true,
    repos: {
      [REPO]: repoWithManifest(MANIFEST, {
        files: {
          [`${BASE}:.github/flare-dispatch.json`]: MANIFEST,
          [`${HEAD}:.github/flare-dispatch.json`]: MANIFEST,
        },
      }),
    },
  });
  const ids: string[] = [];
  for (const [i, gap] of p.gapsMs.entries()) {
    await h.adjust(gap);
    const answer = await admit(
      h,
      authenticated({ run: "pr-review", label: null, inputs: inputOf(100 + i, p.gating) }),
    );
    ids.push(answer.executionId);
  }
  const rows = h.rows(
    `select e.id, e.class, e.enqueued_at, e.deadline_at, p.admitted_at, p.cloud_eligible_at, p.local_open,
            p.eligible_kinds
       from executions e join placements p on p.execution_id = e.id`,
  );
  const admitted = ids.map((id) => admittedRow(rows.find((r) => r["id"] === id)!));
  const reviewed = admitted[p.reviewed]!;

  const rec = recorder();
  const callSites: string[] = [];
  const shell = (command: string) =>
    command.startsWith("git diff")
      ? { exitCode: 0, stdout: diffOf(p.lines), stderr: "" }
      : { exitCode: 0, stdout: "", stderr: "" };
  const services = fakeServices(rec, { shell });
  const sleeping = new Set<{ readonly at: number }>();
  const complete = plannedModel(p, reviewed.enqueuedAt + QUEUE_AGE_MS, callSites, sleeping);
  const model = Layer.succeed(ModelClient, { complete });
  const startedAt = reviewed.enqueuedAt + p.claimAfterMs;
  const payload = {
    workflow_version: 1,
    execution_id: reviewed.executionId,
    run: "pr-review",
    run_version: prReviewRun.spec.version,
    scope_id: REPO,
    request_context: {},
    class: reviewed.className,
    epoch: 1,
    deadline_at: reviewed.deadlineAt,
    attempt: 0,
    input: inputOf(100 + p.reviewed, p.gating),
  };
  const { result, endedAt } = await Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(startedAt);
      const fiber = yield* prReviewRun.workflow
        .execute(payload)
        .pipe(
          Effect.provide(Layer.provideMerge(prReviewRun.layer, Layer.merge(services, model))),
          Effect.forkChild,
        );
      // Only a planned model sleep advances virtual time. Workflow-engine scheduler turns and async bookkeeping
      // consume no simulated time, so a slow host cannot move the body past its deadline while it polls completion.
      for (let i = 0; i < 10_000 && fiber.pollUnsafe() === undefined; i++) {
        const next = Math.min(...[...sleeping].map((timer) => timer.at));
        if (Number.isFinite(next)) yield* TestClock.setTime(next);
        else yield* Effect.yieldNow;
      }
      const exit = fiber.pollUnsafe();
      if (exit === undefined) return yield* Effect.die("the body did not end on the virtual clock");
      const result = yield* exit;
      return { result, endedAt: yield* Clock.currentTimeMillis };
    }).pipe(Effect.provide(TestClock.layer())),
  );
  return { admitted, reviewed, result: result as RunResult, rec, callSites, startedAt, endedAt };
};

/**
 * FD-AGT-047 on one run: every dispatched `pr-review` with no class input is admitted in class `interactive`, its cloud
 * entry opens the class's 300 s claim deadline after admission, and its `deadline_at` carries the 1500 s run ceiling
 * between the class's queue age and mameko's lease wait and settle margin.
 */
export const checkPlacement = (o: Observation): readonly SimViolation[] => {
  const violations: SimViolation[] = [];
  const v = (message: string) => violations.push({ id: "FD-AGT-047", message });
  const ceilingInDeadline =
    QUEUE_AGE_MS + (DEFAULT_LEASE_WAIT_SEC + RUN_CEILING_SEC + DEFAULT_SETTLE_MARGIN_SEC) * SECOND;
  for (const a of o.admitted) {
    if (a.className !== "interactive") v(`${a.executionId} admitted in class ${a.className}`);
    if (!a.localOpen)
      v(`${a.executionId} admitted with no device eligible inside the claim window`);
    if (!a.eligibleKinds.some((k) => k !== "device"))
      v(`${a.executionId} admitted with no cloud kind`);
    if (a.cloudEligibleAt === null || a.cloudEligibleAt - a.admittedAt !== CLAIM_DEADLINE_MS)
      v(`${a.executionId} cloud entry opens at ${a.cloudEligibleAt}, admitted at ${a.admittedAt}`);
    if (a.deadlineAt - a.enqueuedAt !== ceilingInDeadline)
      v(`${a.executionId} deadline_at is ${a.deadlineAt - a.enqueuedAt} ms after enqueue`);
  }
  if (o.reviewed.className !== "interactive") v("the reviewed execution ran outside interactive");
  return violations;
};

/** How each reviewer that ran ended: the planned end of its last call. */
export const reviewerEnds = (
  p: Plan,
  callSites: readonly string[],
): ReadonlyMap<string, CallEnd> => {
  const counts = new Map<string, number>();
  for (const site of callSites) {
    const reviewer = site.slice("reviewer:".length);
    counts.set(reviewer, (counts.get(reviewer) ?? 0) + 1);
  }
  return new Map(
    [...counts].map(([reviewer, n]) => [reviewer, p.calls[reviewer]![Math.min(n, 2) - 1]!.end]),
  );
};

/** The verdict the plan calls for, from the reviewers' ends and the manifest's mode alone. */
export const expectedVerdict = (p: Plan, ends: ReadonlyMap<string, CallEnd>): RunResult => {
  const finals = [...ends.values()];
  if (finals.every((e) => e._tag === "rate-limited"))
    return { _tag: "failure", reason: "capacity: model unavailable" };
  if (finals.every((e) => e._tag !== "findings"))
    return { _tag: "failure", reason: "infra: every reviewer failed" };
  const anyFailure = finals.some((e) => e._tag === "findings" && e.level === "failure");
  return p.gating && anyFailure
    ? { _tag: "failure", reason: "review: changes requested" }
    : { _tag: "success" };
};

/**
 * FD-AGT-057 on one run: when every reviewer's call ends `rate-limited` after its wait bound, the step retry
 * included, `pr-review` concludes `failure` with `capacity: model unavailable` before its `deadline_at` and posts no
 * comment; when any reviewer ends otherwise, it concludes from the other rules instead.
 */
export const checkCapacity = (seed: number, o: Observation): readonly SimViolation[] => {
  const p = plan(seed);
  const violations: SimViolation[] = [];
  const v = (message: string) => violations.push({ id: "FD-AGT-057", message });
  const ends = reviewerEnds(p, o.callSites);
  const expectedCount = REVIEWER_COUNT[classOfLines(p.lines)];
  if (ends.size !== expectedCount)
    v(`${ends.size} reviewers ran, the ${classOfLines(p.lines)} class runs ${expectedCount}`);
  for (const [reviewer, end] of ends) {
    const calls = o.callSites.filter((s) => s === `reviewer:${reviewer}`).length;
    const firstFailed = p.calls[reviewer]![0].end._tag !== "findings";
    if (calls !== (firstFailed ? 2 : 1))
      v(`${reviewer} made ${calls} calls, its first ${firstFailed ? "failed" : "answered"}`);
    if (p.mode === "all-rate-limited" && end._tag !== "rate-limited")
      v(`${reviewer} ended ${end._tag}`);
  }
  const expected = expectedVerdict(p, ends);
  if (JSON.stringify(o.result) !== JSON.stringify(expected))
    v(`concluded ${JSON.stringify(o.result)}, expected ${JSON.stringify(expected)}`);
  const comments = o.rec.intents.filter((i) => i.kind === "comment");
  const answered = [...ends.values()].some((e) => e._tag === "findings");
  if (answered) {
    if (comments.length !== 1) v(`posted ${comments.length} review comments`);
    else if (!(comments[0]!.payload as { body: string }).body.includes(PR_REVIEW_MARKER))
      v("the review comment carries no marker");
  } else if (o.rec.intents.length > 0)
    v(`a run with no reviewer answer returned ${o.rec.intents.length} intents`);
  if (p.mode === "all-rate-limited" && o.endedAt < o.reviewed.enqueuedAt + QUEUE_AGE_MS)
    v(`the body ended at ${o.endedAt}, before the wait bound`);
  if (o.endedAt > o.reviewed.deadlineAt)
    v(`the body ended at ${o.endedAt}, past deadline_at ${o.reviewed.deadlineAt}`);
  return violations;
};

export const scenarios: readonly SimScenario[] = [
  {
    name: PLACEMENT_SCENARIO,
    ids: ["FD-AGT-047"],
    run: async (seed) => throwOnViolations(checkPlacement(await runScenario(seed))),
  },
  {
    name: CAPACITY_SCENARIO,
    ids: ["FD-AGT-057"],
    run: async (seed) => throwOnViolations(checkCapacity(seed, await runScenario(seed))),
  },
];
