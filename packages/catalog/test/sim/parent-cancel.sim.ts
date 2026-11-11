// The job matrix's parent cancel as a V-SIM scenario (specs/runs/gate.md § Job matrix, FD-GATE-042). A seed fixes the
// matrix's size and window, which started jobs an executor has claimed, which jobs record their verdict, and when the
// parent is cancelled. Each job is a child execution admitted under the parent in mameko's store on a SQLite D1; the
// parent's `runMatrix` runs in its own fiber over them. The cancel interrupts that fiber, then ends the parent in
// mameko's stage work, whose parent-ended cascade ends every live child. The scenario then checks that the parent
// cancelled exactly its placed and running jobs, that each of them ended `cancelled(parent-ended)` and had its workflow
// and lease cancelled, and that no pending job started.
import { buildProfile, type Profile } from "@fractalboxdev/flare-dispatch-profile";
import { ExecutionSteps } from "@fractalboxdev/mameko-coordinator";
import { admitExecution, d1PlacementStore } from "@fractalboxdev/mameko-host-cloudflare/d1";
import { d1ExecutionSteps } from "@fractalboxdev/mameko-host-cloudflare/d1-execution";
import { PlacementStore, type AdmissionRequest } from "@fractalboxdev/mameko-ports";
import { Deferred, Effect, Fiber, Layer, ManagedRuntime, Queue } from "effect";
import { migratedD1 } from "../../../intake/src/testing.ts";
import {
  seededRandom,
  throwOnViolations,
  type SimScenario,
  type SimViolation,
} from "../../../ops/src/verification/harness.ts";
import { runMatrix, type ExpandedJob, type MatrixPlan } from "../../src/matrix.ts";
import { MatrixChildren, type ChildVerdict } from "../../src/ports.ts";
import { Outcome } from "../../src/reasons.ts";

const T0 = Date.UTC(2026, 10, 4, 12, 0, 0);
const PARENT = "parent";
const SHA = "a".repeat(40);

export interface ParentCancelOutcome {
  readonly violations: readonly SimViolation[];
  readonly reached: Readonly<Record<string, number>>;
  readonly trace: readonly string[];
}

/** The stage configuration with no hold terms; `childrenCancelled` records what the cascade hands the engine. */
const stageConfig = (profile: Profile, cascaded: string[]) => ({
  classes: Object.fromEntries(
    profile.classes.map((c) => [
      c.name,
      {
        rank: c.rank,
        guaranteed: c.guaranteed,
        rateMicroUsdPerS: 0,
        settleMarginS: 0,
        modelAllowanceMicroUsd: 0,
        networkEstimateMicroUsd: 0,
      },
    ]),
  ),
  outcomeKind: profile.outcome_mapping.surface_kind,
  outcomeEffectClass: "adoptable" as const,
  meteredCost: () => Effect.succeed(null),
  childrenCancelled: (ids: readonly string[]) => Effect.sync(() => void cascaded.push(...ids)),
});

const request = (executionId: string, at: number, parent: string | null): AdmissionRequest => ({
  executionId,
  scopeId: "acme/app",
  run: parent === null ? "offload-test" : "gate-job",
  className: "interactive",
  enqueuedAtMs: at,
  dedup: {
    sha256: `k-${executionId}`,
    canonical: executionId,
    requestDigest: null,
    onMismatch: "duplicate",
  },
  bounds: { global: 100, perScope: 100 },
  terminalOutcome: "failure",
  parentExecutionId: parent,
});

const job = (key: string): ExpandedJob => ({
  key,
  command: "pnpm test",
  needs: [],
  env: {},
  heavy: false,
  retries: 0,
  timeoutSec: 600,
  source: { key, command: "pnpm test" },
});

export const simulateParentCancel = async (seed: number): Promise<ParentCancelOutcome> => {
  const random = seededRandom(seed);
  const violations: SimViolation[] = [];
  const trace: string[] = [];
  const reached: Record<string, number> = {
    placedCancelled: 0,
    runningCancelled: 0,
    finishedFirst: 0,
    neverStarted: 0,
  };
  const db = await migratedD1();
  const profile = buildProfile("development");
  const cascaded: string[] = [];
  const layer = Layer.mergeAll(
    d1PlacementStore(db),
    d1ExecutionSteps(db, stageConfig(profile, cascaded)),
  );
  const runtime = ManagedRuntime.make(layer);
  const rows = (sql: string, ...params: unknown[]) =>
    db.sqlite.prepare(sql).all(...(params as never[])) as Record<string, unknown>[];
  const statusOf = (id: string) =>
    rows("select status, reason from executions where id = ?", id)[0] as
      | { status: string; reason: string | null }
      | undefined;

  const claim = (id: string) =>
    Effect.gen(function* () {
      const epoch = rows("select epoch from placements where execution_id = ?", id)[0]!
        .epoch as number;
      const placed = yield* PlacementStore.use((p) =>
        p.claim(id, { expectedEpoch: epoch, executorId: "dev-1", floor: 0 }),
      );
      return placed?.epoch ?? null;
    });

  const size = 3 + Math.floor(random() * 10);
  const keys = Array.from({ length: size }, (_, i) => `j${i + 1}`);
  const plan: MatrixPlan = {
    run: "offload-test",
    parentDedupKey: `offload-test:acme/app:${SHA}`,
    ctx: { repo: "https://github.com/acme/app.git", sha: SHA, ref: "refs/heads/main" },
    jobs: keys.map(job),
    window: 1 + Math.floor(random() * 4),
    failFast: false,
    checkPerJob: false,
  };
  const cancelAfter = Math.floor(random() * size);

  try {
    await runtime.runPromise(
      Effect.gen(function* () {
        yield* admitExecution(db, request(PARENT, T0, null));
        yield* claim(PARENT);

        /** Each started job: its child execution, its lease epoch once claimed, and the verdict it awaits. */
        const started = new Map<
          string,
          {
            readonly id: string;
            epoch: number | null;
            readonly verdict: Deferred.Deferred<ChildVerdict>;
            waiter?: Fiber.Fiber<unknown, unknown>;
          }
        >();
        const finished = new Set<string>();
        const cancelled: string[] = [];
        const ready = yield* Queue.unbounded<string>();
        let admittedAt = T0;

        const children = Layer.succeed(MatrixChildren, {
          start: (r) =>
            Effect.gen(function* () {
              const id = `child-${r.key}`;
              yield* admitExecution(db, request(id, ++admittedAt, PARENT)).pipe(Effect.orDie);
              // An executor claims some jobs at once; the rest stay placed.
              const epoch = random() < 0.5 ? yield* claim(id) : null;
              started.set(r.key, { id, epoch, verdict: yield* Deferred.make<ChildVerdict>() });
              trace.push(`start ${r.key}${epoch === null ? "" : " claimed"}`);
              return { key: r.key, executionId: id };
            }).pipe(Effect.provide(layer)),
          await: (handle) =>
            Effect.withFiber((waiter) =>
              Effect.gen(function* () {
                const child = started.get(handle.key)!;
                child.waiter = waiter;
                yield* Queue.offer(ready, handle.key);
                return yield* Deferred.await(child.verdict);
              }),
            ),
          cancel: (handle) => Effect.sync(() => void cancelled.push(handle.executionId)),
          discover: () => Effect.succeed({ _tag: "Exited", code: 0, output: "[]" } as const),
        });

        const fiber = yield* Effect.forkChild(runMatrix(plan).pipe(Effect.provide(children)));
        // A job is ready only once the matrix has registered its handle and forked its verdict waiter. Counting
        // scheduler yields cannot establish this: D1 admission crosses Promise boundaries even on in-memory SQLite.
        const initial = Math.min(size, plan.window);
        for (let i = 0; i < initial; i++) yield* Queue.take(ready);
        for (let step = 0; step < cancelAfter; step++) {
          const open = [...started].filter(([key]) => !finished.has(key));
          if (open.length === 0) break;
          const [key, child] = open[Math.floor(random() * open.length)]!;
          child.epoch ??= yield* claim(child.id);
          yield* ExecutionSteps.use((s) =>
            s.applyOutbox(child.id, { _tag: "Success", epoch: child.epoch ?? 1 }, null),
          );
          finished.add(key);
          trace.push(`finish ${key}`);
          yield* Deferred.succeed(child.verdict, {
            _tag: "Recorded",
            outcome: Outcome.success(),
          });
          // The waiter exits after runMatrix has offered the verdict to its completion queue. Drain the scheduler
          // so the parent consumes it, including when all jobs have started and there is no replacement to await.
          yield* Fiber.await(child.waiter!);
          yield* Effect.sync(() => fiber.currentDispatcher.flush());
          if (initial + finished.size <= size) yield* Queue.take(ready);
        }

        // The parent is cancelled: its workflow is interrupted, then its own end runs the cascade.
        const live = [...started].filter(([key]) => !finished.has(key));
        const startedBefore = started.size;
        trace.push(`cancel with ${live.map(([k]) => k).join(",")}`);
        yield* Fiber.interrupt(fiber);
        yield* ExecutionSteps.use((s) =>
          s.applyOutbox(PARENT, { _tag: "Cancelled", cause: "operator-cancel" }, null),
        );

        const liveIds = live.map(([, c]) => c.id).sort();
        if (JSON.stringify([...cancelled].sort()) !== JSON.stringify(liveIds))
          violations.push({
            id: "FD-GATE-042",
            message: `the parent cancelled ${cancelled.join(",")}, its placed or running jobs are ${liveIds.join(",")}`,
          });
        if (JSON.stringify([...cascaded].sort()) !== JSON.stringify(liveIds))
          violations.push({
            id: "FD-GATE-042",
            message: `the cascade cancelled the workflows of ${cascaded.join(",")}, not ${liveIds.join(",")}`,
          });
        for (const [key, child] of live) {
          const row = statusOf(child.id);
          if (row?.status !== "cancelled" || row.reason !== "parent-ended")
            violations.push({
              id: "FD-GATE-042",
              message: `job ${key} ended ${JSON.stringify(row)}, not cancelled(parent-ended)`,
            });
          if (child.epoch === null) reached.placedCancelled!++;
          else reached.runningCancelled!++;
        }
        for (const key of finished) {
          const row = statusOf(started.get(key)!.id);
          if (row?.status !== "success")
            violations.push({
              id: "FD-GATE-042",
              message: `job ${key} finished before the cancel and ended ${JSON.stringify(row)}`,
            });
          reached.finishedFirst!++;
        }
        // A pending job never starts: no child execution is admitted once the parent is cancelled.
        const admitted = rows(
          "select count(*) as n from executions where parent_id = ?",
          PARENT,
        )[0]!.n as number;
        if (started.size !== startedBefore || admitted !== startedBefore)
          violations.push({
            id: "FD-GATE-042",
            message: `${admitted} jobs admitted, ${startedBefore} started before the cancel`,
          });
        reached.neverStarted! += size - startedBefore;
      }),
    );
  } finally {
    await runtime.dispose();
  }
  return { violations, reached, trace };
};

export const scenarios: readonly SimScenario[] = [
  {
    name: "parent-cancel",
    ids: ["FD-GATE-042"],
    run: async (seed) => throwOnViolations((await simulateParentCancel(seed)).violations),
  },
];
