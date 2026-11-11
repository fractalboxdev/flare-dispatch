// The check-run lifecycle and the installation quota as V-SIM scenarios (specs/github-output.md FD-GH-010, FD-GH-027,
// FD-GH-058, FD-GH-062). Each scenario runs the composed control plane on `TestClock`: intake's admission over a SQLite
// D1 inserts each execution's `cp:check:open` row, mameko's `applyOutbox` stage writes its terminal outcome and outcome
// row, and mameko's drainer sends the outbox through the check-run applier, with the control plane's `ConcludeFacts`,
// to a fake GitHub under one `InstallationQuota`. A recording rate limit logs every permit the drainer asks for. A seed
// fixes the executions, their classes and outcomes, the order of admissions, redeliveries, lease grants, terminal
// writes, engine replays and drains, the GitHub faults, and the installation's budget.
import { createHash } from "node:crypto";
import {
  checkConclusion,
  CheckRunApplierLive,
  GithubHttpError,
  GithubNetworkError,
  InstallationQuota,
  installationQuotaLayer,
  quotaOptionsDefault,
  verdictOf,
  type GithubError,
  type QuotaOptions,
} from "@fractalboxdev/flare-dispatch-github";
import {
  fakeGithub,
  fakeGithubLayers,
  type FakeGithub,
} from "@fractalboxdev/flare-dispatch-github/testing";
import {
  Admission,
  d1Admission,
  d1IntakeStore,
  IntakeStore,
  type IntakeAdmitInput,
} from "@fractalboxdev/flare-dispatch-intake";
import { migratedD1 } from "@fractalboxdev/flare-dispatch-intake/testing";
import { buildProfile, drawsReserve, placementInputs } from "@fractalboxdev/flare-dispatch-profile";
import {
  actuatorBindings,
  drainOnce,
  executionId,
  ExecutionSteps,
  type ExecutionOutcome,
} from "@fractalboxdev/mameko-coordinator";
import { d1OutboxStore, insertOutboxRows } from "@fractalboxdev/mameko-host-cloudflare/d1";
import { d1ExecutionSteps } from "@fractalboxdev/mameko-host-cloudflare/d1-execution";
import { newRow } from "@fractalboxdev/mameko-kernel";
import { ActuatorRateLimit, type PermitRequest } from "@fractalboxdev/mameko-ports";
import { Clock, Effect, Layer, ManagedRuntime } from "effect";
import { TestClock } from "effect/testing";
import {
  seededRandom,
  throwOnViolations,
  type SimScenario,
  type SimViolation,
} from "../../../../packages/ops/src/verification/harness.ts";
import { executionConfig } from "../../src/config.ts";
import { concludeFactsLayer } from "../../src/github.ts";
import { envOf, record } from "../conclude.test-support.ts";

const profile = buildProfile("production");
const T0 = Date.UTC(2026, 10, 4, 12, 0, 0);
export const SHA = "b".repeat(40);
const SCOPE = "acme/app";
const CLASSES = profile.classes.map((c) => c.name);
const RESERVE_KINDS = ["check.conclude", "check.open"];
export const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

/** The n-th execution id of a scenario run, well-formed and the same on every run. */
export const idOf = (n: number) => executionId(T0 + n, () => 0.5);

export interface SimOutcome {
  readonly violations: readonly SimViolation[];
  readonly reached: Readonly<Record<string, number>>;
  readonly trace: readonly string[];
}

/** One permit the drainer asked for: when, for which row and call, the budget share before it, and the answer. */
export interface PermitLog {
  readonly at: number;
  readonly kind: string;
  readonly call: PermitRequest["call"];
  readonly share: number;
  readonly granted: boolean;
}

/** The actuator rate limit over the installation quota, logging every request and its answer. */
const recordingRateLimit = (log: PermitLog[]) =>
  Layer.effect(
    ActuatorRateLimit,
    Effect.gen(function* () {
      const quota = yield* InstallationQuota;
      return {
        acquire: (request: PermitRequest) =>
          Effect.gen(function* () {
            const at = yield* Clock.currentTimeMillis;
            // The in-isolate quota is always reachable.
            const share = yield* quota.remainingShare(request.limitKey).pipe(Effect.orDie);
            const answer = yield* quota.acquire(request);
            log.push({
              at,
              kind: request.kind,
              call: request.call,
              share,
              granted: answer._tag === "granted",
            });
            return answer;
          }),
        release: quota.release,
      };
    }),
  );

/**
 * One execution a scenario drives: its run, the class, the attempt of its family and the outcome. Each run is its own
 * (run, scope), so a `batch` execution meets no queued one of the same run at admission unless it is a later attempt.
 */
export interface Execution {
  readonly id: string;
  readonly run: string;
  readonly attempt: number;
  readonly className: string;
  readonly outcome: ExecutionOutcome;
}

export const checkName = (run: string) => `flare-dispatch/${run}:ci`;

const admitInput = (e: Execution, executionId: string): IntakeAdmitInput => {
  const { facts, params } = placementInputs(profile, {
    class: e.className,
    labels: [],
    confidentiality: "non-confidential",
  });
  return {
    executionId,
    scopeId: SCOPE,
    run: e.run,
    className: e.className,
    labels: [],
    enqueuedAtMs: T0,
    dedup: {
      sha256: createHash("sha256").update(e.id).digest("hex"),
      canonical: `${e.run}:ci:${SCOPE}:${SHA}:${e.attempt}`,
      requestDigest: null,
      digestBody: null,
      onMismatch: "duplicate",
    },
    placement: {
      facts: {
        runLabels: facts.runLabels,
        confidentiality: facts.confidentiality,
        cloudPinned: facts.cloudPinned,
        cloudOnly: facts.cloudOnly,
        localOnly: facts.localOnly,
        needsLocalModel: facts.needsLocalModel,
      },
      params,
    },
    maxDurationSec: 600,
    grants: { setup: [], agent: [] },
    check: { name: checkName(e.run), headSha: SHA },
  };
};

/** The composed control plane of one scenario run, on one D1, one fake GitHub, one quota and one `TestClock`. */
export const plane = async (quota: QuotaOptions) => {
  const db = await migratedD1();
  const gh = fakeGithub();
  const permits: PermitLog[] = [];
  const layer = Layer.mergeAll(
    d1OutboxStore(db),
    d1ExecutionSteps(db, { ...executionConfig(profile), meteredCost: () => Effect.succeed(0) }),
    d1Admission(db, profile),
    d1IntakeStore(db),
    CheckRunApplierLive.pipe(
      Layer.provide(Layer.merge(fakeGithubLayers(gh), concludeFactsLayer(envOf(db)))),
    ),
    recordingRateLimit(permits).pipe(Layer.provideMerge(installationQuotaLayer(quota))),
    TestClock.layer(),
  );
  const runtime = ManagedRuntime.make(layer);
  const run = <A, E>(effect: Effect.Effect<A, E, Layer.Success<typeof layer>>) =>
    runtime.runPromise(effect);
  let now = T0;
  await run(TestClock.setTime(now));
  const actuatorOf = actuatorBindings(profile.intent_kinds);

  const rows = <R>(sql: string, ...params: unknown[]) =>
    db.sqlite.prepare(sql).all(...(params as never[])) as R[];

  return {
    db,
    gh,
    permits,
    now: () => now,
    advance: async (ms: number) => {
      now += ms;
      await run(TestClock.setTime(now));
    },
    rows,
    /** Admits the execution under `executionId`: its intake record, mameko's execution row and its `check.open` row. */
    admit: (e: Execution, executionId = e.id) =>
      run(
        Effect.gen(function* () {
          const answer = yield* Admission.use((a) => a.admit(admitInput(e, executionId)));
          if (answer._tag === "Queued")
            yield* IntakeStore.use((s) =>
              s.put(
                record(e.id, {
                  run: e.run,
                  label: "ci",
                  className: e.className,
                  attempt: e.attempt,
                  sha: SHA,
                  createdAt: now,
                }),
              ),
            );
          return answer;
        }),
      ),
    /** The terminal write as the `Execution` workflow's outbox stage runs it. */
    terminal: (e: Execution) =>
      run(ExecutionSteps.use((s) => s.applyOutbox(e.id, e.outcome, null))),
    /** A row of `kind` as the control plane inserts it, with the profile's tier, priority and reserve flag. */
    insert: (e: Execution, kind: string, intentKey: string, payload: unknown) => {
      const entry = profile.intent_kinds[kind]!;
      const rank = profile.classes.find((c) => c.name === e.className)?.rank ?? 0;
      return insertOutboxRows(db, [
        {
          id: `${e.id}:${intentKey}`,
          limitKey: SCOPE,
          tier: entry.delivery_tier,
          priority: entry.priority ?? 0,
          classRank: rank,
          drawsReserve: drawsReserve(entry),
          intent: {
            executionId: e.id,
            scopeId: SCOPE,
            intentKey,
            kind,
            payload,
            payloadDigest: JSON.stringify(payload),
            effectClass: entry.effect_class,
            attempts: 0,
          },
          row: newRow({ effectClass: entry.effect_class, insertedAt: now }),
        },
      ]);
    },
    /** One outbox pass at the clock's time. */
    drain: () =>
      run(
        drainOnce({
          now,
          token: (id) => `tok-${id}-${now}`,
          random: () => 0.5,
          actuatorOf,
        }),
      ),
    observe: (o: Parameters<InstallationQuota["Service"]["observe"]>[1]) =>
      run(InstallationQuota.use((q) => q.observe(SCOPE, o))),
    open: () =>
      rows<{ n: number }>(
        "select count(*) as n from outbox where state in ('pending', 'in_flight', 'ambiguous')",
      )[0]!.n,
    dispose: () => runtime.dispose(),
  };
};

export type Plane = Awaited<ReturnType<typeof plane>>;

/** Drains until no row is left to send, `stepMs` apart; answers whether the outbox went quiet. */
export const drainAll = async (p: Plane, stepMs: number, passes: number) => {
  for (let pass = 0; pass < passes; pass++) {
    await p.drain();
    if (p.open() === 0) return true;
    await p.advance(stepMs);
  }
  return p.open() === 0;
};

/** The GitHub faults a seed injects before a drain: one refused call, or an answer lost after the write. */
const injectFault = (gh: FakeGithub, random: () => number, reached: Record<string, number>) => {
  if (gh.failures.length > 0 || gh.lostAnswers.length > 0) return;
  const draw = random();
  const http = (status: number, rateLimited = false) =>
    new GithubHttpError({ status, message: `status ${status}`, rateLimited });
  const before: readonly GithubError[] = [
    http(502),
    http(429, true),
    http(401),
    new GithubNetworkError({ sent: false, message: "connect refused" }),
  ];
  const after: readonly GithubError[] = [
    http(502),
    new GithubNetworkError({ sent: true, message: "connection reset" }),
  ];
  if (draw < 0.25) {
    gh.failures.push(before[Math.floor(random() * before.length)]!);
    reached.failedCall!++;
  } else if (draw < 0.5) {
    gh.lostAnswers.push(after[Math.floor(random() * after.length)]!);
    reached.lostAnswer!++;
  }
};

/** The check runs that carry an execution id, and every check run that carries none. */
const runsOf = (gh: FakeGithub, id: string) => gh.runs.filter((r) => r.external_id === id);

const outcomeTitle = (o: ExecutionOutcome) =>
  o._tag === "Failure" ? `Failure(${o.reason})` : o._tag;

// ---------------------------------------------------------------------------------------------------------------------
// FD-GH-010: one check run per execution across replays, retries and reclaims

const OUTCOMES: readonly ExecutionOutcome[] = [
  { _tag: "Success", epoch: 1 },
  { _tag: "Failure", reason: "lint: 3 errors", epoch: 1 },
  { _tag: "Failure", reason: "capacity: no executor", epoch: null },
  { _tag: "Cancelled", cause: "superseded" },
  { _tag: "Skipped", detail: "draft-pr", epoch: 1 },
];

export const simulateCheckRunOnce = async (seed: number): Promise<SimOutcome> => {
  const random = seededRandom(seed);
  const pick = <A>(xs: readonly A[]): A => xs[Math.floor(random() * xs.length)]!;
  const violations: SimViolation[] = [];
  const trace: string[] = [];
  const reached: Record<string, number> = {
    failedCall: 0,
    lostAnswer: 0,
    ambiguous: 0,
    redelivery: 0,
    replay: 0,
    reclaim: 0,
    sameNameAttempts: 0,
  };
  const p = await plane(quotaOptionsDefault);
  try {
    // A family's attempts share one check-run name on the head SHA (FD-GH-008), so the lookup must tell them apart by
    // external_id.
    const families = 1 + Math.floor(random() * 3);
    const attempts: Record<string, number> = {};
    const executions: Execution[] = Array.from({ length: 2 + Math.floor(random() * 5) }, (_, i) => {
      const run = `run-${i % families}`;
      attempts[run] = (attempts[run] ?? 0) + 1;
      return {
        id: idOf(i + 1),
        run,
        attempt: attempts[run]!,
        className: pick(CLASSES),
        outcome: pick(OUTCOMES),
      };
    });
    reached.sameNameAttempts! += executions.filter((e) => e.attempt > 1).length;

    /** Each execution's remaining steps, in order: admit, lease grants, then its terminal write. */
    const steps = new Map(
      executions.map((e) => {
        const grants = Math.floor(random() * 3);
        const list: string[] = ["admit"];
        for (let epoch = 1; epoch <= grants; epoch++) list.push(`grant ${epoch}`);
        if (random() < 0.4) list.push("redeliver");
        list.push("terminal");
        if (random() < 0.4) list.push("replay");
        return [e.id, list];
      }),
    );
    /** A family's next attempt starts once the one before it has its terminal write. */
    const ready = (x: Execution) =>
      steps.get(x.id)!.length > 0 &&
      !executions.some(
        (y) => y.run === x.run && y.attempt < x.attempt && steps.get(y.id)!.includes("terminal"),
      );
    while ([...steps.values()].some((s) => s.length > 0)) {
      const e = pick(executions.filter(ready));
      const step = steps.get(e.id)!.shift()!;
      trace.push(`${e.id} ${step}`);
      if (step === "admit") await p.admit(e);
      else if (step === "redeliver") {
        // The same webhook delivered again, or the dispatch retried: admission answers the first execution.
        const answer = await p.admit(e, idOf(10_000 + executions.indexOf(e)));
        if (answer._tag !== "Duplicate")
          violations.push({
            id: "FD-GH-010",
            message: `a redelivery of ${e.id} answered ${answer._tag}`,
          });
        reached.redelivery!++;
      } else if (step.startsWith("grant ")) {
        // A lease grant after a reclaim generates the epoch's `check.start` row.
        const epoch = Number(step.slice(6));
        await p.insert(e, "check.start", `cp:check:start:${epoch}`, {
          name: checkName(e.run),
          head_sha: SHA,
          epoch,
          executor_kind: "device",
          attempt: e.attempt,
        });
        if (epoch > 1) reached.reclaim!++;
      } else if (step === "terminal") await p.terminal(e);
      else {
        // The engine lost the stage's journal entry and runs the terminal write again.
        await p.terminal(e);
        reached.replay!++;
      }
      if (random() < 0.5) {
        injectFault(p.gh, random, reached);
        await p.advance(Math.floor(random() * 90_000));
        await p.drain();
        reached.ambiguous! += p.rows<{ n: number }>(
          "select count(*) as n from outbox where state = 'ambiguous'",
        )[0]!.n;
      }
    }
    if (!(await drainAll(p, 10 * MINUTE_MS, 200)))
      violations.push({ id: "FD-GH-010", message: "the outbox never went quiet" });

    for (const e of executions) {
      const runs = runsOf(p.gh, e.id);
      const expected = checkConclusion(verdictOf(e.outcome));
      if (runs.length !== 1)
        violations.push({
          id: "FD-GH-010",
          message: `${e.id} (${outcomeTitle(e.outcome)}) has ${runs.length} check runs`,
        });
      else if (runs[0]!.status !== "completed" || runs[0]!.conclusion !== expected.conclusion)
        violations.push({
          id: "FD-GH-010",
          message: `${e.id}'s check run is ${runs[0]!.status} ${runs[0]!.conclusion}, not ${expected.conclusion}`,
        });
      else if (runs[0]!.name !== checkName(e.run))
        violations.push({
          id: "FD-GH-010",
          message: `${e.id}'s check run is named ${runs[0]!.name}`,
        });
    }
    const stray = p.gh.runs.filter((r) => !executions.some((e) => e.id === r.external_id));
    if (stray.length > 0)
      violations.push({
        id: "FD-GH-010",
        message: `check runs for no execution: ${stray.map((r) => r.external_id).join(",")}`,
      });
  } finally {
    await p.dispose();
  }
  return { violations, reached, trace };
};

// ---------------------------------------------------------------------------------------------------------------------
// FD-GH-027: no neutral conclusion for a budget, capacity, deadline, halt or placement outcome

/** Outcomes whose reason kind is in category `budget`, `capacity`, `deadline`, `halt` or `placement`. */
const NOT_NEUTRAL: readonly ExecutionOutcome[] = [
  ...profile.classes.flatMap((c): ExecutionOutcome[] =>
    typeof c.terminal_outcome === "object"
      ? [{ _tag: "Failure", reason: c.terminal_outcome.reason, epoch: null }]
      : [],
  ),
  { _tag: "Failure", reason: "budget", epoch: null },
  { _tag: "Failure", reason: "capacity: context overflow", epoch: 1 },
  { _tag: "Failure", reason: "capacity: model unavailable", epoch: 1 },
  { _tag: "Failure", reason: "capacity: no executor", epoch: null },
  { _tag: "Failure", reason: "deadline: claim deadline passed", epoch: null },
  { _tag: "Failure", reason: "halt: plane halted", epoch: null },
  { _tag: "Failure", reason: "operator: halted", epoch: null },
  { _tag: "Failure", reason: "placement: no eligible executor", epoch: null },
  { _tag: "Deferred" },
  { _tag: "Expired" },
];

/** A listed not-applicable skip, the only outcome that concludes neutral (FD-GH-025), and one outside the list. */
const SKIPS: readonly ExecutionOutcome[] = [
  { _tag: "Skipped", detail: "path-filter", epoch: 1 },
  { _tag: "Skipped", detail: "capacity", epoch: 1 },
];

export const simulateNoNeutralCapacity = async (seed: number): Promise<SimOutcome> => {
  const random = seededRandom(seed);
  const pick = <A>(xs: readonly A[]): A => xs[Math.floor(random() * xs.length)]!;
  const violations: SimViolation[] = [];
  const trace: string[] = [];
  const reached: Record<string, number> = {
    failedCall: 0,
    lostAnswer: 0,
    notNeutral: 0,
    deferredOrExpired: 0,
    neutralSkip: 0,
  };
  for (const c of CLASSES) reached[`class ${c}`] = 0;
  const p = await plane(quotaOptionsDefault);
  try {
    const executions: Execution[] = Array.from(
      { length: 2 + Math.floor(random() * 6) },
      (_, i) => ({
        id: idOf(i + 1),
        run: `run-${i}`,
        attempt: 1,
        className: pick(CLASSES),
        outcome: random() < 0.8 ? pick(NOT_NEUTRAL) : pick(SKIPS),
      }),
    );
    for (const e of executions) {
      await p.admit(e);
      trace.push(`${e.id} ${e.className} ${outcomeTitle(e.outcome)}`);
      if (random() < 0.5) {
        injectFault(p.gh, random, reached);
        await p.drain();
      }
    }
    for (const e of executions) {
      await p.advance(Math.floor(random() * 60_000));
      await p.terminal(e);
      if (random() < 0.5) {
        injectFault(p.gh, random, reached);
        await p.drain();
      }
    }
    if (!(await drainAll(p, 10 * MINUTE_MS, 200)))
      violations.push({ id: "FD-GH-027", message: "the outbox never went quiet" });

    for (const e of executions) {
      const runs = runsOf(p.gh, e.id);
      const listedSkip = e.outcome._tag === "Skipped" && e.outcome.detail === "path-filter";
      const conclusion = runs[0]?.conclusion ?? null;
      if (runs.length !== 1 || runs[0]!.status !== "completed")
        violations.push({
          id: "FD-GH-027",
          message: `${e.id} has ${runs.length} check runs, none completed`,
        });
      else if (!listedSkip && conclusion === "neutral")
        violations.push({
          id: "FD-GH-027",
          message: `${e.id} (${e.className}) ended ${outcomeTitle(e.outcome)} and concluded neutral`,
        });
      else if (!listedSkip && conclusion !== "failure")
        violations.push({
          id: "FD-GH-027",
          message: `${e.id} (${e.className}) ended ${outcomeTitle(e.outcome)} and concluded ${conclusion}`,
        });
      else if (listedSkip && conclusion !== "neutral")
        violations.push({
          id: "FD-GH-027",
          message: `${e.id}'s listed skip concluded ${conclusion}`,
        });
      if (listedSkip) reached.neutralSkip!++;
      else {
        reached.notNeutral!++;
        reached[`class ${e.className}`]!++;
        if (e.outcome._tag === "Deferred" || e.outcome._tag === "Expired")
          reached.deferredOrExpired!++;
      }
    }
    if (p.gh.alarms.some((a) => a.name === "neutral-invariant"))
      violations.push({
        id: "FD-GH-027",
        message: "a conclusion raised the neutral-invariant alarm",
      });
  } finally {
    await p.dispose();
  }
  return { violations, reached, trace };
};

// ---------------------------------------------------------------------------------------------------------------------
// FD-GH-058: at the reserve only check.open and check.conclude rows get a permit

export const simulateInstallationReserve = async (seed: number): Promise<SimOutcome> => {
  const random = seededRandom(seed);
  const pick = <A>(xs: readonly A[]): A => xs[Math.floor(random() * xs.length)]!;
  const violations: SimViolation[] = [];
  const trace: string[] = [];
  const reached: Record<string, number> = {
    reserveGranted: 0,
    outcomeRowGranted: 0,
    othersHeld: 0,
    crossedIntoReserve: 0,
    othersAfterReset: 0,
  };
  const p = await plane(quotaOptionsDefault);
  try {
    expectReserveDefault(violations);
    const limit = 100 + Math.floor(random() * 4900);
    const reserve = Math.floor(limit * quotaOptionsDefault.reserveFraction);
    // At, or a few calls above, the reserve: the drain crosses into it on some seeds.
    const remaining = reserve - Math.floor(random() * 3) + Math.floor(random() * 4);
    const resetAt = p.now() + HOUR_MS;
    await p.observe({ limit, remaining, resetAt });
    trace.push(`limit ${limit} remaining ${remaining}`);

    const executions: Execution[] = Array.from(
      { length: 2 + Math.floor(random() * 6) },
      (_, i) => ({
        id: idOf(i + 1),
        run: `run-${i}`,
        attempt: 1,
        className: pick(CLASSES),
        outcome: pick(OUTCOMES),
      }),
    );
    for (const e of executions) {
      await p.admit(e);
      const name = checkName(e.run);
      if (random() < 0.6)
        await p.insert(e, "check.start", "cp:check:start:1", {
          name,
          head_sha: SHA,
          epoch: 1,
          executor_kind: "device",
          attempt: 1,
        });
      if (random() < 0.5)
        await p.insert(e, "check.summary", "run:summary", {
          name,
          head_sha: SHA,
          title: "lint",
          markdown: "3 errors",
        });
      if (random() < 0.7) {
        await p.terminal(e);
        trace.push(`${e.id} ends ${outcomeTitle(e.outcome)}`);
      } else trace.push(`${e.id} live`);
    }

    // The reserve period: drains before the reset.
    for (let pass = 0; pass < 5; pass++) {
      await p.advance(Math.floor(random() * 10 * MINUTE_MS));
      await p.drain();
    }
    const before = p.permits.filter((x) => x.at < resetAt);
    for (const x of before) {
      const atReserve = x.share <= quotaOptionsDefault.reserveFraction;
      const reserveKind = RESERVE_KINDS.includes(x.kind);
      if (atReserve && x.granted && !reserveKind)
        violations.push({
          id: "FD-GH-058",
          message: `a ${x.kind} ${x.call} got a permit at ${x.share.toFixed(3)} of the limit`,
        });
      if (x.share > 0 && reserveKind && !x.granted)
        violations.push({
          id: "FD-GH-058",
          message: `a ${x.kind} ${x.call} waited at ${x.share.toFixed(3)} of the limit`,
        });
      if (atReserve && reserveKind && x.granted) reached.reserveGranted!++;
      if (atReserve && x.kind === "check.conclude" && x.granted) reached.outcomeRowGranted!++;
      if (atReserve && !reserveKind && !x.granted) reached.othersHeld!++;
    }
    if (before.some((x) => x.share > quotaOptionsDefault.reserveFraction && x.granted))
      reached.crossedIntoReserve!++;

    // After the reset the budget refills and every held row goes out.
    await p.advance(Math.max(0, resetAt - p.now()) + 1);
    if (!(await drainAll(p, 10 * MINUTE_MS, 200)))
      violations.push({ id: "FD-GH-058", message: "the outbox never went quiet after the reset" });
    reached.othersAfterReset! += p.permits.filter(
      (x) => x.at >= resetAt && x.granted && !RESERVE_KINDS.includes(x.kind),
    ).length;
    for (const e of executions)
      if (runsOf(p.gh, e.id).length !== 1)
        violations.push({
          id: "FD-GH-058",
          message: `${e.id} has ${runsOf(p.gh, e.id).length} check runs`,
        });
  } finally {
    await p.dispose();
  }
  return { violations, reached, trace };
};

const expectReserveDefault = (violations: SimViolation[]) => {
  if (quotaOptionsDefault.reserveFraction !== 0.1)
    violations.push({
      id: "FD-GH-058",
      message: `the default reserve fraction is ${quotaOptionsDefault.reserveFraction}`,
    });
};

// ---------------------------------------------------------------------------------------------------------------------
// FD-GH-062: apply permits capped in any 60 s and any hour; lookups and reconciles uncounted

export const simulateApplyCaps = async (seed: number): Promise<SimOutcome> => {
  const random = seededRandom(seed);
  const pick = <A>(xs: readonly A[]): A => xs[Math.floor(random() * xs.length)]!;
  const violations: SimViolation[] = [];
  const trace: string[] = [];
  const reached: Record<string, number> = {
    defaults: 0,
    minuteCapHit: 0,
    hourCapHit: 0,
    lookupWhileCapped: 0,
    lostAnswer: 0,
    failedCall: 0,
  };
  // Every tenth seed runs the defaults past 80 calls a minute; the rest run small configured caps.
  const defaults = seed % 10 === 0;
  const perMinute = defaults ? quotaOptionsDefault.perMinute : 2 + Math.floor(random() * 6);
  const perHour = defaults
    ? quotaOptionsDefault.perHour
    : perMinute * (2 + Math.floor(random() * 4));
  const options: QuotaOptions = { ...quotaOptionsDefault, perMinute, perHour };
  const p = await plane(options);
  try {
    if (defaults) {
      reached.defaults!++;
      if (perMinute !== 80 || perHour !== 500)
        violations.push({
          id: "FD-GH-062",
          message: `the defaults are ${perMinute}/min, ${perHour}/h`,
        });
    }
    const count = defaults ? 45 + Math.floor(random() * 10) : 4 + Math.floor(random() * 10);
    trace.push(`caps ${perMinute}/min ${perHour}/h, ${count} executions`);
    const executions: Execution[] = Array.from({ length: count }, (_, i) => ({
      id: idOf(i + 1),
      run: `run-${i}`,
      attempt: 1,
      className: pick(CLASSES),
      outcome: pick(OUTCOMES),
    }));
    for (const e of executions) {
      await p.admit(e);
      await p.terminal(e);
    }
    const stepMs = defaults
      ? 1_000 + Math.floor(random() * 20_000)
      : 5_000 + Math.floor(random() * 5 * MINUTE_MS);
    for (let pass = 0; pass < 2_000 && p.open() > 0; pass++) {
      if (random() < 0.3) injectFault(p.gh, random, reached);
      await p.drain();
      await p.advance(stepMs);
    }
    if (p.open() > 0) violations.push({ id: "FD-GH-062", message: "the outbox never went quiet" });

    const applies = p.permits.filter((x) => x.call === "apply" && x.granted).map((x) => x.at);
    for (const t of applies) {
      const minute = applies.filter((u) => u > t - MINUTE_MS && u <= t).length;
      const hour = applies.filter((u) => u > t - HOUR_MS && u <= t).length;
      if (minute > perMinute)
        violations.push({
          id: "FD-GH-062",
          message: `${minute} apply permits in the 60 s to ${t - T0} ms`,
        });
      if (hour > perHour)
        violations.push({
          id: "FD-GH-062",
          message: `${hour} apply permits in the hour to ${t - T0} ms`,
        });
      if (minute === perMinute) reached.minuteCapHit!++;
      if (hour === perHour) reached.hourCapHit!++;
    }
    // A lookup still gets its permit at a moment an apply waits for the cap.
    const cappedAt = new Set(
      p.permits.filter((x) => x.call === "apply" && !x.granted).map((x) => x.at),
    );
    reached.lookupWhileCapped! += p.permits.filter(
      (x) => x.call !== "apply" && x.granted && cappedAt.has(x.at),
    ).length;
    for (const e of executions)
      if (runsOf(p.gh, e.id).length !== 1)
        violations.push({
          id: "FD-GH-062",
          message: `${e.id} has ${runsOf(p.gh, e.id).length} check runs`,
        });
  } finally {
    await p.dispose();
  }
  return { violations, reached, trace };
};

export const scenarios: readonly SimScenario[] = [
  {
    name: "check-run-once",
    ids: ["FD-GH-010"],
    run: async (seed) => throwOnViolations((await simulateCheckRunOnce(seed)).violations),
  },
  {
    name: "no-neutral-capacity",
    ids: ["FD-GH-027"],
    run: async (seed) => throwOnViolations((await simulateNoNeutralCapacity(seed)).violations),
  },
  {
    name: "installation-reserve",
    ids: ["FD-GH-058"],
    run: async (seed) => throwOnViolations((await simulateInstallationReserve(seed)).violations),
  },
  {
    name: "apply-caps",
    ids: ["FD-GH-062"],
    run: async (seed) => throwOnViolations((await simulateApplyCaps(seed)).violations),
  },
];
