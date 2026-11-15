// A job matrix parent's children and their check runs as `V-REPLAY` workflows (specs/runs/gate.md FD-GATE-031,
// FD-GATE-046). The `offload-test` parent runs on a workflow engine with no journal; each job it starts is admitted
// through intake's admission over D1 under the job's dedup key, with the job's check where the matrix sets
// `checkPerJob`. A job the parent awaits runs once: its `Execution` workflow's apply-outbox stage writes its outcome,
// and a job already terminal answers its recorded outcome. The outbox then drains through the check-run applier
// against a fake GitHub. A second run repeats the parent over the same D1 and GitHub, as an engine that lost the
// parent's journal runs it again.
import {
  ActuatorRateLimitLive,
  CheckRunApplierLive,
  installationQuotaLayer,
} from "@fractalboxdev/flare-dispatch-github";
import { fakeGithub, fakeGithubLayers } from "@fractalboxdev/flare-dispatch-github/testing";
import {
  GithubRead,
  GithubReadFailed,
  Outcome,
  type OffloadTestInput,
} from "@fractalboxdev/flare-dispatch-catalog";
import { offloadTestRun } from "@fractalboxdev/flare-dispatch-catalog/runs";
import {
  Admission,
  d1Admission,
  d1IntakeStore,
  IntakeStore,
} from "@fractalboxdev/flare-dispatch-intake";
import { migratedD1 } from "@fractalboxdev/flare-dispatch-intake/testing";
import { buildProfile, placementInputs } from "@fractalboxdev/flare-dispatch-profile";
import {
  dedupKey,
  drainOnce,
  ExecutionSteps,
  executionId as newExecutionId,
} from "@fractalboxdev/mameko-coordinator";
import { d1OutboxStore } from "@fractalboxdev/mameko-host-cloudflare/d1";
import { d1ExecutionSteps } from "@fractalboxdev/mameko-host-cloudflare/d1-execution";
import { intentList } from "@fractalboxdev/mameko-run";
import { Effect, Layer } from "effect";
import * as WorkflowEngine from "effect/workflow/WorkflowEngine";
import { MatrixChildren, type ChildRequest } from "../../../../packages/catalog/src/ports.ts";
import {
  seededRandom,
  type ReplayEffect,
  type ReplayWorkflow,
} from "../../../../packages/ops/src/verification/harness.ts";
import { executionConfig } from "../../src/config.ts";
import { concludeFactsLayer } from "../../src/github.ts";
import { envOf, record, type TestD1 } from "../conclude.test-support.ts";

const profile = buildProfile("production");
export const SCOPE = "acme/app";
export const SHA = "b".repeat(40);
/** The parent's run: a job's record carries it and the job key, which name the check the job concludes. */
const RUN = "offload-test";
export const PARENT_DEDUP_KEY = `offload-test:${SCOPE}:${SHA}`;
const MINUTE_MS = 60_000;

/** The matrix: a build job and a two-shard e2e job that needs it. */
const entry = (checkPerJob: boolean): OffloadTestInput["entry"] => ({
  jobs: [
    { key: "build", command: "pnpm build" },
    { key: "e2e", command: "pnpm e2e", shards: 2, needs: ["build"] },
  ],
  checkPerJob,
});

/** The expanded job keys, in expansion order. */
export const JOB_KEYS = ["build", "e2e-1", "e2e-2"] as const;

const input = (checkPerJob: boolean): OffloadTestInput => ({
  repo: `https://github.com/${SCOPE}.git`,
  sha: SHA,
  ref: "refs/heads/main",
  scope: SCOPE,
  entry: entry(checkPerJob),
  parentDedupKey: PARENT_DEDUP_KEY,
  trigger: "push-default",
  defaultBranch: "main",
});

/** The D1, the fake GitHub and the clock both runs advance, with every admission answer in order. */
export interface Journal {
  readonly db: TestD1;
  readonly gh: ReturnType<typeof fakeGithub>;
  clock: number;
  readonly admissions: { readonly key: string; readonly answer: string; readonly id: string }[];
  readonly requests: ChildRequest[];
}

/** Every outbox, execution and dedup-key row, keyed by table and id, with its full content. */
const snapshot = (db: TestD1): ReadonlyMap<string, string> =>
  new Map(
    [
      ["outbox", "select * from outbox", "id"],
      ["executions", "select * from executions", "id"],
      ["dedup_keys", "select * from dedup_keys", "sha256"],
    ].flatMap(([table, sql, key]) =>
      (db.sqlite.prepare(sql!).all() as Record<string, unknown>[]).map(
        (r) => [`${table} ${String(r[key!])}`, JSON.stringify(r)] as const,
      ),
    ),
  );

const admit = (j: Journal, request: ChildRequest, executionId: string) =>
  Effect.gen(function* () {
    const { facts, params } = placementInputs(profile, {
      class: "required",
      labels: [],
      confidentiality: "non-confidential",
    });
    const key = yield* Effect.promise(() =>
      dedupKey([{ name: "matrix-job", run: (k: string) => k }], request.dedupKey),
    );
    return yield* Admission.use((a) =>
      a.admit({
        executionId,
        scopeId: SCOPE,
        run: request.run,
        className: request.className ?? "required",
        labels: [],
        enqueuedAtMs: j.clock,
        dedup: {
          sha256: key.sha256,
          canonical: key.canonical,
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
        check: request.checkName === undefined ? null : { name: request.checkName, headSha: SHA },
      }),
    ).pipe(Effect.provide(d1Admission(j.db, profile)), Effect.orDie);
  });

/**
 * `MatrixChildren` over intake's admission: `start` admits the job under its dedup key and answers the execution the
 * key names; `await` answers a terminal job's recorded outcome, and first leases a pending job, accepts its `success`
 * at epoch 1 and runs its apply-outbox stage.
 */
const admittedChildren = (j: Journal) =>
  Layer.succeed(MatrixChildren, {
    start: (request) =>
      Effect.gen(function* () {
        j.requests.push(request);
        const id = newExecutionId(j.clock, seededRandom(j.requests.length));
        const answer = yield* admit(j, request, id);
        if (answer._tag !== "Queued" && answer._tag !== "Duplicate")
          return yield* Effect.die(`job ${request.key} admitted as ${answer._tag}`);
        j.admissions.push({ key: request.key, answer: answer._tag, id: answer.executionId });
        if (answer._tag === "Queued")
          yield* IntakeStore.use((s) =>
            s.put(record(answer.executionId, { run: RUN, label: request.key, sha: SHA })),
          ).pipe(Effect.provide(d1IntakeStore(j.db)), Effect.orDie);
        return { key: request.key, executionId: answer.executionId };
      }),
    await: (handle) =>
      Effect.gen(function* () {
        const status = () =>
          (
            j.db.sqlite
              .prepare("select status from executions where id = ?")
              .get(handle.executionId) as { status: string }
          ).status;
        if (status() === "pending") {
          // The job's lease at epoch 1 starts it, and the executor channel accepts its result at that epoch.
          j.db.sqlite
            .prepare(
              "update executions set status = 'running', started_at = ? where id = ? and status = 'pending'",
            )
            .run(j.clock, handle.executionId);
          j.db.sqlite
            .prepare(
              "update placements set state = 'accepted', epoch = 1, accepted_epoch = 1, executor_id = 'cf-1' where execution_id = ?",
            )
            .run(handle.executionId);
          yield* ExecutionSteps.use((steps) =>
            steps.applyOutbox(handle.executionId, { _tag: "Success", epoch: 1 }, 1),
          ).pipe(
            Effect.provide(
              d1ExecutionSteps(j.db, {
                ...executionConfig(profile),
                meteredCost: () => Effect.succeed(0),
              }),
            ),
          );
        }
        return status() === "success"
          ? { _tag: "Recorded" as const, outcome: Outcome.success() }
          : { _tag: "Recorded" as const, outcome: Outcome.failure(`exit: ${status()}`) };
      }),
    cancel: () => Effect.void,
    discover: (request) => Effect.die(`no discovery in this matrix: ${request.key}`),
  });

const unread = (what: string) => Effect.fail(new GithubReadFailed({ what, detail: "not read" }));
const githubRead = Layer.succeed(GithubRead, {
  branchHead: (_repo, branch) => unread(branch),
  tagCommit: (_repo, tag) => unread(tag),
  reachableFrom: (_repo, sha) => unread(sha),
});

const drainAll = async (j: Journal) => {
  for (let pass = 0; pass < 10; pass++) {
    j.clock += MINUTE_MS;
    const now = j.clock;
    await Effect.runPromise(
      drainOnce({
        now,
        token: (id) => `tok-${id}-${now}`,
        random: () => 0,
        actuatorOf: { "check.open": "checkRun", "check.conclude": "checkRun" },
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            d1OutboxStore(j.db),
            CheckRunApplierLive.pipe(
              Layer.provide(Layer.merge(fakeGithubLayers(j.gh), concludeFactsLayer(envOf(j.db)))),
            ),
            ActuatorRateLimitLive.pipe(
              Layer.provide(Layer.merge(installationQuotaLayer(), fakeGithubLayers(j.gh))),
            ),
          ),
        ),
      ),
    );
    const open = j.db.sqlite
      .prepare("select count(*) as n from outbox where state in ('pending', 'in_flight')")
      .get() as { n: number };
    if (open.n === 0) return;
  }
};

/** Runs the parent on a fresh engine over the journal's D1, then drains its children's check rows. */
export const parent =
  (checkPerJob: boolean) =>
  async (journal: Journal | null): Promise<{ journal: Journal; effects: ReplayEffect[] }> => {
    const j: Journal = journal ?? {
      db: await migratedD1(),
      gh: fakeGithub(),
      // A terminal write stamps its rows with the store's clock, so every admission and drain runs after it.
      clock: Date.now() + 1_000,
      admissions: [],
      requests: [],
    };
    const calls = j.gh.calls.length;
    const before = snapshot(j.db);
    const result = await Effect.runPromise(
      offloadTestRun.workflow
        .execute({
          workflow_version: 1,
          execution_id: "parent",
          run: RUN,
          run_digest: "sha256:none",
          run_version: "2.0.0",
          scope_id: SCOPE,
          request_context: {},
          class: "required",
          epoch: 1,
          deadline_at: j.clock + 3_600_000,
          attempt: 0,
          input: input(checkPerJob),
        })
        .pipe(
          Effect.provide(
            Layer.provideMerge(
              offloadTestRun.layer,
              Layer.mergeAll(
                admittedChildren(j),
                githubRead,
                intentList().layer,
                WorkflowEngine.layerMemory,
              ),
            ),
          ),
        ),
    );
    if (result._tag !== "success") throw new Error(`parent ended ${JSON.stringify(result)}`);
    if (checkPerJob) await drainAll(j);
    const after = snapshot(j.db);
    const effects: ReplayEffect[] = [
      ...j.gh.calls.slice(calls).map((call): ReplayEffect => ({ kind: "github", key: call })),
      ...[...after]
        .filter(([key, row]) => before.get(key) !== row)
        .map(([key]): ReplayEffect => ({ kind: "d1", key })),
      ...[...after.keys()]
        .filter((key) => key.startsWith("outbox ") && !before.has(key))
        .map((key): ReplayEffect => ({ kind: "intent", key })),
    ];
    return { journal: j, effects };
  };

export const workflows: readonly ReplayWorkflow<Journal>[] = [
  { name: "matrix-job-dedup", ids: ["FD-GATE-031"], run: parent(false) },
  { name: "matrix-job-checks", ids: ["FD-GATE-046"], run: parent(true) },
];
