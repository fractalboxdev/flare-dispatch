// The `pr.propose` row of an accepted result as a `V-REPLAY` workflow (specs/runs/agentic.md FD-AGT-034). Three
// executions of `spec-drift-pr` are leased at epoch 1 to one cloud executor: a `success` whose staged-write manifest
// is in the artifact store at that epoch, a `success` that staged nothing, and a `failure` whose manifest is stored.
// For each, the executor channel's accept compare-and-set handles the `exec.result` (mameko's channel over D1's
// placement store) with the rows generated `on: accepted` as the channel builds them, from the control plane's
// `acceptedPayload` over the staged write read before the accept, so the row is inserted in the accept's transaction;
// then the `Execution` workflow's `apply-outbox` stage writes the outcome. A second run sends every frame again and
// repeats both steps over the same D1, as a redelivered result and an engine that lost its journal entries run them.
import { STAGED_WRITE_MANIFEST, type Manifest } from "@fractalboxdev/flare-dispatch-agentic";
import { artifactPath } from "@fractalboxdev/flare-dispatch-cache";
import { migratedD1 } from "@fractalboxdev/flare-dispatch-intake/testing";
import { buildProfile } from "@fractalboxdev/flare-dispatch-profile";
import {
  acceptedIntentRows,
  ExecutionSteps,
  handleExecutorMessageWith,
  type ChannelReply,
  type ExecutionOutcome,
  type ExecutorMessage,
} from "@fractalboxdev/mameko-coordinator";
import { d1PlacementStore } from "@fractalboxdev/mameko-host-cloudflare/d1";
import { d1ExecutionSteps } from "@fractalboxdev/mameko-host-cloudflare/d1-execution";
import { Effect } from "effect";
import type {
  ReplayEffect,
  ReplayWorkflow,
} from "../../../../packages/ops/src/verification/harness.ts";
import { channelConfig, executionConfig } from "../../src/config.ts";
import { AcceptedPayloads, type PrProposeStores } from "../../src/pr-propose.ts";

type TestD1 = Awaited<ReturnType<typeof migratedD1>>;

export const profile = buildProfile("production");
const EXECUTOR = "cf-1";
const EPOCH = 1;
const NOW = Date.UTC(2026, 10, 4, 12, 0, 0);

export const MANIFEST: Manifest = {
  branch: "flare-dispatch/spec-drift",
  baseBranch: "main",
  baseCommit: "c".repeat(40),
  message: "docs(specs): reconcile the specs with the code",
  pr: {
    title: "Reconcile the specs with the code",
    body: "Spec drift in a.md.",
    draft: true,
    labels: ["spec-drift"],
  },
  entries: [{ path: "specs/a.md", mode: "100644", digest: "d".repeat(64) }],
};

/** Each execution: the status its result reports and whether its manifest is in the artifact store. */
export const EXECUTIONS = [
  { id: "exec-staged", status: "success", staged: true },
  { id: "exec-nothing-staged", status: "success", staged: false },
  { id: "exec-failed", status: "failure", staged: true },
] as const;

const outcomeOf = (status: string): ExecutionOutcome =>
  status === "success"
    ? { _tag: "Success", epoch: EPOCH }
    : { _tag: "Failure", reason: "exit: 1", epoch: EPOCH };

/** The `exec.result` frame the executor sends for an execution, as the channel's socket receives it. */
const frameOf = (executionId: string, status: string) =>
  JSON.stringify({
    type: "exec.result",
    id: `r-${executionId}`,
    execution_id: executionId,
    epoch: EPOCH,
    result_id: `result-${executionId}`,
    outcome: status === "success" ? { status } : { status, reason: "exit: 1" },
    usage: {},
    artifacts: [],
  });

/** An artifact bucket in memory, keyed as `artifact/<execution_id>/<epoch>/<name>`. */
const memoryBucket = () => {
  const objects = new Map<string, Uint8Array>();
  return {
    objects,
    get: async (key: string) => {
      const bytes = objects.get(key);
      return bytes === undefined
        ? null
        : { size: bytes.byteLength, arrayBuffer: async () => bytes.slice().buffer };
    },
  };
};

/** The store, the bucket and every ack the channel answered, which the second run reads and extends. */
export interface Journal {
  readonly db: TestD1;
  readonly stores: PrProposeStores;
  readonly acks: ChannelReply["status"][];
  readonly recorded: string[];
  /** The executions whose `pr.propose` row exists once the accept returns, before `apply-outbox` runs. */
  readonly proposedAtAccept: string[];
}

/** Every outbox, execution and placement row, keyed by table and id, with its full content. */
const snapshot = (db: TestD1): ReadonlyMap<string, string> =>
  new Map(
    [
      ["outbox", "select * from mameko_outbox"],
      ["executions", "select * from mameko_executions"],
      ["placements", "select * from mameko_placements"],
    ].flatMap(([table, sql]) =>
      (db.sqlite.prepare(sql!).all() as Record<string, unknown>[]).map(
        (r) => [`${table} ${r["id"] ?? r["execution_id"]}`, JSON.stringify(r)] as const,
      ),
    ),
  );

/** The executions, leased at epoch 1 to the cloud executor, and the staged manifests uploaded at that epoch. */
const leased = async (): Promise<Journal> => {
  const db = await migratedD1();
  const bucket = memoryBucket();
  for (const e of EXECUTIONS) {
    db.sqlite
      .prepare(
        `insert into mameko_executions (id, scope_id, run, class, status, enqueued_at) values (?, 'acme/app', 'spec-drift-pr', 'batch', 'running', ?)`,
      )
      .run(e.id, NOW);
    db.sqlite
      .prepare(
        `insert into mameko_placements (execution_id, state, epoch, executor_id) values (?, 'leased', ?, ?)`,
      )
      .run(e.id, EPOCH, EXECUTOR);
    if (e.staged)
      bucket.objects.set(
        artifactPath(e.id, EPOCH, STAGED_WRITE_MANIFEST),
        new TextEncoder().encode(JSON.stringify(MANIFEST)),
      );
  }
  return { db, stores: { db, artifacts: bucket }, acks: [], recorded: [], proposedAtAccept: [] };
};

/** Sends every execution's result through the channel and the control plane's step, then runs apply-outbox. */
export const accept = async (journal: Journal | null) => {
  const j = journal ?? (await leased());
  const before = snapshot(j.db);
  const config = channelConfig(profile);
  const payloads = new AcceptedPayloads(() => j.stores.artifacts);
  for (const e of EXECUTIONS) {
    const message = JSON.parse(frameOf(e.id, e.status)) as ExecutorMessage;
    const reply = await payloads.around(message, () =>
      Effect.runPromise(
        handleExecutorMessageWith(message, {
          executorId: EXECUTOR,
          floor: 0,
          notApplicableDetails: [],
          // The rows generated `on: accepted`, inserted only when this accept commits (MAMEKO-OUT-060).
          acceptedRows: (id, outcome) =>
            Effect.promise(() =>
              acceptedIntentRows({
                intents: {
                  kinds: config.acceptedKinds ?? {},
                  payload: (kind, execution) => payloads.payload(kind, execution),
                },
                executionId: id,
                scopeId: "acme/app",
                run: "spec-drift-pr",
                className: "batch",
                classRank: config.classRanks?.["batch"] ?? 0,
                outcome,
                now: NOW + 1_000,
              }),
            ),
          record: (id, epoch) => Effect.sync(() => void j.recorded.push(`${id}@${epoch}`)),
        }).pipe(Effect.provide(d1PlacementStore(j.db))),
      ),
    );
    if (reply !== null) j.acks.push(reply.status);
    if (
      j.db.sqlite
        .prepare("select 1 from mameko_outbox where kind = 'pr.propose' and execution_id = ?")
        .all(e.id).length > 0
    )
      j.proposedAtAccept.push(e.id);
    await Effect.runPromise(
      ExecutionSteps.use((steps) => steps.applyOutbox(e.id, outcomeOf(e.status), EPOCH)).pipe(
        Effect.provide(
          d1ExecutionSteps(j.db, {
            ...executionConfig(profile),
            meteredCost: () => Effect.succeed(0),
          }),
        ),
      ),
    );
  }
  const after = snapshot(j.db);
  const effects: ReplayEffect[] = [
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
  { name: "pr-propose", ids: ["FD-AGT-034"], run: accept },
];
