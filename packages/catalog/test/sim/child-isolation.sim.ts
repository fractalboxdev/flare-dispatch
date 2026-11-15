// The job matrix's children as a V-SIM scenario (specs/runs/gate.md § Job matrix, FD-GATE-030). A seed fixes the
// matrix's jobs, some sharded, its window, the class the parent runs at and which device executor claims each child.
// The parent's `runMatrix` runs over the live `MatrixChildren` (intake's `matrixChildrenLayer`): each job is admitted
// as a child execution under the parent through intake's admission on a SQLite D1, and the parent waits for the
// child's terminal row. An executor claims each admitted child with a hold in mameko's claim transaction, runs the
// `gate-job` recipe on this host's processes, and records the child's end: a checkout of a local repository's commit
// into the workspace `processGateExec` makes, then a job command that fails if the workspace holds anything besides the
// checkout or loses the job's own marker while other jobs run. The scenario checks that each job had its own child
// execution, placement, execution lease, hold and workspace, that no two jobs shared a workspace, and that each
// workspace is gone once its job ends. `scenarios` is what the `sim` job runs (packages/ops/scripts/harness.ts): each
// seed fails on any violation.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildProfile } from "@fractalboxdev/flare-dispatch-profile";
import { admitExecution, d1PlacementStore } from "@fractalboxdev/mameko-host-cloudflare/d1";
import { holdMicroUsd } from "@fractalboxdev/mameko-kernel";
import { PlacementStore, type AdmissionRequest } from "@fractalboxdev/mameko-ports";
import { Effect, Layer, ManagedRuntime } from "effect";
import { catalogRuns } from "../../../intake/src/catalog.ts";
import { matrixChildrenLayer } from "../../../intake/src/children.ts";
import { d1Admission, IntakeConfig } from "../../../intake/src/config.ts";
import { d1IntakeStore, IntakeStore } from "../../../intake/src/store.ts";
import { migratedD1 } from "../../../intake/src/testing.ts";
import {
  seededRandom,
  throwOnViolations,
  type SimScenario,
  type SimViolation,
} from "../../../ops/src/verification/harness.ts";
import { GateExec, processGateExec } from "../../src/command.ts";
import { fakeArtifacts } from "../../src/gate.test-support.ts";
import { ExecutionLease } from "../../src/execution-lease.ts";
import type { GateJobInput } from "../../src/inputs.ts";
import { runGateJob } from "../../src/job.ts";
import type { MatrixJob } from "../../src/manifest.ts";
import { expandMatrix, runMatrix } from "../../src/matrix.ts";
import { MatrixChildren } from "../../src/ports.ts";
import { isSuccess } from "../../src/reasons.ts";

export const SCENARIO = "child-isolation";

/** The parent's admission; a child's deadline ends before its parent's, so the parent's lies ahead of the clock. */
const T0 = Date.now();
const PARENT = "parent";
const SCOPE = "acme/app";
const MONTH = "2026-11";
const EXECUTORS = ["dev-1", "dev-2", "dev-3"];
/** mameko's settle margin, which FlareDispatch keeps (specs/profile.md § Class catalogue). */
const SETTLE_MARGIN_S = 300;
const PROFILE = buildProfile("production");
const CLASSES = PROFILE.classes.filter((c) => c.terminal_outcome !== "deferred").map((c) => c.name);

/** Intake's services over the D1: its configuration under a `development` catalogue, which serves `gate-job`. */
const intake = (db: Awaited<ReturnType<typeof migratedD1>>) =>
  Layer.mergeAll(
    Layer.succeed(IntakeConfig, {
      catalog: catalogRuns("development"),
      profile: PROFILE,
      appId: 0,
      webhookSecret: undefined,
      webhookEvents: undefined,
      allows: () => true,
      confidentiality: () => "non-confidential",
      writeCredentialIn: () => null,
    }),
    d1Admission(db, PROFILE),
    d1IntakeStore(db),
  );

/**
 * The job command: the workspace holds only the checkout's `.git` and `README` when the job starts, and still holds the
 * job's own marker after a pause in which the other placed jobs run.
 */
const JOB_COMMAND =
  'test "$(ls -A | wc -l | tr -d " ")" = 2 && test -f README && echo "$FD_JOB" > owner && sleep 0.01 && test "$(cat owner)" = "$FD_JOB"';

/** One commit in a local repository, made once per process and removed at its exit, which every job checks out. */
let fixture: { readonly repo: string; readonly sha: string } | undefined;
const repository = () => {
  if (fixture !== undefined) return fixture;
  const repo = mkdtempSync(join(tmpdir(), "fd-sim-repo-"));
  process.once("exit", removeRepository);
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: repo,
      encoding: "utf8",
      env: {
        PATH: process.env["PATH"],
        HOME: repo,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@example.com",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@example.com",
      },
    }).trim();
  git("init", "-q");
  writeFileSync(join(repo, "README"), "fixture\n");
  git("add", ".");
  git("commit", "-q", "-m", "fixture");
  fixture = { repo: `file://${repo}`, sha: git("rev-parse", "HEAD") };
  return fixture;
};

/** Removes the local repository, which the next `repository()` makes again. */
export const removeRepository = () => {
  if (fixture === undefined) return;
  rmSync(fixture.repo.slice("file://".length), { recursive: true, force: true });
  fixture = undefined;
};

export interface IsolationOutcome {
  readonly violations: readonly SimViolation[];
  readonly reached: Readonly<Record<string, number>>;
  readonly trace: readonly string[];
}

const request = (
  executionId: string,
  at: number,
  className: string,
  parent: string | null,
): AdmissionRequest => ({
  executionId,
  scopeId: SCOPE,
  run: parent === null ? "offload-test" : "gate-job",
  className,
  enqueuedAtMs: at,
  deadlineAt: at + 3_600_000,
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

/** The jobs a seed declares: plain jobs and sharded ones, 2 to 6 once expanded. */
const jobsOf = (random: () => number): readonly MatrixJob[] => {
  const jobs: MatrixJob[] = [];
  let total = 0;
  const target = 2 + Math.floor(random() * 5);
  for (let i = 0; total < target; i++) {
    const shards = random() < 0.3 ? Math.min(target - total, 2 + Math.floor(random() * 3)) : 1;
    jobs.push({
      key: `j${i + 1}`,
      command: JOB_COMMAND,
      ...(shards > 1 ? { shards } : {}),
    });
    total += shards;
  }
  return jobs;
};

export const simulateIsolation = async (seed: number): Promise<IsolationOutcome> => {
  const random = seededRandom(seed);
  const pick = <A>(xs: readonly A[]): A => xs[Math.floor(random() * xs.length)]!;
  const violations: SimViolation[] = [];
  const reached: Record<string, number> = {};
  const trace: string[] = [];
  const reach = (k: string, n = 1) => (reached[k] = (reached[k] ?? 0) + n);
  const v = (message: string) => violations.push({ id: "FD-GATE-030", message });
  const { repo, sha } = repository();
  const db = await migratedD1();
  const stores = d1PlacementStore(db);
  const runtime = ManagedRuntime.make(stores);
  const rows = (sql: string, ...params: unknown[]) =>
    db.sqlite.prepare(sql).all(...(params as never[])) as Record<string, unknown>[];

  const className = pick(CLASSES);
  /** A per-second rate for the class's hold, so each child's hold is its own amount. */
  const rate = 10 + Math.floor(random() * 100);

  /** Claims `id` for `executorId` with the hold its window at `rate` comes to, in one claim transaction. */
  const claim = (id: string, executorId: string, admittedAt: number) =>
    PlacementStore.use((p) =>
      Effect.gen(function* () {
        const placed = yield* p.get(id);
        const hold = holdMicroUsd({
          rateMicroUsdPerS: rate,
          admittedAtMs: admittedAt,
          deadlineAtMs: admittedAt + 3_600_000,
          settleMarginS: SETTLE_MARGIN_S,
          modelAllowanceMicroUsd: 0,
          networkEstimateMicroUsd: 0,
        });
        const leased = yield* p.claim(id, {
          expectedEpoch: placed!.epoch,
          executorId,
          floor: 0,
          hold: {
            className,
            holdMicroUsd: hold,
            lineMicroUsd: 1e12,
            month: MONTH,
            now: admittedAt,
          },
        });
        return { epoch: leased?.epoch ?? null, hold };
      }),
    );

  const expanded = expandMatrix(jobsOf(random), "pull_request");
  if ("failure" in expanded)
    throw new Error(`the seed's matrix expands to ${JSON.stringify(expanded.failure)}`);
  const keys = expanded.jobs.map((j) => j.key);
  const window = 1 + Math.floor(random() * 6);
  // Every draw happens before any job runs: the jobs' processes end in whatever order the host gives.
  const executorOf = new Map(keys.map((k) => [k, pick(EXECUTORS)]));
  trace.push(
    `${className} window ${window}: ${keys.map((k) => `${k}@${executorOf.get(k)}`).join(" ")}`,
  );

  /** Each started job: its child execution, the executor that claimed it, its epoch, hold and workspace. */
  const children = new Map<
    string,
    {
      readonly id: string;
      readonly executor: string;
      readonly epoch: number | null;
      readonly hold: number;
      readonly input: GateJobInput;
      workspace?: string;
    }
  >();
  const live = new Set<string>();
  let admittedAt = T0;

  try {
    const outcome = await runtime.runPromise(
      Effect.gen(function* () {
        yield* admitExecution(db, request(PARENT, T0, className, null));
        const parent = yield* claim(PARENT, "dev-parent", T0);

        // The parent's intake record, which each child's admission reads its trigger, repository and labels from.
        yield* IntakeStore.use((store) =>
          store.put({
            executionId: PARENT,
            trigger: "dispatch",
            run: "offload-test",
            label: null,
            repo: SCOPE,
            sha,
            ref: "refs/heads/main",
            inputs: {},
            className,
            labels: [],
            attempt: 1,
            familyRoot: PARENT,
            installation: null,
            caller: null,
            notBefore: null,
            spendLine: null,
            placementConstraint: null,
            cacheTrigger: { _tag: "Other" },
            eligibleKinds: null,
            repositoryPublic: null,
            inputAssociations: [],
            createdAt: T0,
          }),
        ).pipe(Effect.provide(d1IntakeStore(db)), Effect.orDie);

        /** The executor that claims `id` runs its job and records the child's end, as its lease's accept does. */
        const execute = (key: string, id: string, input: GateJobInput) =>
          Effect.gen(function* () {
            const at = ++admittedAt;
            const executor = executorOf.get(key)!;
            const { epoch, hold } = yield* claim(id, executor, at).pipe(Effect.provide(stores));
            const child = { id, executor, epoch, hold, input } as {
              readonly id: string;
              readonly executor: string;
              readonly epoch: number | null;
              readonly hold: number;
              readonly input: GateJobInput;
              workspace?: string;
            };
            children.set(key, child);
            // The host's `GateExec`, recording the workspace the recipe takes.
            const exec = Layer.effect(
              GateExec,
              Effect.gen(function* () {
                const host = yield* GateExec;
                return {
                  ...host,
                  workspace: Effect.tap(host.workspace, (dir) =>
                    Effect.sync(() => {
                      child.workspace = dir;
                      live.add(dir);
                      reached["most-live"] = Math.max(reached["most-live"] ?? 0, live.size);
                    }),
                  ),
                };
              }),
            ).pipe(Layer.provide(processGateExec));
            const outcome = yield* runGateJob(input).pipe(
              Effect.provide(Layer.merge(exec, fakeArtifacts().layer)),
            );
            if (child.workspace !== undefined) live.delete(child.workspace);
            yield* Effect.sync(() =>
              db.sqlite
                .prepare(
                  "update mameko_executions set status = ?, reason = ?, finished_at = ? where id = ?",
                )
                .run(
                  outcome._tag,
                  outcome._tag === "failure" ? outcome.reason : null,
                  Date.now(),
                  id,
                ),
            );
          });

        // The live `MatrixChildren` of the parent; each child it admits goes to its executor at once.
        const layer = Layer.effect(
          MatrixChildren,
          Effect.gen(function* () {
            const admitted = yield* MatrixChildren;
            return {
              ...admitted,
              start: (r) =>
                Effect.tap(admitted.start(r), (handle) =>
                  Effect.forkDetach(
                    execute(r.key, handle.executionId, r.input as GateJobInput).pipe(
                      // An executor that fails ends its child, so the parent's wait ends.
                      Effect.catchCause((cause) =>
                        Effect.sync(() => {
                          v(`job ${r.key}'s executor failed: ${String(cause)}`);
                          db.sqlite
                            .prepare(
                              "update mameko_executions set status = 'failure', reason = 'infra: executor' where id = ?",
                            )
                            .run(handle.executionId);
                        }),
                      ),
                    ),
                  ),
                ),
            };
          }),
        ).pipe(
          Layer.provide(matrixChildrenLayer(db, { pollMs: 2 })),
          Layer.provide(
            Layer.mergeAll(
              intake(db),
              Layer.succeed(ExecutionLease, {
                executionId: PARENT,
                epoch: 1,
                run: "offload-test",
                input: {},
              }),
            ),
          ),
        );

        const ran = yield* runMatrix({
          run: "offload-test",
          parentDedupKey: `offload-test:${SCOPE}:${sha}`,
          ctx: { repo, sha, ref: "refs/heads/main", scope: SCOPE },
          jobs: expanded.jobs,
          window,
          failFast: false,
          checkPerJob: false,
        }).pipe(Effect.provide(layer));
        return { ...ran, parent };
      }),
    );

    // Each job ran as its own child execution of the parent.
    const admitted = rows(
      "select id, class from mameko_executions where parent_id = ? order by id",
      PARENT,
    ) as { id: string; class: string }[];
    const ids = keys.map((k) => children.get(k)?.id);
    if (ids.some((id) => id === undefined))
      v(`jobs ${keys.join(",")} started ${[...children.keys()].join(",")}`);
    if (new Set(ids).size !== keys.length)
      v(`${keys.length} jobs ran as ${new Set(ids).size} child executions`);
    if (admitted.length !== keys.length)
      v(`${keys.length} jobs admitted ${admitted.length} child executions under the parent`);

    // Each child holds its own placement and execution lease: one placement row, leased at its own epoch to the
    // executor that claimed it, beside the parent's, which stays leased to the parent's executor.
    for (const key of keys) {
      const child = children.get(key);
      if (child === undefined) continue;
      const placements = rows(
        "select state, epoch, leased_epoch, executor_id from mameko_placements where execution_id = ?",
        child.id,
      );
      const p = placements[0];
      if (
        placements.length !== 1 ||
        child.epoch === null ||
        p?.["leased_epoch"] !== child.epoch ||
        p?.["executor_id"] !== child.executor
      )
        v(
          `job ${key}'s placement is ${JSON.stringify(placements)}, claimed by ${child.executor} at ${child.epoch}`,
        );
    }
    const parentPlacement = rows(
      "select state, executor_id, leased_epoch from mameko_placements where execution_id = ?",
      PARENT,
    )[0];
    if (
      parentPlacement?.["executor_id"] !== "dev-parent" ||
      parentPlacement["leased_epoch"] !== outcome.parent.epoch
    )
      v(`the parent's placement became ${JSON.stringify(parentPlacement)}`);

    // Each child holds its own hold: one held reservation of its own amount, and the parent's stays its own.
    const reservations = new Map(
      rows("select execution_id, class, hold_micro_usd, state from mameko_reservations").map(
        (r) => [r["execution_id"] as string, r],
      ),
    );
    if (reservations.size !== keys.length + 1)
      v(`${reservations.size} reservations for ${keys.length} jobs and the parent`);
    for (const [key, child] of children) {
      const r = reservations.get(child.id);
      if (r?.["state"] !== "held" || r["hold_micro_usd"] !== child.hold || r["class"] !== className)
        v(
          `job ${key}'s reservation is ${JSON.stringify(r)}, its hold ${child.hold} of ${className}`,
        );
    }
    if (reservations.get(PARENT)?.["hold_micro_usd"] !== outcome.parent.hold)
      v(`the parent's reservation became ${JSON.stringify(reservations.get(PARENT))}`);

    // Each job ran in its own workspace: pairwise distinct, holding only the checkout, and gone once the job ended.
    const workspaces = keys.map((k) => children.get(k)?.workspace);
    if (workspaces.some((w) => w === undefined))
      v(`a job ran with no workspace: ${JSON.stringify(workspaces)}`);
    if (new Set(workspaces).size !== keys.length)
      v(`${keys.length} jobs ran in ${new Set(workspaces).size} workspaces`);
    for (const w of workspaces)
      if (w !== undefined && existsSync(w)) v(`workspace ${w} outlived its job`);
    for (const [key, state] of outcome.states)
      if (state._tag !== "Done" || !isSuccess(state.outcome))
        v(`job ${key} found another job's files in its workspace: ${JSON.stringify(state)}`);

    trace.push(...keys.map((k) => `${k} ${JSON.stringify(outcome.states.get(k))}`));
    reach("jobs", keys.length);
    if (new Set([...children.values()].map((c) => c.executor)).size < children.size)
      reach("shared-executor");
  } finally {
    await runtime.dispose();
  }
  return { violations, reached, trace };
};

export const scenarios: readonly SimScenario[] = [
  {
    name: SCENARIO,
    ids: ["FD-GATE-030"],
    run: async (seed) => throwOnViolations((await simulateIsolation(seed)).violations),
  },
];
