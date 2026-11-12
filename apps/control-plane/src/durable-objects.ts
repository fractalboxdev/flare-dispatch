// FlareDispatch's Durable Object classes: mameko's, with the configuration each reads derived from the profile.
import { ExecutionInputsMissing } from "@fractalboxdev/flare-dispatch-api";
import { lookupRun } from "@fractalboxdev/flare-dispatch-catalog";
import {
  IntakeStore,
  d1IntakeStore,
  enqueueUnits,
  runQueuedUnit,
  type TickUnit,
} from "@fractalboxdev/flare-dispatch-intake";
import { parseProvenanceKey } from "@fractalboxdev/flare-dispatch-cache/provenance";
import {
  d1PolicyStore,
  PolicyStore,
  privateLogWitnesses,
} from "@fractalboxdev/flare-dispatch-cache/provenance-policy";
import {
  PRIVATE_LOG_PREFIX,
  TransparencyLog as PrivateLogObject,
  type TransparencyLogConfig,
} from "@fractalboxdev/flare-dispatch-cache/transparency-log";
import { alarmPortFromEnv } from "@fractalboxdev/flare-dispatch-ops";
import { FlareDispatchLivenessMonitor } from "@fractalboxdev/flare-dispatch-ops/worker";
import {
  ExecutionEngine as MamekoExecutionEngine,
  ExecutorChannel as MamekoExecutorChannel,
  type ClaimedLease,
} from "@fractalboxdev/mameko-host-cloudflare";
import { DurableObject } from "cloudflare:workers";
import { Context, Effect, Match } from "effect";
import { guardLease } from "./agentic.ts";
import { isolateServices } from "./composition.ts";
import { leaseCache } from "./cache.ts";
import { type ChannelSocket, cloudStatementOnFrame } from "./provenance.ts";
import { imageDigestOf, invalidateLeaseNonce, leaseNonce, requestLeaseFields } from "./lease.ts";
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
  /** The Worker's bindings as the isolate received them, which its services are built over once. */
  private readonly bindings: ControlPlaneEnv;

  constructor(ctx: DurableObjectState, env: ControlPlaneEnv) {
    super(ctx, {
      ...env,
      MAMEKO_CHANNEL_CONFIG: channelConfig(profileOf(env)),
    });
    this.bindings = env;
  }

  /**
   * Each frame goes through mameko's channel first. An `exec.result` that the accept compare-and-set accepted from a
   * cloud executor then gets its cloud-builder statement, signed with the provenance key and queued for the
   * transparency log (FD-PROV-008, FD-PROV-009); the placement row, not the frame, decides whether it was accepted.
   */
  override async webSocketMessage(ws: unknown, message: string | ArrayBuffer): Promise<void> {
    await super.webSocketMessage(ws, message);
    await cloudStatementOnFrame(this.bindings, ws as ChannelSocket, message, Date.now());
  }

  /**
   * The inputs and request context intake recorded for a won claim, the run registry's run and workflow versions
   * (FD-PROF-063), and the `deadline_at` admission wrote on the execution row (MAMEKO-EXEC-002), which a gate run's
   * input carries as its `deadlineAt` (FD-GATE-007). A payload that carries a write credential fails the grant
   * (FD-AGT-008). The nonce is 128 random bits bound to the execution and the placement's epoch (FD-PROV-010).
   */
  protected override leaseFields(executionId: string): Promise<ClaimedLease> {
    const env = this.env;
    return Effect.runPromise(
      Effect.gen(function* () {
        const record = yield* (yield* IntakeStore).get(executionId);
        if (record === null) return yield* new ExecutionInputsMissing({ executionId });
        const { results } = yield* Effect.promise(() =>
          env.DB.prepare(
            `select e.run, e.scope_id, e.deadline_at, p.epoch, x.kind from executions e
             left join placements p on p.execution_id = e.id
             left join executors x on x.executor_id = p.executor_id where e.id = ?`,
          )
            .bind(executionId)
            .all(),
        );
        const row = results[0] as {
          run: string;
          scope_id: string;
          deadline_at: number;
          epoch: number;
          kind: string | null;
        };
        const entry = Match.value(lookupRun(deployment(env), row.run)).pipe(
          Match.tag("Available", ({ entry }) => entry),
          Match.orElse(() => null),
        );
        const run = entry?.spec ?? null;
        return yield* guardLease(env, {
          run: row.run,
          run_digest: yield* Effect.promise(() => sha256(`${row.run}@${run?.version ?? ""}`)),
          ...requestLeaseFields(entry, record, row),
          image_digest: yield* imageDigestOf(entry, row.kind ?? "device", env.GATE_IMAGE_DIGEST),
          deadline_at: row.deadline_at,
          server_now: Date.now(),
          progress_timeout_ms: PROGRESS_TIMEOUT_MS,
          credentials: {},
          ...(yield* Effect.promise(() => leaseCache(env, record, row.deadline_at))),
          nonce: yield* leaseNonce(env.DB, executionId, row.epoch, Date.now()),
        } satisfies ClaimedLease);
      }).pipe(Effect.provide(d1IntakeStore(env.DB))),
    );
  }

  /** A reclaim through the channel invalidates the reclaimed epoch's nonce before it frees the placement (FD-PROV-011). */
  protected override revokeCredentials(executionId: string, epoch: number): Promise<void> {
    return Effect.runPromise(invalidateLeaseNonce(this.env.DB, executionId, epoch, Date.now()));
  }
}

export class ExecutionEngine extends MamekoExecutionEngine<EngineEnv> {
  constructor(ctx: DurableObjectState, env: ControlPlaneEnv) {
    super(ctx, {
      ...env,
      MAMEKO_EXECUTION_CONFIG: executionConfig(profileOf(env)),
    });
  }
}

/**
 * One per GitHub App installation: the queue of the installation's tick units (FD-INT-067). The tick enqueues; each
 * alarm runs one unit within its own subrequest and D1-query allowance and queues the unit that continues it.
 */
export class IntakeUnits extends DurableObject<ControlPlaneEnv> {
  enqueue(units: readonly TickUnit[]): Promise<number> {
    return Effect.runPromise(enqueueUnits(this.ctx.storage, units, Date.now()));
  }

  override async alarm(): Promise<void> {
    const services = await isolateServices(this.env);
    // Only a deploy with the GitHub App enqueues units, and its services carry the installation quota the sweep reads.
    const ran = await Effect.runPromise(
      runQueuedUnit(this.ctx.storage, Date.now()).pipe(
        Effect.provide(
          services as Context.Context<Effect.Services<ReturnType<typeof runQueuedUnit>>>,
        ),
      ),
    );
    if (ran !== null) console.log(JSON.stringify({ intakeUnit: ran }));
  }
}

export { EpochAnchor } from "@fractalboxdev/mameko-host-cloudflare";
/** One per repository: the cache's byte ledger (FD-CACHE-061). */
export { CacheLedger } from "@fractalboxdev/flare-dispatch-cache/ledger-object";

type LogEnv = ControlPlaneEnv & {
  /** The `CACHE` bucket, which holds the private log under `tlog/private/`. */
  readonly CACHE: R2Bucket;
  /** The log key (a Worker secret): a private ES256 JWK with its `kid`, which signs each checkpoint. */
  readonly LOG_KEY?: string;
};

/**
 * The one `TransparencyLog` object, `idFromName("private")`: the only writer of the private transparency log
 * (FD-PROV-074). Its checkpoints name the plane as their origin; a refused write pages through the alarm port. Each
 * checkpoint goes to the witnesses the current verification policy in `DB` names (FD-PROV-039).
 */
export class TransparencyLog extends PrivateLogObject<LogEnv> {
  protected config(): TransparencyLogConfig {
    return {
      bucket: this.env.CACHE,
      prefix: PRIVATE_LOG_PREFIX,
      origin: `${this.env.PLANE_ID}/private-log`,
      logKey: parseProvenanceKey(this.env.LOG_KEY),
      alarms: alarmPortFromEnv(this.env),
      witnesses: privateLogWitnesses.pipe(
        Effect.provideService(PolicyStore, d1PolicyStore(this.env.DB as unknown as D1Database)),
      ),
      fetch: (url, init) => fetch(url, init),
    };
  }
}

/**
 * mameko's monitor whose timed wake also raises `cron-silent` (MAMEKO-OPS-010). A sweep's reclaim of a silent lease
 * invalidates the reclaimed epoch's nonce before it frees the placement (FD-PROV-011).
 */
export class LivenessMonitor extends FlareDispatchLivenessMonitor {
  protected override revokeCredentials(executionId: string, epoch: number): Promise<void> {
    return Effect.runPromise(invalidateLeaseNonce(this.env.DB, executionId, epoch, Date.now()));
  }
}
