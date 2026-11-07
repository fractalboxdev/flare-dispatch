// FlareDispatch's Durable Object classes: mameko's, with the configuration each reads derived from the profile.
import { ExecutionInputsMissing } from "@fractalboxdev/flare-dispatch-api";
import { lookupRun } from "@fractalboxdev/flare-dispatch-catalog";
import { IntakeStore, d1IntakeStore } from "@fractalboxdev/flare-dispatch-intake";
import {
  ExecutionEngine as MamekoExecutionEngine,
  ExecutorChannel as MamekoExecutorChannel,
  type ClaimedLease,
} from "@fractalboxdev/mameko-host-cloudflare";
import { Effect, Match } from "effect";
import { leaseCache } from "./cache.ts";
import { imageDigestOf } from "./lease.ts";
import {
  channelConfig,
  deployment,
  executionConfig,
  profileOf,
  type ControlPlaneEnv,
} from "./config.ts";

type ChannelEnv = ControlPlaneEnv & {
  readonly MAMEKO_CHANNEL_CONFIG: ReturnType<typeof channelConfig>;
};
type EngineEnv = ControlPlaneEnv & {
  readonly MAMEKO_EXECUTION_CONFIG: ReturnType<typeof executionConfig>;
};

const hex = (bytes: ArrayBuffer) =>
  Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");

const sha256 = async (text: string) =>
  hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));

/** A lease's progress timeout, from `defineRun`'s default. */
const PROGRESS_TIMEOUT_MS = 300_000;

export class ExecutorChannel extends MamekoExecutorChannel<ChannelEnv> {
  constructor(ctx: DurableObjectState, env: ControlPlaneEnv) {
    super(ctx, { ...env, MAMEKO_CHANNEL_CONFIG: channelConfig(profileOf(env)) });
  }

  /** The inputs and deadline intake recorded for a won claim. */
  protected override leaseFields(executionId: string): Promise<ClaimedLease> {
    const env = this.env;
    return Effect.runPromise(
      Effect.gen(function* () {
        const record = yield* (yield* IntakeStore).get(executionId);
        if (record === null) return yield* new ExecutionInputsMissing({ executionId });
        const { inputs, deadlineAtMs } = record;
        const { results } = yield* Effect.promise(() =>
          env.DB.prepare(
            `select e.run, e.scope_id, x.kind from executions e
             left join placements p on p.execution_id = e.id
             left join executors x on x.executor_id = p.executor_id where e.id = ?`,
          )
            .bind(executionId)
            .all(),
        );
        const row = results[0] as { run: string; scope_id: string; kind: string | null };
        const entry = Match.value(lookupRun(deployment(env), row.run)).pipe(
          Match.tag("Available", ({ entry }) => entry),
          Match.orElse(() => null),
        );
        const run = entry?.spec ?? null;
        return {
          run: row.run,
          run_digest: yield* Effect.promise(() => sha256(`${row.run}@${run?.version ?? ""}`)),
          run_version: run?.version ?? "",
          workflow_version: 1,
          request_context: null,
          image_digest: yield* imageDigestOf(entry, row.kind ?? "device", env.GATE_IMAGE_DIGEST),
          scope_id: row.scope_id,
          inputs,
          deadline_at: deadlineAtMs,
          server_now: Date.now(),
          progress_timeout_ms: PROGRESS_TIMEOUT_MS,
          credentials: {},
          ...(yield* Effect.promise(() => leaseCache(env, record))),
          nonce: crypto.randomUUID(),
        } satisfies ClaimedLease;
      }).pipe(Effect.provide(d1IntakeStore(env.DB))),
    );
  }
}

export class ExecutionEngine extends MamekoExecutionEngine<EngineEnv> {
  constructor(ctx: DurableObjectState, env: ControlPlaneEnv) {
    super(ctx, { ...env, MAMEKO_EXECUTION_CONFIG: executionConfig(profileOf(env)) });
  }
}

export { EpochAnchor } from "@fractalboxdev/mameko-host-cloudflare";
/** One per repository: the cache's byte ledger (FD-CACHE-061). */
export { CacheLedger } from "@fractalboxdev/flare-dispatch-cache/ledger-object";
/** mameko's monitor whose timed wake also raises `cron-silent` (MAMEKO-OPS-010). */
export { FlareDispatchLivenessMonitor as LivenessMonitor } from "@fractalboxdev/flare-dispatch-ops/worker";
