// A gate job's infrastructure errors as a V-SIM scenario (specs/runs/gate.md § Exit to verdict, FD-GATE-010). A seed
// fixes a job matrix, the class its parent runs at, each job's declared `retries`, and for each job a schedule: how
// many of its attempts in a row end with an infrastructure error, which error each is, and how the attempt after them
// ends. The infrastructure errors are those the recipes record: a checkout that fails, a job command that cannot
// start, a child that cannot start, and a child that ends with no verdict. Each attempt that starts runs the
// `gate-job` recipe on a scripted host. The parent restarts a job after an infrastructure error up to the retries its
// class gives the parent: a `release` job's declared `retries` (default 2), since `release` defers its retry bound to
// the run, and none for any other class, whose retries are the control plane's restarts of the child execution
// (mameko MAMEKO-ADM-083). The scenario checks that a job records `failure` with `infra: <error tag>` of its last
// attempt exactly when its infrastructure errors outlast that allowance, and the end of the attempt after them
// otherwise; that each restart is a new child under the attempt's dedup key; and that the parent's verdict lists every
// job that did not succeed. `scenarios` is what the `sim` job runs (packages/ops/scripts/harness.ts).
import { isDeepStrictEqual } from "node:util";
import { buildProfile } from "@fractalboxdev/flare-dispatch-profile";
import { Effect, Layer } from "effect";
import {
  seededRandom,
  throwOnViolations,
  type SimScenario,
  type SimViolation,
} from "../../../ops/src/verification/harness.ts";
import { CommandExit } from "../../src/command.ts";
import { fakeArtifacts, fakeExec, type Scripted } from "../../src/gate.test-support.ts";
import type { GateJobInput } from "../../src/inputs.ts";
import { runGateJob } from "../../src/job.ts";
import type { MatrixJob } from "../../src/manifest.ts";
import {
  childDedupKey,
  DEFAULT_RELEASE_RETRIES,
  expandMatrix,
  runMatrix,
  type JobState,
} from "../../src/matrix.ts";
import { ChildStartFailed, MatrixChildren, type ChildVerdict } from "../../src/ports.ts";
import { Outcome } from "../../src/reasons.ts";

export const SCENARIO = "infra-retry";

const SHA = "a".repeat(40);
const PARENT = `offload-test:o/r:${SHA}`;
const ctx = { repo: "https://github.com/o/r.git", sha: SHA, ref: "refs/heads/main", scope: "o/r" };
const CLASSES = buildProfile("production").classes;

/** An infrastructure error one attempt ends with, and the reason the recipe records for it. */
const INFRA = {
  checkout: "infra: CheckoutFailed",
  exec: "infra: ExecFailed",
  start: "infra: ChildStartFailed",
  "no-verdict": "infra: no verdict",
} as const;
type Infra = keyof typeof INFRA;
const INFRA_KINDS = Object.keys(INFRA) as Infra[];

/** How the attempt after a job's infrastructure errors ends. */
type Final = { readonly _tag: "success" } | { readonly _tag: "exit"; readonly code: number };

interface JobPlan {
  readonly key: string;
  /** The job's declared `retries`, absent where it names none. */
  readonly declared: number | undefined;
  /** The infrastructure error of each attempt in a row, from the first. */
  readonly infra: readonly Infra[];
  readonly final: Final;
}

export interface Plan {
  readonly className: string;
  readonly release: boolean;
  readonly window: number;
  readonly jobs: readonly JobPlan[];
}

export const plan = (seed: number): Plan => {
  const random = seededRandom(seed);
  const int = (n: number) => Math.floor(random() * n);
  const pick = <T>(xs: readonly T[]): T => xs[int(xs.length)]!;
  const cls = pick(CLASSES);
  const release = cls.retries === "run";
  return {
    className: cls.name,
    release,
    window: 1 + int(4),
    jobs: Array.from({ length: 1 + int(6) }, (_, i) => ({
      key: `j${i + 1}`,
      declared: random() < 0.25 ? undefined : int(3),
      infra: Array.from({ length: int(4) }, () => pick(INFRA_KINDS)),
      final: random() < 0.7 ? { _tag: "success" } : { _tag: "exit", code: 1 + int(3) },
    })),
  };
};

/** The restarts the parent makes of a job after infrastructure errors, for the class it runs at. */
const allowanceOf = (p: Plan, job: JobPlan): number =>
  p.release ? (job.declared ?? DEFAULT_RELEASE_RETRIES) : 0;

/** The scripted host of one attempt: the checkout fails, the job command cannot start, or the command exits. */
const hostOf = (command: string, end: Infra | Final): readonly Scripted[] =>
  end === "checkout"
    ? [{ match: "git fetch", exit: CommandExit.Exited({ code: 128 }) }]
    : end === "exec"
      ? [{ match: command, exit: CommandExit.NotStarted({ detail: "spawn ENOMEM" }) }]
      : typeof end === "object" && end._tag === "exit"
        ? [{ match: command, exit: CommandExit.Exited({ code: end.code }) }]
        : [];

export interface Observation {
  /** Every child start the parent asked for, failed ones included, in order. */
  readonly starts: readonly { readonly key: string; readonly dedupKey: string }[];
  readonly states: ReadonlyMap<string, JobState>;
  readonly outcome: Outcome;
}

export const runScenario = (seed: number): Promise<Observation> => {
  const p = plan(seed);
  const byKey = new Map(p.jobs.map((j) => [j.key, j]));
  const starts: { key: string; dedupKey: string }[] = [];
  const endOf = (key: string, attempt: number): Infra | Final => {
    const job = byKey.get(key)!;
    return job.infra[attempt] ?? job.final;
  };
  const inputs = new Map<string, { input: GateJobInput; attempt: number }>();
  const children = Layer.succeed(MatrixChildren, {
    start: (r) =>
      Effect.gen(function* () {
        const attempt = starts.filter((s) => s.key === r.key).length;
        starts.push({ key: r.key, dedupKey: r.dedupKey });
        if (endOf(r.key, attempt) === "start")
          return yield* new ChildStartFailed({ key: r.key, detail: "placement refused" });
        inputs.set(r.dedupKey, { input: r.input as GateJobInput, attempt });
        return { key: r.key, executionId: r.dedupKey };
      }),
    await: (handle) =>
      Effect.gen(function* () {
        const { input, attempt } = inputs.get(handle.executionId)!;
        const end = endOf(handle.key, attempt);
        if (end === "no-verdict") return { _tag: "NoVerdict" } satisfies ChildVerdict;
        const outcome = yield* runGateJob(input).pipe(
          Effect.provide(
            Layer.merge(fakeExec(hostOf(input.command, end)).layer, fakeArtifacts().layer),
          ),
        );
        return { _tag: "Recorded", outcome } satisfies ChildVerdict;
      }),
    cancel: () => Effect.void,
    discover: () => Effect.die("the scenario declares no discover command"),
  });
  const jobs: MatrixJob[] = p.jobs.map((j) => ({
    key: j.key,
    command: `pnpm test --job ${j.key}`,
    ...(j.declared === undefined ? {} : { retries: j.declared }),
  }));
  const expanded = expandMatrix(jobs, "push-default", { release: p.release });
  if ("failure" in expanded)
    return Promise.reject(new Error(`the seed's matrix expands to ${JSON.stringify(expanded)}`));
  return Effect.runPromise(
    Effect.map(
      runMatrix({
        run: "offload-test",
        parentDedupKey: PARENT,
        ctx,
        jobs: expanded.jobs,
        window: p.window,
        failFast: false,
        checkPerJob: false,
      }).pipe(Effect.provide(children)),
      ({ outcome, states }) => ({ starts, states, outcome }),
    ),
  );
};

/** One seed's violations and the paths it took. */
export interface SeedResult {
  readonly violations: readonly SimViolation[];
  readonly reached: Readonly<Record<string, number>>;
}

export const observeSeed = async (seed: number): Promise<SeedResult> => {
  const p = plan(seed);
  const o = await runScenario(seed);
  const violations: SimViolation[] = [];
  const reached: Record<string, number> = {};
  const reach = (k: string) => (reached[k] = (reached[k] ?? 0) + 1);
  const v = (message: string) => violations.push({ id: "FD-GATE-010", message });

  const failed: string[] = [];
  for (const job of p.jobs) {
    const allowance = allowanceOf(p, job);
    const outlasted = job.infra.length > allowance;
    const attempts = Math.min(job.infra.length, allowance) + 1;
    const expected: Outcome = outlasted
      ? Outcome.failure(INFRA[job.infra[allowance]!])
      : job.final._tag === "success"
        ? Outcome.success()
        : Outcome.failure(`exit: ${job.final.code}`);
    const state = o.states.get(job.key);
    if (!isDeepStrictEqual(state, { _tag: "Done", outcome: expected }))
      v(
        `${p.className} job ${job.key} with ${job.infra.join(",") || "no"} infrastructure errors and ${allowance} ` +
          `restart(s) recorded ${JSON.stringify(state)}, not ${JSON.stringify(expected)}`,
      );
    const keys = o.starts.filter((s) => s.key === job.key).map((s) => s.dedupKey);
    const wanted = Array.from({ length: attempts }, (_, i) => childDedupKey(PARENT, job.key, i));
    if (!isDeepStrictEqual(keys, wanted))
      v(
        `${p.className} job ${job.key} started ${JSON.stringify(keys)}, not ${JSON.stringify(wanted)}`,
      );
    if (expected._tag !== "success") failed.push(job.key);
    if (outlasted) reach(`${p.release ? "release" : "other"}-outlasted ${job.infra[allowance]}`);
    else if (job.infra.length > 0) reach("retried-through");
  }
  const verdict =
    failed.length === 0 ? Outcome.success() : Outcome.failure(`jobs: ${failed.join(", ")}`);
  if (!isDeepStrictEqual(o.outcome, verdict))
    v(`the parent recorded ${JSON.stringify(o.outcome)}, not ${JSON.stringify(verdict)}`);
  return { violations, reached };
};

export const scenarios: readonly SimScenario[] = [
  {
    name: SCENARIO,
    ids: ["FD-GATE-010"],
    run: async (seed) => throwOnViolations((await observeSeed(seed)).violations),
  },
];
