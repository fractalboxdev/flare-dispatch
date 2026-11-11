// The job-matrix V-SIM scenario (specs/verification.md § V-SIM, specs/runs/gate.md § Job matrix). A seed fixes a
// matrix of 1 to 48 jobs, its `window` (unset, in range, or out of range) and, for each job, how long its child runs
// and how it ends: `success`, a finding, no recorded verdict, or a budget, capacity or operator-halt failure. The parent
// runs on a virtual clock against children that record every start and end in one log; the checks read the log, the
// parent's per-job states and its verdict. `scenarios` is what the `sim` job runs (packages/ops/scripts/harness.ts).
import { isDeepStrictEqual } from "node:util";
import { Clock, Effect, Layer, Match } from "effect";
import { TestClock } from "effect/testing";
import {
  seededRandom,
  throwOnViolations,
  type SimScenario,
  type SimViolation,
} from "../../../ops/src/verification/harness.ts";
import { fakeGithub, fakeIntents } from "../../src/gate.test-support.ts";
import type { OffloadTestInput } from "../../src/inputs.ts";
import type { MatrixEntry, MatrixJob } from "../../src/manifest.ts";
import { expandMatrix, runMatrix, windowOf, type JobState } from "../../src/matrix.ts";
import { runOffloadTest } from "../../src/offload-test.ts";
import { MatrixChildren, type ChildVerdict } from "../../src/ports.ts";
import { Outcome, type Reason } from "../../src/reasons.ts";

export const SCENARIO = "gate-matrix";

const SHA = "a".repeat(40);
const PARENT = `offload-test:o/r:${SHA}`;
const ctx = { repo: "https://github.com/o/r.git", sha: SHA, ref: "refs/heads/main", scope: "o/r" };

/** The failures that stop the parent starting jobs (FD-GATE-044), one per category and the `operator` kind. */
export const STOPPING: readonly Reason[] = [
  "budget: required reserve exhausted",
  "capacity: queue full",
  "halt: operator halted",
  "operator: halted",
];
/** Failures of other categories, which stop nothing while `failFast` is unset. */
const OTHER_FAILURES: readonly Reason[] = ["exit: 1", "timeout: 600s", "deadline", "infra: lost"];
const OUT_OF_RANGE_WINDOWS = [0, 65, 2.5, -1] as const;

/** How one job's child ends: `success`, a failure that stops nothing, no verdict, or a stopping failure. */
export type EndKind = "success" | "failure" | "no-verdict" | "stopping";

/** One job's run time on the virtual clock, in minutes, and what its child answers. */
export interface JobEnd {
  readonly minutes: number;
  readonly kind: EndKind;
  readonly verdict: ChildVerdict;
}

/** What the seed fixes for one run of the scenario. */
export interface Plan {
  readonly entry: MatrixEntry;
  /** The expanded job keys, in expansion order. */
  readonly keys: readonly string[];
  readonly ends: ReadonlyMap<string, JobEnd>;
}

export const plan = (seed: number): Plan => {
  const random = seededRandom(seed);
  const int = (n: number) => Math.floor(random() * n);
  const pick = <T>(xs: readonly T[]): T => xs[int(xs.length)]!;
  const n = 1 + int(48);
  const sharded = random() < 0.5;
  const jobs: MatrixJob[] = sharded
    ? [{ key: "s", command: "pnpm test", shards: n }]
    : Array.from({ length: n }, (_, i) => ({ key: `j${i + 1}`, command: "pnpm test" }));
  const keys = sharded ? Array.from({ length: n }, (_, i) => `s-${i + 1}`) : jobs.map((j) => j.key);
  const roll = random();
  const window =
    roll < 0.3
      ? undefined
      : roll < 0.4
        ? pick(OUT_OF_RANGE_WINDOWS)
        : roll < 0.85
          ? 1 + int(12)
          : 1 + int(64);
  const ends = new Map<string, JobEnd>();
  for (const key of keys) {
    const r = random();
    const kind: EndKind =
      r < 0.7 ? "success" : r < 0.8 ? "no-verdict" : r < 0.9 ? "failure" : "stopping";
    const recorded = (outcome: Outcome): ChildVerdict => ({ _tag: "Recorded", outcome });
    const verdict: ChildVerdict =
      kind === "success"
        ? recorded(Outcome.success())
        : kind === "no-verdict"
          ? { _tag: "NoVerdict" }
          : recorded(Outcome.failure(pick(kind === "failure" ? OTHER_FAILURES : STOPPING)));
    ends.set(key, { minutes: 1 + int(20), kind, verdict });
  }
  return { entry: { jobs, ...(window === undefined ? {} : { window }) }, keys, ends };
};

/** One entry of the children's log: a child placed, or a child that ended with what it answered. */
export interface LogEntry {
  readonly event: "start" | "end";
  readonly key: string;
  /** The virtual time, in milliseconds. */
  readonly at: number;
  /** At a start, the children placed or running, this one included. */
  readonly placed?: number;
  /** At an end, how the child ended. */
  readonly end?: EndKind;
}

/**
 * `MatrixChildren` whose children run on the virtual clock: each runs for its planned minutes and answers its planned
 * end. Every start and end goes into one log, in the order they happen.
 */
const simChildren = (p: Plan) => {
  const log: LogEntry[] = [];
  let placed = 0;
  let now = 0;
  const layer = Layer.succeed(MatrixChildren, {
    start: (request) =>
      Effect.sync(() => {
        placed++;
        log.push({ event: "start", key: request.key, at: now, placed });
        return { key: request.key, executionId: request.dedupKey };
      }),
    await: (handle) =>
      Effect.gen(function* () {
        const { minutes, kind, verdict } = p.ends.get(handle.key)!;
        yield* Effect.sleep(`${minutes} minutes`);
        now = yield* Clock.currentTimeMillis;
        placed--;
        log.push({ event: "end", key: handle.key, at: now, end: kind });
        return verdict;
      }),
    cancel: () => Effect.void,
    discover: () => Effect.die("the scenario declares no discover command"),
  });
  return { layer, log };
};

/** What one run shows: the children's log, the parent's per-job states and its verdict. */
export interface Observation {
  readonly log: readonly LogEntry[];
  readonly states: ReadonlyMap<string, JobState> | undefined;
  readonly outcome: Outcome;
}

/**
 * Runs the parent for one seed. A window out of range goes through the whole `offload-test` body, which refuses it;
 * any other runs the matrix the body builds from the entry, so the parent's per-job states are visible.
 */
export const runScenario = (seed: number): Promise<Observation> => {
  const p = plan(seed);
  const children = simChildren(p);
  return Effect.runPromise(
    Effect.gen(function* () {
      const window = windowOf(p.entry);
      if (window === undefined) {
        const input: OffloadTestInput = {
          ...ctx,
          entry: p.entry,
          parentDedupKey: PARENT,
          trigger: "pull_request",
        };
        const outcome = yield* runOffloadTest(input).pipe(
          Effect.provide(Layer.mergeAll(children.layer, fakeIntents().layer, fakeGithub({}).layer)),
        );
        return { log: children.log, states: undefined, outcome };
      }
      const expanded = expandMatrix(p.entry.jobs!, "pull_request");
      if ("failure" in expanded)
        return { log: children.log, states: undefined, outcome: expanded.failure };
      const fiber = yield* runMatrix({
        run: "offload-test",
        parentDedupKey: PARENT,
        ctx,
        jobs: expanded.jobs,
        window,
        failFast: false,
        checkPerJob: false,
      }).pipe(Effect.provide(children.layer), Effect.forkChild);
      // Every child ends within 20 minutes of its start, so 48 jobs end within a day; each step wakes them in order.
      for (let day = 0; day < 4 && fiber.pollUnsafe() === undefined; day++)
        yield* TestClock.adjust("1 day");
      const exit = fiber.pollUnsafe();
      if (exit === undefined)
        return yield* Effect.die("the matrix did not end on the virtual clock");
      const { outcome, states } = yield* exit;
      return { log: children.log, states, outcome };
    }).pipe(Effect.provide(TestClock.layer())),
  );
};

/** The keys a `jobs:` reason lists. */
const listedKeys = (outcome: Outcome): readonly string[] | undefined =>
  Match.value(outcome).pipe(
    Match.tag("failure", ({ reason }) =>
      reason.startsWith("jobs: ") ? reason.slice("jobs: ".length).split(", ") : undefined,
    ),
    Match.orElse(() => undefined),
  );

const isNotStarted = (state: JobState | undefined): boolean =>
  state !== undefined &&
  Match.value(state).pipe(
    Match.tag("NotStarted", () => true),
    Match.orElse(() => false),
  );

/** The paths a seed took, for a run over many seeds to show it reached each. */
export interface SeedOutcome {
  readonly outOfRange: boolean;
  /** The window was unset and the matrix had more than 10 jobs, so the default bounded it. */
  readonly defaultBound: boolean;
  /** A set window below the matrix size bounded it. */
  readonly setBound: boolean;
  readonly noVerdict: boolean;
  /** A stopping failure ended while jobs were still pending. */
  readonly stoppedEarly: boolean;
}

/** One seed's violations, each naming the requirement it breaks, and the paths it took. */
export interface SeedResult {
  readonly violations: readonly SimViolation[];
  readonly reached: SeedOutcome;
}

/**
 * Runs one seed and checks FD-GATE-033, FD-GATE-041 and FD-GATE-044 on it:
 * - the parent never has more than `window` children placed or running, `window` 10 when unset, and fills the window
 *   at the start; an out-of-range window starts no job and records `config: window`;
 * - a job whose child ended with no recorded verdict is `failure` with `infra: no verdict`, and the parent's verdict
 *   counts it as failed;
 * - after a child ends with a budget, capacity or operator-halt failure, no further child starts.
 */
export const observeSeed = async (seed: number): Promise<SeedResult> => {
  const p = plan(seed);
  const o = await runScenario(seed);
  const violations: SimViolation[] = [];
  const v = (id: string, message: string) => violations.push({ id, message });
  const starts = o.log.filter((e) => e.event === "start");
  const n = p.keys.length;
  const set = p.entry.window;

  if (set !== undefined && (!Number.isInteger(set) || set < 1 || set > 64)) {
    if (!isDeepStrictEqual(o.outcome, Outcome.failure("config: window")))
      v("FD-GATE-033", `window ${set} recorded ${JSON.stringify(o.outcome)}, not config: window`);
    if (starts.length > 0) v("FD-GATE-033", `window ${set} started ${starts.length} job(s)`);
    return {
      violations,
      reached: {
        outOfRange: true,
        defaultBound: false,
        setBound: false,
        noVerdict: false,
        stoppedEarly: false,
      },
    };
  }

  // FD-GATE-033: the window, 10 when unset, bounds the children placed or running at every start.
  const limit = set ?? 10;
  for (const s of starts)
    if (s.placed! > limit)
      v("FD-GATE-033", `${s.key} started with ${s.placed} placed or running, window ${limit}`);
  const firstEnd = o.log.findIndex((e) => e.event === "end");
  const burst = (firstEnd === -1 ? o.log : o.log.slice(0, firstEnd)).length;
  if (burst !== Math.min(limit, n))
    v("FD-GATE-033", `${burst} job(s) started before any ended, expected ${Math.min(limit, n)}`);

  // FD-GATE-041: a child with no recorded verdict counts as failure with infra: no verdict.
  const listed = listedKeys(o.outcome);
  const ended = o.log.filter((e) => e.event === "end");
  const noVerdict: JobState = { _tag: "Done", outcome: Outcome.failure("infra: no verdict") };
  for (const e of ended) {
    if (e.end !== "no-verdict") continue;
    const state = o.states?.get(e.key);
    if (!isDeepStrictEqual(state, noVerdict))
      v("FD-GATE-041", `${e.key} ended with no verdict and was recorded ${JSON.stringify(state)}`);
    if (listed === undefined || (!listed.includes(e.key) && listed.length < 25))
      v(
        "FD-GATE-041",
        `${e.key} ended with no verdict and the parent recorded ${JSON.stringify(o.outcome)}`,
      );
  }

  // FD-GATE-044: no child starts after one ends with a budget, capacity or operator-halt failure.
  const stopAt = o.log.findIndex((e) => e.end === "stopping");
  if (stopAt !== -1) {
    const stopper = o.log[stopAt]!.key;
    for (const late of o.log.slice(stopAt + 1).filter((e) => e.event === "start"))
      v("FD-GATE-044", `${late.key} started after ${stopper} ended with a stopping failure`);
    const startedKeys = new Set(starts.map((s) => s.key));
    for (const key of p.keys)
      if (!startedKeys.has(key) && !isNotStarted(o.states?.get(key)))
        v(
          "FD-GATE-044",
          `${key} never started and was recorded ${JSON.stringify(o.states?.get(key))}`,
        );
  } else if (starts.length !== n) {
    // With failFast unset, only a stopping failure leaves a job unstarted.
    v("FD-GATE-044", `${n - starts.length} job(s) never started with no stopping failure`);
  }

  return {
    violations,
    reached: {
      outOfRange: false,
      defaultBound: set === undefined && n > 10,
      setBound: set !== undefined && set < n,
      noVerdict: ended.some((e) => e.end === "no-verdict"),
      stoppedEarly: stopAt !== -1 && starts.length < n,
    },
  };
};

/** Runs one seed and throws on any violation, as the `sim` job requires of each scenario. */
export const checkSeed = async (seed: number): Promise<SeedOutcome> => {
  const { violations, reached } = await observeSeed(seed);
  throwOnViolations(violations);
  return reached;
};

export const scenarios: readonly SimScenario[] = [
  {
    name: SCENARIO,
    ids: ["FD-GATE-033", "FD-GATE-041", "FD-GATE-044"],
    run: async (seed) => {
      await checkSeed(seed);
    },
  },
];
