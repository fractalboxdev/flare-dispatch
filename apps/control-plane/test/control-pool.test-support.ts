// An `offload-test` parent in the `control` pool on the composed control plane: the parent admitted through intake's
// submit, claimed by the `control` pool, and run from the pool's catalogue as host-cloudflare's `ControlPool` runs it,
// with the live `MatrixChildren` over intake's admission. An executor stand-in ends each admitted job the way the
// `Execution` workflow's apply-outbox stage records a lease's end: the job's lease at an epoch, then the terminal write.
import type { OffloadTestInput } from "@fractalboxdev/flare-dispatch-catalog";
import { lookupRun } from "@fractalboxdev/flare-dispatch-catalog";
import {
  catalogRuns,
  d1Admission,
  d1IntakeStore,
  d1ShedRecorder,
  IntakeConfig,
  IntakeStore,
  submission,
  submit,
  type IntakeSettings,
} from "@fractalboxdev/flare-dispatch-intake";
import {
  migratedD1,
  recordingHeldChecks,
  recordingResolver,
} from "@fractalboxdev/flare-dispatch-intake/testing";
import { buildProfile } from "@fractalboxdev/flare-dispatch-profile";
import {
  ExecutionSteps,
  type ExecutionOutcome,
  type ExecutionPayload,
} from "@fractalboxdev/mameko-coordinator";
import { d1PlacementStore } from "@fractalboxdev/mameko-host-cloudflare/d1";
import { d1ExecutionSteps } from "@fractalboxdev/mameko-host-cloudflare/d1-execution";
import { PlacementStore } from "@fractalboxdev/mameko-ports";
import { memoryLocalContent } from "@fractalboxdev/mameko-run";
import { catalogRun, runProgram } from "@fractalboxdev/mameko-runner/program";
import { Effect, Layer, Match, type Context } from "effect";
import * as WorkflowEngine from "effect/workflow/WorkflowEngine";
import { executionConfig, profileOf } from "../src/config.ts";
import { controlPoolRuns } from "../src/control-pool.ts";
import { requestLeaseFields } from "../src/lease.ts";
import { envOf, type TestD1 } from "./conclude.test-support.ts";

export const SCOPE = "acme/app";
export const SHA = "b".repeat(40);
export const PARENT_DEDUP_KEY = `offload-test:${SCOPE}:${SHA}`;
/** How often the parent reads its awaited children's rows here. */
const POLL_MS = 5;

/**
 * A `development` deploy, whose catalogue serves `gate-job`, the run each job executes; a `production` deploy refuses
 * the host-execution run. Its services are intake's over the deploy's D1, as the isolate builds them, with class
 * resolution answering each run's default class; its `ExecutionEngine` records each start.
 */
export const deploy = async () => {
  const db = await migratedD1();
  const starts: ExecutionPayload[] = [];
  const env = envOf(db, { DEPLOYMENT: "development" });
  const profile = profileOf(env);
  const settings: IntakeSettings = {
    catalog: catalogRuns("development"),
    profile,
    appId: 0,
    webhookSecret: undefined,
    webhookEvents: undefined,
    allows: () => true,
    confidentiality: () => "non-confidential",
    writeCredentialIn: () => null,
  };
  const services = await Effect.runPromise(
    Effect.scoped(
      Layer.build(
        Layer.mergeAll(
          Layer.succeed(IntakeConfig, settings),
          d1Admission(db, profile, {
            startExecution: (payload) => Effect.sync(() => void starts.push(payload)),
          }),
          d1IntakeStore(db),
          d1ShedRecorder(db),
          recordingResolver(),
          recordingHeldChecks(),
        ),
      ),
    ),
  );
  const isolate = () => Promise.resolve(services);
  return { db, env, starts, services: services as Context.Context<never>, isolate };
};
export type Deploy = Awaited<ReturnType<typeof deploy>>;

/** The matrix: a build job and a two-shard e2e job that needs it. */
export const matrixInput = (checkPerJob: boolean): OffloadTestInput => ({
  repo: `https://github.com/${SCOPE}.git`,
  sha: SHA,
  ref: "refs/heads/main",
  scope: SCOPE,
  entry: {
    jobs: [
      { key: "build", command: "pnpm build" },
      { key: "e2e", command: "pnpm e2e", shards: 2, needs: ["build"] },
    ],
    checkPerJob,
  },
  parentDedupKey: PARENT_DEDUP_KEY,
  trigger: "push-default",
  defaultBranch: "main",
});

/** The expanded job keys, in expansion order. */
export const JOB_KEYS = ["build", "e2e-1", "e2e-2"] as const;

/** Admits the parent through intake's submit, as a dispatch of `offload-test` at class `required`. */
export const admitParent = (d: Deploy, input: OffloadTestInput) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const run = (yield* IntakeConfig).catalog("offload-test")!;
      return yield* submit(
        submission({
          run,
          trigger: "dispatch",
          repo: SCOPE,
          sha: SHA,
          ref: "refs/heads/main",
          inputs: input,
          forcedClass: "required",
        }),
      );
    }).pipe(Effect.provide(d.services)) as unknown as Effect.Effect<{
      readonly executionId: string;
    }>,
  );

/** Whether `executorId`'s claim of the queued execution wins its lease. */
export const claimedBy = (db: TestD1, executionId: string, executorId: string) =>
  Effect.runPromise(
    PlacementStore.use((p) =>
      Effect.gen(function* () {
        const placed = yield* p.get(executionId);
        return (
          (yield* p.claim(executionId, {
            expectedEpoch: placed!.epoch,
            executorId,
            floor: 0,
          })) !== null
        );
      }),
    ).pipe(Effect.provide(d1PlacementStore(db))),
  );

/** The run payload of the parent's lease at `epoch`, as the control plane writes the lease. */
export const parentPayload = async (d: Deploy, executionId: string, epoch: number) => {
  const record = await Effect.runPromise(
    IntakeStore.use((s) => s.get(executionId)).pipe(Effect.provide(d1IntakeStore(d.db))),
  );
  const entry = Match.value(lookupRun("development", "offload-test")).pipe(
    Match.tag("Available", ({ entry }) => entry),
    Match.orElse(() => null),
  );
  const row = d.db.sqlite
    .prepare("select scope_id, deadline_at from mameko_executions where id = ?")
    .get(executionId) as { scope_id: string; deadline_at: number };
  const lease = requestLeaseFields(entry, record!, row);
  return {
    workflow_version: lease.workflow_version,
    execution_id: executionId,
    run: "offload-test",
    run_digest: lease.run_digest,
    run_version: lease.run_version,
    scope_id: row.scope_id,
    request_context: lease.request_context,
    class: "required",
    epoch,
    deadline_at: row.deadline_at,
    attempt: epoch - 1,
    input: lease.inputs,
  };
};

/**
 * Runs the parent's lease at `epoch` from the `control` pool's catalogue, with `LocalContent` and `Intents` alone and
 * a fresh journal in memory, as an object that lost the parent's journal runs it.
 */
export const runParent = async (d: Deploy, executionId: string, epoch: number) => {
  const payload = await parentPayload(d, executionId, epoch);
  const run = await catalogRun(controlPoolRuns(d.env, d.isolate, { pollMs: POLL_MS }), payload);
  if (run === undefined) throw new Error("the control pool's catalogue holds no offload-test");
  return runProgram({
    run,
    payload: payload as never,
    store: memoryLocalContent(),
    services: Layer.empty,
    engine: (programs) => programs.pipe(Layer.provideMerge(WorkflowEngine.layerMemory)),
  });
};

/** One admitted job: its execution, its job key (its record's label), status and dedup key. */
export interface ChildRow {
  readonly id: string;
  readonly key: string;
  readonly status: string;
  readonly reason: string | null;
  readonly class: string;
  readonly canonical: string;
}

/** The parent's children, by job key. */
export const childrenOf = (db: TestD1, parentId: string): readonly ChildRow[] =>
  db.sqlite
    .prepare(
      `select e.id, r.label as key, e.status, e.reason, e.class, k.canonical from mameko_executions e
       join intake_records r on r.execution_id = e.id
       join mameko_dedup_keys k on k.execution_id = e.id
       where e.parent_id = ? order by r.label`,
    )
    .all(parentId) as unknown as ChildRow[];

/** The job's lease at `epoch` on a device, which the channel leased and whose result it accepted. */
const leaseAt = (db: TestD1, executionId: string, epoch: number) => {
  db.sqlite
    .prepare("update mameko_executions set status = 'running', started_at = ? where id = ?")
    .run(Date.now(), executionId);
  db.sqlite
    .prepare(
      "update mameko_placements set state = 'accepted', epoch = ?, accepted_epoch = ?, executor_id = 'device-1' where execution_id = ?",
    )
    .run(epoch, epoch, executionId);
};

/** The `Execution` workflow's apply-outbox stage for a lease that ended with `outcome` at `epoch`. */
export const endChild = (db: TestD1, executionId: string, outcome: ExecutionOutcome) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const epoch = "epoch" in outcome && outcome.epoch !== null ? outcome.epoch : 1;
      yield* Effect.sync(() => leaseAt(db, executionId, epoch));
      yield* ExecutionSteps.use((steps) => steps.applyOutbox(executionId, outcome, epoch));
    }).pipe(
      Effect.provide(
        d1ExecutionSteps(db, {
          ...executionConfig(buildProfile("production")),
          meteredCost: () => Effect.succeed(0),
        }),
      ),
    ),
  );

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs `parent` while an executor stand-in ends each job the parent admits, once, with the outcome `outcomeOf` gives
 * its job key; answers the parent's end.
 */
export const withExecutor = async <A>(
  d: Deploy,
  parentId: string,
  parent: Promise<A>,
  outcomeOf: (key: string) => ExecutionOutcome = () => ({ _tag: "Success", epoch: 1 }),
): Promise<A> => {
  let done = false;
  const ended = parent.finally(() => void (done = true));
  const executor = (async () => {
    while (!done) {
      for (const child of childrenOf(d.db, parentId))
        if (child.status === "pending") await endChild(d.db, child.id, outcomeOf(child.key));
      await sleep(POLL_MS);
    }
  })();
  const [result] = await Promise.all([ended, executor]);
  return result;
};
