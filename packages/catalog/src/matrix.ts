// The job matrix (specs/runs/gate.md § Job matrix): one parent execution that expands its jobs, starts each as a child
// execution inside its window, waits for their verdicts and returns one. The parent makes no sandbox call
// (FD-GATE-045): its only services are `MatrixChildren`, `GateIntents` and `GithubRead`.
import { Effect, Match, Queue, Ref } from "effect";
import { GithubRead } from "./github-read.ts";
import { DEFAULT_JOB_TIMEOUT_SEC, type GateJobInput } from "./inputs.ts";
import { isKey, type GateContext, type MatrixEntry, type MatrixJob } from "./manifest.ts";
import {
  GateIntents,
  MatrixChildren,
  type ChildHandle,
  type ChildVerdict,
  type DiscoveryResult,
} from "./ports.ts";
import { categoryOf, isSuccess, Outcome } from "./reasons.ts";

export const MAX_JOBS = 64;
export const DEFAULT_WINDOW = 10;
/** The failed or not-started keys a `jobs:` reason lists (FD-GATE-040). */
export const LISTED_KEYS = 25;
export const DISCOVERY_TIMEOUT_SEC = 600;
export const DISCOVERY_OUTPUT_LIMIT_BYTES = 4096;
/** A release job's infrastructure restarts where it names none (FD-GATE-060). */
export const DEFAULT_RELEASE_RETRIES = 2;

/** The run each matrix job executes as. */
export const GATE_JOB_RUN = "gate-job";

/** One job after expansion: shards are separate jobs, and `needs` names expanded keys. */
export interface ExpandedJob {
  readonly key: string;
  readonly command: string;
  readonly needs: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly heavy: boolean;
  readonly retries: number;
  readonly timeoutSec: number;
  readonly source: MatrixJob;
}

/** The trigger a matrix answers, which decides where `heavy` jobs run (FD-GATE-052). */
export type MatrixTrigger = "pull_request" | "merge_group" | "push-default" | "other";

const config = (field: string) => Outcome.failure(`config: ${field}`);

/** The jobs of an `offloadTest` entry: its `jobs`, or one job keyed `test` for a single command (FD-GATE-025). */
export const entryJobs = (entry: MatrixEntry): readonly MatrixJob[] | undefined => {
  if (entry.jobs !== undefined && entry.jobs.length > 0) return entry.jobs;
  if (entry.command !== undefined && entry.command.trim() !== "")
    return [
      {
        key: "test",
        command: entry.command,
        ...(entry.timeoutSec === undefined ? {} : { timeoutSec: entry.timeoutSec }),
      },
    ];
  return undefined;
};

/**
 * Expands jobs into the matrix the parent runs, or the `config` failure that starts no job: a bad key or a duplicate
 * (FD-GATE-032), a shard count outside 1 to 64 (FD-GATE-034), a cycle or an unknown `needs` key (FD-GATE-037), or a
 * size of 0 or more than 64 (FD-GATE-029). On a `pull_request` or `merge_group` trigger, `heavy` jobs and the jobs
 * that need them stay out of the matrix (FD-GATE-052).
 */
export const expandMatrix = (
  jobs: readonly MatrixJob[],
  trigger: MatrixTrigger,
  options: { readonly release?: boolean } = {},
): { readonly jobs: readonly ExpandedJob[] } | { readonly failure: Outcome } => {
  const keys = new Set<string>();
  for (const job of jobs) {
    if (!isKey(job.key) || keys.has(job.key)) return { failure: config("job key") };
    keys.add(job.key);
  }
  for (const job of jobs) {
    const shards = job.shards ?? 1;
    if (!Number.isInteger(shards) || shards < 1 || shards > MAX_JOBS)
      return { failure: config("shards") };
    if (job.command.trim() === "") return { failure: config("no command") };
    const retries = job.retries ?? DEFAULT_RELEASE_RETRIES;
    if (!Number.isInteger(retries) || retries < 0 || retries > 2)
      return { failure: config("retries") };
  }
  for (const job of jobs)
    for (const need of job.needs ?? []) if (!keys.has(need)) return { failure: config("needs") };
  // A depth-first walk over `needs` finds any cycle.
  const byKey = new Map(jobs.map((j) => [j.key, j]));
  const state = new Map<string, "visiting" | "done">();
  const cyclic = (key: string): boolean => {
    const s = state.get(key);
    if (s === "done") return false;
    if (s === "visiting") return true;
    state.set(key, "visiting");
    for (const need of byKey.get(key)?.needs ?? []) if (cyclic(need)) return true;
    state.set(key, "done");
    return false;
  };
  for (const job of jobs) if (cyclic(job.key)) return { failure: config("needs") };

  const heavyExcluded = trigger === "pull_request" || trigger === "merge_group";
  const excluded = new Set<string>();
  const exclude = (key: string): boolean => {
    if (excluded.has(key)) return true;
    const job = byKey.get(key)!;
    if ((heavyExcluded && job.heavy === true) || (job.needs ?? []).some(exclude)) {
      excluded.add(key);
      return true;
    }
    return false;
  };
  const included = jobs.filter((j) => !exclude(j.key));
  const shardKeys = (job: MatrixJob): readonly string[] => {
    const n = job.shards ?? 1;
    return job.shards === undefined
      ? [job.key]
      : Array.from({ length: n }, (_, i) => `${job.key}-${i + 1}`);
  };
  const expanded: ExpandedJob[] = included.flatMap((job) => {
    const total = job.shards ?? 1;
    const needs = (job.needs ?? []).flatMap((k) => shardKeys(byKey.get(k)!));
    return shardKeys(job).map((key, i): ExpandedJob => ({
      key,
      command: job.command,
      needs,
      env:
        job.shards === undefined
          ? {}
          : { FD_SHARD_INDEX: String(i + 1), FD_SHARD_TOTAL: String(total) },
      heavy: job.heavy === true,
      retries: options.release === true ? (job.retries ?? DEFAULT_RELEASE_RETRIES) : 0,
      timeoutSec: job.timeoutSec ?? DEFAULT_JOB_TIMEOUT_SEC,
      source: job,
    }));
  });
  if (expanded.length === 0 || expanded.length > MAX_JOBS)
    return { failure: config("matrix size") };
  if (expanded.some((j) => !isKey(j.key))) return { failure: config("job key") };
  return { jobs: expanded };
};

/** The window, default 10, from 1 to 64 (FD-GATE-033). */
export const windowOf = (entry: MatrixEntry): number | undefined => {
  const window = entry.window ?? DEFAULT_WINDOW;
  return Number.isInteger(window) && window >= 1 && window <= MAX_JOBS ? window : undefined;
};

/** A child's dedup key (FD-GATE-031); a restart after an infrastructure error carries its attempt. */
export const childDedupKey = (parentKey: string, jobKey: string, attempt = 0): string =>
  attempt === 0 ? `${parentKey}/${jobKey}` : `${parentKey}/${jobKey}:attempt-${attempt + 1}`;

/** The check a job reports under where the matrix sets `checkPerJob` (FD-GATE-046). */
export const jobCheckName = (run: string, jobKey: string): string =>
  `flare-dispatch/${run}:${jobKey}`;

/** How each job ended. */
export type JobState =
  | { readonly _tag: "Done"; readonly outcome: Outcome }
  | { readonly _tag: "NotStarted"; readonly reason: string };

/**
 * The parent's verdict once every job is terminal (FD-GATE-038 to FD-GATE-041): `success` only if every job recorded
 * `success` or `skipped` and one recorded `success`; `skipped` if every job skipped; otherwise `jobs: <keys>` with
 * the first 25 failed or not-started keys in expansion order.
 */
export const aggregate = (
  order: readonly string[],
  states: ReadonlyMap<string, JobState>,
): Outcome => {
  const bad: string[] = [];
  let succeeded = 0;
  let skipped = 0;
  for (const key of order) {
    const state = states.get(key);
    const outcome = state === undefined || state._tag === "NotStarted" ? undefined : state.outcome;
    if (outcome === undefined) bad.push(key);
    else
      Match.value(outcome).pipe(
        Match.tag("success", () => void succeeded++),
        Match.tag("skipped", () => void skipped++),
        Match.orElse(() => void bad.push(key)),
      );
  }
  if (bad.length > 0) return Outcome.failure(`jobs: ${bad.slice(0, LISTED_KEYS).join(", ")}`);
  if (succeeded === 0 && skipped > 0) return Outcome.skipped("every-job-skipped");
  return Outcome.success();
};

/** A child with no recorded verdict counts as `failure` with `infra: no verdict` (FD-GATE-041). */
export const verdictOutcome = (verdict: ChildVerdict): Outcome =>
  Match.value(verdict).pipe(
    Match.tag("Recorded", ({ outcome }) => outcome),
    Match.tag("NoVerdict", () => Outcome.failure("infra: no verdict")),
    Match.exhaustive,
  );

/** A failure that stops the parent starting jobs: a budget, capacity or operator-halt reason (FD-GATE-044). */
const stopsMatrix = (outcome: Outcome): boolean =>
  Match.value(outcome).pipe(
    Match.tag("failure", ({ reason }) => {
      const category = categoryOf(reason);
      return category === "budget" || category === "capacity" || category === "halt";
    }),
    Match.orElse(() => false),
  );

const isInfra = (outcome: Outcome): boolean =>
  Match.value(outcome).pipe(
    Match.tag("failure", ({ reason }) => categoryOf(reason) === "infra"),
    Match.orElse(() => false),
  );

export interface MatrixPlan {
  /** The parent's run name, for job check names. */
  readonly run: string;
  readonly parentDedupKey: string;
  readonly ctx: GateContext;
  readonly install?: string;
  readonly jobs: readonly ExpandedJob[];
  readonly window: number;
  readonly failFast: boolean;
  readonly checkPerJob: boolean;
  /** The class a heavy job runs at on a default-branch push (FD-GATE-052). */
  readonly heavyClass?: string;
}

/** The child input of one job. */
const jobInput = (plan: MatrixPlan, job: ExpandedJob): GateJobInput => ({
  ...plan.ctx,
  key: job.key,
  command: job.command,
  timeoutSec: job.timeoutSec,
  ...(plan.install === undefined ? {} : { install: plan.install }),
  ...(Object.keys(job.env).length === 0 ? {} : { env: job.env }),
  ...(job.source.cache === undefined ? {} : { cache: job.source.cache }),
  ...(job.source.writeback === undefined ? {} : { writeback: job.source.writeback }),
});

/**
 * Runs the matrix: starts each job once every `needs` job succeeded (FD-GATE-035) and while fewer than `window` jobs
 * are placed or running (FD-GATE-033); records a job whose `needs` job did not succeed as not started (FD-GATE-036);
 * stops starting jobs after a failure under `failFast` (FD-GATE-043) or a budget, capacity or halt reason
 * (FD-GATE-044); restarts a job after an infrastructure error up to its `retries` (FD-GATE-060). Interruption cancels
 * every placed or running job and records every pending job as not started (FD-GATE-042).
 */
export const runMatrix = (
  plan: MatrixPlan,
): Effect.Effect<
  { readonly outcome: Outcome; readonly states: ReadonlyMap<string, JobState> },
  never,
  MatrixChildren
> =>
  Effect.gen(function* () {
    const children = yield* MatrixChildren;
    const states = new Map<string, JobState>();
    const running = yield* Ref.make(new Map<string, ChildHandle>());
    const attempts = new Map<string, number>();
    const finished = yield* Queue.unbounded<readonly [string, Outcome]>();
    let stopped = false;

    const start = (job: ExpandedJob) =>
      Effect.gen(function* () {
        const attempt = attempts.get(job.key) ?? 0;
        const handle = yield* children
          .start({
            key: job.key,
            dedupKey: childDedupKey(plan.parentDedupKey, job.key, attempt),
            run: GATE_JOB_RUN,
            input: jobInput(plan, job),
            ...(job.heavy && plan.heavyClass !== undefined ? { className: plan.heavyClass } : {}),
            ...(plan.checkPerJob ? { checkName: jobCheckName(plan.run, job.key) } : {}),
          })
          .pipe(Effect.catchTag("ChildStartFailed", () => Effect.succeed(undefined)));
        if (handle === undefined) {
          yield* Queue.offer(finished, [
            job.key,
            Outcome.failure("infra: ChildStartFailed"),
          ] as const);
          return;
        }
        yield* Ref.update(running, (m) => new Map(m).set(job.key, handle));
        yield* children.await(handle).pipe(
          Effect.flatMap((v) => Queue.offer(finished, [job.key, verdictOutcome(v)] as const)),
          Effect.forkChild,
        );
      });

    const pending = (): readonly ExpandedJob[] => plan.jobs.filter((j) => !states.has(j.key));
    const inFlight = new Set<string>();

    const cancelAll = Effect.gen(function* () {
      const handles = yield* Ref.get(running);
      yield* Effect.forEach([...handles.values()], (h) => children.cancel(h), { discard: true });
    });

    const loop = Effect.gen(function* () {
      while (true) {
        for (const job of pending()) {
          if (inFlight.has(job.key)) continue;
          const failedNeed = job.needs.find((k) => {
            const s = states.get(k);
            return s !== undefined && (s._tag === "NotStarted" || !isSuccess(s.outcome));
          });
          if (failedNeed !== undefined) {
            states.set(job.key, { _tag: "NotStarted", reason: `needs: ${failedNeed}` });
            continue;
          }
          if (stopped || inFlight.size >= plan.window) continue;
          if (!job.needs.every((k) => states.has(k))) continue;
          inFlight.add(job.key);
          yield* start(job);
        }
        if (inFlight.size === 0) break;
        const [key, outcome] = yield* Queue.take(finished);
        yield* Ref.update(running, (m) => {
          const next = new Map(m);
          next.delete(key);
          return next;
        });
        inFlight.delete(key);
        const job = plan.jobs.find((j) => j.key === key)!;
        const attempt = attempts.get(key) ?? 0;
        if (isInfra(outcome) && attempt < job.retries && !stopped) {
          attempts.set(key, attempt + 1);
          continue;
        }
        states.set(key, { _tag: "Done", outcome });
        if (outcome._tag === "failure" && (plan.failFast || stopsMatrix(outcome))) stopped = true;
      }
      for (const job of pending())
        states.set(job.key, { _tag: "NotStarted", reason: stopped ? "stopped" : "unreachable" });
      return {
        outcome: aggregate(
          plan.jobs.map((j) => j.key),
          states,
        ),
        states,
      };
    });

    return yield* loop.pipe(Effect.onInterrupt(() => cancelAll));
  });

/**
 * The conclusion of every job check the parent's verdict leaves open (FD-GATE-047, FD-GH-020): the job's recorded
 * outcome, or `failure` "parent closed before this part settled" for a job with none.
 */
export const jobCheckConclusions = (
  run: string,
  order: readonly string[],
  states: ReadonlyMap<string, JobState>,
  concluded: ReadonlySet<string>,
): readonly {
  readonly checkName: string;
  readonly outcome: Outcome;
  readonly summary?: string;
}[] =>
  order
    .map((key) => ({ key, checkName: jobCheckName(run, key), state: states.get(key) }))
    .filter(({ checkName }) => !concluded.has(checkName))
    .map(({ checkName, state }) =>
      state !== undefined && state._tag === "Done"
        ? { checkName, outcome: state.outcome }
        : {
            checkName,
            outcome: Outcome.failure("infra: no verdict"),
            summary: "parent closed before this part settled",
          },
    );

// ---- Discovered matrices (FD-GATE-048 to FD-GATE-051) ----

const isJobObject = (value: unknown): value is MatrixJob =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { key?: unknown }).key === "string" &&
  typeof (value as { command?: unknown }).command === "string";

/** One discovery's jobs, or the failure it records. */
export const parseDiscovery = (
  result: DiscoveryResult,
): { readonly jobs: readonly MatrixJob[] } | { readonly failure: Outcome } =>
  Match.value(result).pipe(
    Match.tag("Ended", ({ outcome }) => ({ failure: outcome })),
    Match.tag("Exited", ({ code, output }) => {
      if (code !== 0) return { failure: Outcome.failure(`discover: exit ${code}`) };
      if (new TextEncoder().encode(output).length > DISCOVERY_OUTPUT_LIMIT_BYTES)
        return { failure: config("discovery output") };
      let parsed: unknown;
      try {
        parsed = JSON.parse(output);
      } catch {
        return { failure: config("discovery output") };
      }
      if (!Array.isArray(parsed) || parsed.length > MAX_JOBS || !parsed.every(isJobObject))
        return { failure: config("discovery output") };
      return { jobs: parsed };
    }),
    Match.exhaustive,
  );

/** The union of the head's and the base's jobs, so a head commit cannot remove a job the base requires. */
export const unionJobs = (
  head: readonly MatrixJob[],
  base: readonly MatrixJob[],
): readonly MatrixJob[] => {
  const keys = new Set(head.map((j) => j.key));
  return [...head, ...base.filter((j) => !keys.has(j.key))];
};

/** Runs discovery on the head and the base commit before expansion. */
export const discoverJobs = (options: {
  readonly parentDedupKey: string;
  readonly ctx: GateContext;
  readonly baseSha: string;
  readonly command: string;
}) =>
  Effect.gen(function* () {
    const children = yield* MatrixChildren;
    const discover = (which: "head" | "base", sha: string) =>
      children
        .discover({
          key: `discover-${which}`,
          dedupKey: childDedupKey(options.parentDedupKey, `discover-${which}`),
          run: GATE_JOB_RUN,
          input: {
            ...options.ctx,
            sha,
            key: `discover-${which}`,
            command: options.command,
            timeoutSec: DISCOVERY_TIMEOUT_SEC,
          } satisfies GateJobInput,
        })
        .pipe(
          Effect.catchTag("ChildStartFailed", () =>
            Effect.succeed<DiscoveryResult>({
              _tag: "Ended",
              outcome: Outcome.failure("infra: ChildStartFailed"),
            }),
          ),
        );
    const [head, base] = yield* Effect.all(
      [discover("head", options.ctx.sha), discover("base", options.baseSha)],
      { concurrency: 2 },
    );
    const h = parseDiscovery(head);
    if ("failure" in h) return h;
    const b = parseDiscovery(base);
    if ("failure" in b) return b;
    return { jobs: unionJobs(h.jobs, b.jobs) };
  });

// ---- Release matrices (FD-GATE-054 to FD-GATE-060) ----

const SEMVER = String.raw`(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?`;
const RELEASE_TAG = new RegExp(`^refs/tags/(v${SEMVER})$`);
const DRY_RUN_TAG = new RegExp(`^refs/tags/(dry-run/v${SEMVER})$`);

/** What a tag push means to a release matrix. */
export type ReleaseRef =
  | { readonly _tag: "Release"; readonly tag: string }
  | { readonly _tag: "DryRun"; readonly tag: string }
  | { readonly _tag: "NotRelease" };

export const releaseRefOf = (ref: string): ReleaseRef => {
  const dry = DRY_RUN_TAG.exec(ref);
  if (dry !== null) return { _tag: "DryRun", tag: dry[1]! };
  const release = RELEASE_TAG.exec(ref);
  return release === null ? { _tag: "NotRelease" } : { _tag: "Release", tag: release[1]! };
};

/**
 * A release matrix around `runMatrix`: before any job, a `v<semver>` tag's commit must be reachable from the default
 * branch (FD-GATE-054, FD-GATE-055) and the `release.draft` intent goes out (FD-GATE-056); after every job succeeds,
 * the tag is re-read (FD-GATE-058) and `release.publish` goes out (FD-GATE-057). A `dry-run/v<semver>` tag runs every
 * job and emits neither intent (FD-GATE-059).
 */
export const runRelease = (
  plan: MatrixPlan,
  options: { readonly scope: string; readonly defaultBranch: string },
) =>
  Effect.gen(function* () {
    const release = releaseRefOf(plan.ctx.ref);
    if (release._tag === "NotRelease") return Outcome.failure("config: release ref");
    const github = yield* GithubRead;
    const intents = yield* GateIntents;
    const dryRun = release._tag === "DryRun";
    if (!dryRun) {
      const reachable = yield* github.reachableFrom(
        options.scope,
        plan.ctx.sha,
        options.defaultBranch,
      );
      if (!reachable) return Outcome.failure("release: tag not on default branch");
      yield* intents.emit({
        kind: "release.draft",
        key: "release-draft:0",
        payload: { tag: release.tag, sha: plan.ctx.sha },
      });
    }
    const { outcome } = yield* runMatrix(plan);
    if (dryRun || !isSuccess(outcome)) return outcome;
    const now = yield* github.tagCommit(options.scope, release.tag);
    if (now !== plan.ctx.sha) return Outcome.failure("release: tag moved");
    yield* intents.emit({
      kind: "release.publish",
      key: "release-publish:0",
      payload: { tag: release.tag, sha: plan.ctx.sha },
    });
    return outcome;
  }).pipe(
    Effect.catchTags({
      GithubReadFailed: () => Effect.succeed(Outcome.failure("infra: GithubReadFailed")),
      GithubUncredentialed: () => Effect.succeed(Outcome.failure("infra: GithubUncredentialed")),
      IntentRejected: () => Effect.succeed(Outcome.failure("intent: undeclared kind")),
    }),
  );
