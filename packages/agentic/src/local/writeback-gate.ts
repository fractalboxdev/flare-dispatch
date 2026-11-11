// FlareDispatch's writeback gate: what a registered local execution may write to GitHub (specs/local-scheduler.md
// § Writeback from local work, MAMEKO-PROTO-083).
import { WritebackGate } from "@fractalboxdev/mameko-ports";
import { Clock, Context, Effect, Exit, Layer, Schema } from "effect";
import {
  BRANCH_PREFIX,
  Manifest,
  refusalReason,
  type WritebackSpec,
} from "../staged-write/manifest.ts";
import { gateStagedWrite, StagedWriteReadFailed, WritebackRecords } from "../writeback/applier.ts";
import { GitData } from "../writeback/git-data.ts";
import type { WritebackIntent, WritebackRequest } from "./run-context.ts";
import { LocalStore } from "./store.ts";

/** The default `local_writeback_rate`: requests per capacity lease per hour (FD-LOCAL-089). */
export const DEFAULT_LOCAL_WRITEBACK_RATE = 10;
const HOUR_MS = 3_600_000;

/** The label that marks a draft pull request a device's registered execution proposes (FD-LOCAL-087). */
export const DEVICE_SIGNED_LABEL = "device-signed";

export class CapacityUsage extends Context.Service<
  CapacityUsage,
  {
    /** Whether the capacity lease's usage report records any model call for the execution (FD-LOCAL-094). */
    readonly modelCalls: (
      leaseId: string,
      executionId: string,
    ) => Effect.Effect<boolean, StagedWriteReadFailed>;
  }
>()("@fractalboxdev/flare-dispatch-agentic/CapacityUsage") {}

export type WritebackDecision =
  | { readonly _tag: "accepted" }
  | { readonly _tag: "rejected"; readonly reason: string }
  | { readonly _tag: "rate_limited"; readonly retryAfterMs: number };

const Intent = Schema.Struct({
  intent_key: Schema.String,
  kind: Schema.String,
  payload: Schema.Unknown,
});
const decodeIntents = Schema.decodeUnknownExit(Schema.Array(Intent));
const decodeManifest = Schema.decodeUnknownExit(Manifest);

export interface WritebackGateConfig {
  /** The run's `writeback` block from the catalogue, or undefined when it has none. */
  readonly writebackFor: (run: string) => WritebackSpec | undefined;
  readonly rate?: number;
  readonly githubHost?: string;
}

const reject = (reason: string): WritebackDecision => ({ _tag: "rejected", reason });

/**
 * Decides one `local.writeback`: a registered execution with a `success` verdict (FD-LOCAL-087), at most
 * `local_writeback_rate` requests per capacity lease per hour (FD-LOCAL-089), and only draft pull requests from a
 * `flare-dispatch/` bot branch labelled `device-signed` or pull-request reviews, never an issue or a protected branch
 * (FD-LOCAL-087, FD-LOCAL-088). A proposed file change passes `stagedWriteGate` with the run's `writeback` block,
 * model-authored when the lease's usage report records a model call for the execution (FD-LOCAL-094). A failed read
 * rejects the request.
 */
export const decideWriteback = (
  config: WritebackGateConfig,
  executionId: string,
  intents: unknown,
) =>
  Effect.gen(function* () {
    const store = yield* LocalStore;
    const record = yield* store.byExecution(executionId);
    if (record === null) return reject("not-registered");
    if (record.outcome !== "success") return reject("verdict-not-success");

    const now = yield* Clock.currentTimeMillis;
    const { count, oldest } = yield* store.countWriteback(record.leaseId, now, now - HOUR_MS);
    if (count > (config.rate ?? DEFAULT_LOCAL_WRITEBACK_RATE))
      return {
        _tag: "rate_limited",
        retryAfterMs: Math.max(1, oldest + HOUR_MS - now),
      } satisfies WritebackDecision;

    const decoded = decodeIntents(intents);
    if (Exit.isFailure(decoded) || decoded.value.length === 0) return reject("intents-invalid");
    const [owner, name] = record.repository.split("/") as [string, string];
    const repo = { scopeId: record.scopeId, owner, name };
    const git = yield* GitData;

    for (const intent of decoded.value) {
      if (intent.kind === "review") continue;
      if (intent.kind !== "pr.propose") return reject(`kind-not-allowed: ${intent.kind}`);
      const manifest = decodeManifest(
        (intent.payload as { manifest?: unknown } | null)?.manifest ?? intent.payload,
      );
      if (Exit.isFailure(manifest)) return reject("manifest-invalid");
      const m = manifest.value;
      if (!m.pr.draft || !m.pr.labels.includes(DEVICE_SIGNED_LABEL))
        return reject("not-a-device-signed-draft");
      if (!m.branch.startsWith(BRANCH_PREFIX) || (yield* git.branchProtected(repo, m.branch)))
        return reject("protected-branch");
      const writeback = config.writebackFor(record.run);
      if (writeback === undefined) return reject("no-writeback-block");
      const usage = yield* CapacityUsage;
      const modelAuthored = yield* usage.modelCalls(record.leaseId, executionId);
      const { verdict } = yield* gateStagedWrite({
        executionId,
        repo,
        manifest: m,
        writeback,
        modelAuthored,
        githubHost: config.githubHost ?? "github.com",
      });
      if (verdict._tag === "reject") return reject(refusalReason(verdict.reasons));
    }
    return { _tag: "accepted" } satisfies WritebackDecision;
  }).pipe(
    Effect.catchTags({
      LocalStoreFailed: (e) => Effect.succeed(reject(`read-failed: ${e.operation}`)),
      StagedWriteReadFailed: (e) => Effect.succeed(reject(`read-failed: ${e.source}`)),
      GitDataError: (e) => Effect.succeed(reject(`read-failed: github ${e.call}`)),
    }),
  );

/**
 * The `WritebackGate` port Layer. The port answers a boolean, so `rate_limited` reaches the device as a rejection;
 * `decideWriteback` carries the `retry_after` for a caller that answers `local.writeback.ack` itself.
 */
export const writebackGateLayer = (
  config: WritebackGateConfig,
): Layer.Layer<WritebackGate, never, LocalStore | GitData | WritebackRecords | CapacityUsage> =>
  Layer.effect(
    WritebackGate,
    Effect.gen(function* () {
      const context = yield* Effect.context<
        LocalStore | GitData | WritebackRecords | CapacityUsage
      >();
      return {
        decide: (executionId, intents) =>
          decideWriteback(config, executionId, intents).pipe(
            Effect.map((d) => d._tag === "accepted"),
            Effect.provide(context),
          ),
      };
    }),
  );

/** The `local.writeback.ack` for a decision (MAMEKO protocol `local.writeback.ack`). */
export const writebackAck = (decision: WritebackDecision) =>
  decision._tag === "rate_limited"
    ? {
        type: "local.writeback.ack" as const,
        status: "rate_limited" as const,
        retry_after_ms: decision.retryAfterMs,
      }
    : { type: "local.writeback.ack" as const, status: decision._tag };

/** What the control plane does with one `local.writeback`: the ack it answers and the intents it inserts. */
export interface WritebackReceipt {
  readonly ack:
    | ReturnType<typeof writebackAck>
    | { readonly type: "local.writeback.ack"; readonly status: "duplicate" };
  /** The intents to insert as outbox rows of the request's execution; empty unless the gate accepted them. */
  readonly insert: readonly WritebackIntent[];
}

/**
 * Receives one `local.writeback` (MAMEKO-PROTO-083). `held` is the set of intent keys the control plane already holds
 * as outbox rows of the request's execution. An intent whose (execution id, `run:<step>:<index>`) is held is absorbed
 * before the gate decides, so a rerun step's request answers `duplicate` with no read, no rate-window entry and no
 * insert (FD-LOCAL-055); the gate decides only the fresh intents, and an accepted request inserts exactly those.
 */
export const receiveWriteback = (
  config: WritebackGateConfig,
  request: WritebackRequest,
  held: ReadonlySet<string>,
) =>
  Effect.gen(function* () {
    const fresh = request.intents.filter((i) => !held.has(i.intent_key));
    if (request.intents.length > 0 && fresh.length === 0)
      return {
        ack: { type: "local.writeback.ack", status: "duplicate" },
        insert: [],
      } satisfies WritebackReceipt;
    const decision = yield* decideWriteback(config, request.execution_id, fresh);
    return {
      ack: writebackAck(decision),
      insert: decision._tag === "accepted" ? fresh : [],
    } satisfies WritebackReceipt;
  });
