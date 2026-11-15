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
  ControlPool as MamekoControlPool,
  ExecutionEngine as MamekoExecutionEngine,
  ExecutorChannel as MamekoExecutorChannel,
  type ChannelSocket as MamekoChannelSocket,
  type ClaimedLease,
  type PoolControllerEnv,
} from "@fractalboxdev/mameko-host-cloudflare";
import type { ExecutorMessage } from "@fractalboxdev/mameko-coordinator";
import { CONTROL_POOL, type ExecutorKind } from "@fractalboxdev/mameko-kernel";
import type { CatalogRun } from "@fractalboxdev/mameko-runner/program";
import { type ExecutionRecord, ObjectStorePresigner } from "@fractalboxdev/mameko-ports";
import { DurableObject } from "cloudflare:workers";
import { Context, Effect, Match } from "effect";
import { guardLease } from "./agentic.ts";
import { isolateServices, presignerLayer } from "./composition.ts";
import { controlPoolRuns } from "./control-pool.ts";
import { leaseCache, presignOnFrame } from "./cache.ts";
import { leaseCacheAt } from "./cache-execution.ts";
import { leaseCloudValues, withCloudLease } from "./cloud-lease.ts";
import { leaseReadCredentials } from "./control-plane-read.ts";
import { leaseDeployClaim, withDeployClaim } from "./deploy-claim.ts";
import { leaseModelCredentials } from "./model-gateway.ts";
import { AcceptedPayloads, type AcceptedExecution } from "./pr-propose.ts";
import { type ChannelSocket, cloudStatementOnFrame } from "./provenance.ts";
import { imageDigestOf, leaseNonce, requestLeaseFields, revokeLeaseCredentials } from "./lease.ts";
import { launchKeysOf, mintPoolCredential, poolSettings } from "./pools.ts";
import {
  channelConfig,
  deployment,
  executionConfig,
  presignerConfigOf,
  profileOf,
  type ControlPlaneEnv,
} from "./config.ts";

type ChannelEnv = ControlPlaneEnv & {
  readonly MAMEKO_CHANNEL_CONFIG: ReturnType<typeof channelConfig>;
};
type EngineEnv = ControlPlaneEnv & {
  readonly MAMEKO_EXECUTION_CONFIG: ReturnType<typeof executionConfig>;
};

/** A lease's progress timeout, from `defineRun`'s default. */
const PROGRESS_TIMEOUT_MS = 300_000;

/**
 * The FlareDispatch hooks of mameko's channel, which `ExecutorChannel` and `PoolController` share: the cloud-builder
 * statement after an accepted result, the presigner, the cache namespaces, the lease fields and the nonce revoke.
 */
/**
 * Signs each `exec.presign` URL with the object-store presigner over the presign token, on the bucket's S3 endpoint
 * (MAMEKO-HOST-053, FD-CACHE-091). A deploy without the presign token, the account id or the bucket name signs none.
 */
const presignWith =
  (bindings: ControlPlaneEnv) =>
  (
    key: string,
    method: "GET" | "PUT",
    length: number | null,
    expiresAt: number,
  ): Promise<{ readonly url: string; readonly expiresAt: number } | null> => {
    if (presignerConfigOf(bindings) === undefined) return Promise.resolve(null);
    return Effect.runPromise(
      ObjectStorePresigner.use((p) => p.presign(key, method, length, expiresAt)).pipe(
        Effect.provide(presignerLayer(bindings)),
      ),
    );
  };

const channelHooks = (bindings: ControlPlaneEnv) => ({
  /**
   * An `exec.presign` for cache objects under an entry's writer prefix or for log segments is answered by
   * FlareDispatch's presign policy (FD-CACHE-047), on the socket, before mameko's channel reads the frame; any other
   * frame answers `false` and goes to mameko's channel. A failure is reported on the socket, as mameko's channel
   * reports one, never dropped.
   */
  beforeFrame: async (ws: unknown, message: string | ArrayBuffer): Promise<boolean> => {
    const socket = ws as MamekoChannelSocket;
    const presigned = await presignOnFrame(
      bindings,
      (socket.deserializeAttachment() as { readonly executorId: string }).executorId,
      message,
      Date.now(),
    ).catch((error: unknown) => ({
      type: "session.error",
      code: "internal",
      ref: null,
      message: String(error),
    }));
    if (presigned === null) return false;
    socket.send(JSON.stringify(presigned));
    return true;
  },

  /**
   * An `exec.result` that the accept compare-and-set accepted from a cloud executor gets its cloud-builder statement,
   * signed with the provenance key and queued for the transparency log (FD-PROV-008, FD-PROV-009); the placement row,
   * not the frame, decides whether it was accepted.
   */
  afterFrame: async (ws: unknown, message: string | ArrayBuffer) => {
    await cloudStatementOnFrame(bindings, ws as ChannelSocket, message, Date.now());
  },

  /**
   * The payloads of the kinds generated `on: accepted`: a `success` result's `pr.propose` row from its staged write,
   * which mameko's accept inserts in its own transaction (FD-AGT-034, MAMEKO-OUT-060).
   */
  accepted: new AcceptedPayloads(() => bindings.CACHE),

  /** Signs each `exec.presign` URL; a deploy that signs none has mameko answer the request `refused`. */
  presign: presignWith(bindings),

  /**
   * The profile's `cache_namespaces` binding for a claim (MAMEKO-LEASE-088): the namespaces of the execution's
   * repository and run for the claiming executor's kind, computed from the execution and intake's record and never
   * from the run inputs (FD-CACHE-016), and none for a `confidential-compute` repository or a sealed-sandbox run
   * (FD-CACHE-008). mameko writes the answer onto the lease's `cache_namespaces` inside the claim.
   */
  cacheNamespaces: (
    execution: ExecutionRecord,
    executorKind: string,
  ): Promise<{ readonly read: readonly string[]; readonly write: string | null } | null> =>
    Effect.runPromise(
      Effect.gen(function* () {
        const record = yield* (yield* IntakeStore).get(execution.executionId);
        if (record === null) return null;
        const entry = Match.value(lookupRun(deployment(bindings), execution.run)).pipe(
          Match.tag("Available", ({ entry }) => entry),
          Match.orElse(() => null),
        );
        const fields = yield* Effect.promise(() =>
          leaseCacheAt(
            bindings,
            record,
            { epoch: 0, kind: executorKind as ExecutorKind },
            execution.deadlineAt ?? 0,
            entry?.sealedSandbox === true,
          ),
        );
        return fields.cache_namespaces;
      }).pipe(Effect.provide(d1IntakeStore(bindings.DB))),
    ),

  /**
   * The inputs and request context intake recorded for a won claim, the run registry's run and workflow versions
   * (FD-PROF-063), and the `deadline_at` admission wrote on the execution row (MAMEKO-EXEC-002), which a gate run's
   * input carries as its `deadlineAt` (FD-GATE-007). A `worker-deploy` input carries the deploy claim minted for the
   * execution at the placement's epoch (FD-GATE-067), and an agentic or scan input its executor values
   * (`cloud-lease.ts`). An agentic lease that calls models carries its model-lease token in `credentials`
   * (`model-gateway.ts`), and a `ci-triage-pr` lease its control-plane read token (`control-plane-read.ts`). A payload that carries a write credential fails the grant
   * (FD-AGT-008). The nonce is 128 random bits bound to the execution and the placement's epoch (FD-PROV-010).
   */
  leaseFields: (executionId: string): Promise<ClaimedLease> =>
    Effect.runPromise(
      Effect.gen(function* () {
        const record = yield* (yield* IntakeStore).get(executionId);
        if (record === null) return yield* new ExecutionInputsMissing({ executionId });
        const { results } = yield* Effect.promise(() =>
          bindings.DB.prepare(
            `select e.run, e.scope_id, e.deadline_at, p.epoch, x.kind from mameko_executions e
             left join mameko_placements p on p.execution_id = e.id
             left join mameko_executors x on x.executor_id = p.executor_id where e.id = ?`,
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
        const entry = Match.value(lookupRun(deployment(bindings), row.run)).pipe(
          Match.tag("Available", ({ entry }) => entry),
          Match.orElse(() => null),
        );
        const request = requestLeaseFields(entry, record, row);
        // A `worker-deploy` lease's input carries its deploy claim: the input is the one lease field the run body receives.
        const claim = yield* Effect.promise(() =>
          leaseDeployClaim(bindings, entry, {
            executionId,
            epoch: row.epoch,
            expiresAt: row.deadline_at,
          }),
        );
        // An agentic lease that calls models carries its model-lease token among its credentials, where the egress
        // proxy attaches it to the model route (FD-AGT-010), and a `ci-triage-pr` lease its control-plane read token,
        // which the proxy attaches to the executions and log routes (FD-IFC-102); the input carries neither.
        const scope = { executionId, epoch: row.epoch, expiresAt: row.deadline_at };
        const credentials = {
          ...(yield* Effect.promise(() => leaseModelCredentials(bindings, entry, scope))),
          ...(yield* Effect.promise(() => leaseReadCredentials(bindings, entry, scope))),
        };
        // An agentic or scan lease's input carries the executor values the Container's runner builds its Layers from.
        const presign = presignWith(bindings);
        const cloud = yield* Effect.promise(() =>
          leaseCloudValues(
            bindings,
            entry,
            { deadlineAt: row.deadline_at, now: Date.now() },
            (key, expiresAt) => presign(key, "GET", null, expiresAt),
          ),
        );
        return yield* guardLease(bindings, {
          run: row.run,
          ...request,
          inputs: withCloudLease(entry, withDeployClaim(entry, request.inputs, claim), cloud),
          image_digest: yield* imageDigestOf(
            entry,
            row.kind ?? "device",
            bindings.GATE_IMAGE_DIGEST,
          ),
          deadline_at: row.deadline_at,
          server_now: Date.now(),
          progress_timeout_ms: PROGRESS_TIMEOUT_MS,
          credentials,
          ...(yield* Effect.promise(() =>
            leaseCache(bindings, record, row.deadline_at, entry?.sealedSandbox === true),
          )),
          nonce: yield* leaseNonce(bindings.DB, executionId, row.epoch, Date.now()),
        } satisfies ClaimedLease);
      }).pipe(Effect.provide(d1IntakeStore(bindings.DB))),
    ),

  /**
   * A lease's end through the channel invalidates the epoch's nonce before it frees the placement (FD-PROV-011), and
   * revokes the lease's model-lease token (MAMEKO-ISO-053, MAMEKO-HOST-052).
   */
  revokeCredentials: (executionId: string, epoch: number): Promise<void> =>
    revokeLease(bindings, executionId, epoch),
});

/** Invalidates the lease's nonce and revokes its model-lease token, as the lease at `epoch` ends. */
const revokeLease = (
  bindings: Pick<ControlPlaneEnv, "DB">,
  executionId: string,
  epoch: number,
): Promise<void> =>
  Effect.runPromise(revokeLeaseCredentials(bindings.DB, executionId, epoch, Date.now()));

/** The channel of the device executors, with FlareDispatch's hooks. */
export class ExecutorChannel extends MamekoExecutorChannel<ChannelEnv> {
  private readonly hooks: ReturnType<typeof channelHooks>;

  constructor(ctx: DurableObjectState, env: ControlPlaneEnv) {
    super(ctx, {
      ...env,
      MAMEKO_CHANNEL_CONFIG: channelConfig(profileOf(env)),
    });
    this.hooks = channelHooks(env);
  }

  override async webSocketMessage(ws: unknown, message: string | ArrayBuffer): Promise<void> {
    if (await this.hooks.beforeFrame(ws, message)) return;
    await super.webSocketMessage(ws, message);
    await this.hooks.afterFrame(ws, message);
  }

  protected override presign(
    key: string,
    method: "GET" | "PUT",
    length: number | null,
    expiresAt: number,
  ): Promise<{ readonly url: string; readonly expiresAt: number } | null> {
    return this.hooks.presign(key, method, length, expiresAt);
  }

  protected override cacheNamespaces(
    execution: ExecutionRecord,
    executorKind: string,
  ): Promise<{ readonly read: readonly string[]; readonly write: string | null } | null> {
    return this.hooks.cacheNamespaces(execution, executorKind);
  }

  protected override leaseFields(executionId: string): Promise<ClaimedLease> {
    return this.hooks.leaseFields(executionId);
  }

  protected override revokeCredentials(executionId: string, epoch: number): Promise<void> {
    return this.hooks.revokeCredentials(executionId, epoch);
  }

  /** Reads a `success` result's staged write before mameko's accept, whose transaction inserts its `pr.propose` row. */
  protected override endLease(message: ExecutorMessage, executorId: string): Promise<unknown> {
    return this.hooks.accepted.around(message, () => super.endLease(message, executorId));
  }

  /** The `pr.propose` payload of an accepted result (MAMEKO-OUT-060); null for any other kind. */
  protected override acceptedPayload(kind: string, execution: AcceptedExecution): unknown {
    return this.hooks.accepted.payload(kind, execution);
  }
}

type PoolEnv = ChannelEnv & PoolControllerEnv;

/**
 * One per pool, addressed by the pool's name (MAMEKO-HOST-061): mameko's `ControlPool`, the pool controller whose
 * `control` pool runs each lease's run program in an object of this namespace with no Container (MAMEKO-EXEC-057),
 * with the same hooks as `ExecutorChannel` and the settings `poolSettings` derives from the profile. Without a launch
 * signing key it is given the `control` pool alone, so it starts no Container.
 */
export class PoolController extends MamekoControlPool<PoolEnv> {
  private readonly hooks: ReturnType<typeof channelHooks>;

  constructor(ctx: DurableObjectState, env: ControlPlaneEnv) {
    const profile = profileOf(env);
    const keys = launchKeysOf(env);
    const settings = poolSettings(env, profile);
    const control = settings.pools[CONTROL_POOL];
    super(ctx, {
      ...env,
      MAMEKO_CHANNEL_CONFIG: channelConfig(profile),
      MAMEKO_POOL_CONFIG:
        keys === null
          ? { ...settings, pools: control === undefined ? {} : { [CONTROL_POOL]: control } }
          : settings,
      MAMEKO_LAUNCH_SIGNING_KEY: keys?.signing ?? ({} as PoolEnv["MAMEKO_LAUNCH_SIGNING_KEY"]),
      ...(keys === null ? {} : { MAMEKO_LAUNCH_KEY: keys.verify }),
    } as PoolEnv);
    this.hooks = channelHooks(env);
  }

  /**
   * The `control` pool's run catalogue (`control-runs.ts`), with the services the control plane builds inside each
   * execution (`control-pool.ts`).
   */
  protected override runs(): readonly CatalogRun[] {
    return controlPoolRuns(this.env, () => isolateServices(this.env));
  }

  override async webSocketMessage(ws: unknown, message: string | ArrayBuffer): Promise<void> {
    if (await this.hooks.beforeFrame(ws, message)) return;
    await super.webSocketMessage(ws, message);
    await this.hooks.afterFrame(ws, message);
  }

  protected override presign(
    key: string,
    method: "GET" | "PUT",
    length: number | null,
    expiresAt: number,
  ): Promise<{ readonly url: string; readonly expiresAt: number } | null> {
    return this.hooks.presign(key, method, length, expiresAt);
  }

  protected override cacheNamespaces(
    execution: ExecutionRecord,
    executorKind: string,
  ): Promise<{ readonly read: readonly string[]; readonly write: string | null } | null> {
    return this.hooks.cacheNamespaces(execution, executorKind);
  }

  protected override leaseFields(executionId: string): Promise<ClaimedLease> {
    return this.hooks.leaseFields(executionId);
  }

  /** A minted grant's credential for one launch: the `model-gateway` grant's model-lease token (MAMEKO-HOST-050). */
  protected override mintCredential(
    grant: string,
    lease: {
      readonly executionId: string;
      readonly epoch: number;
      readonly scopeId: string;
      readonly deadlineAt: number;
    },
  ): Promise<{ readonly credential: string; readonly expiresAt: number }> {
    return mintPoolCredential(this.env)(grant, lease);
  }

  protected override revokeCredentials(executionId: string, epoch: number): Promise<void> {
    return this.hooks.revokeCredentials(executionId, epoch);
  }

  /** Reads a `success` result's staged write before mameko's accept, whose transaction inserts its `pr.propose` row. */
  protected override endLease(message: ExecutorMessage, executorId: string): Promise<unknown> {
    return this.hooks.accepted.around(message, () => super.endLease(message, executorId));
  }

  /** The `pr.propose` payload of an accepted result (MAMEKO-OUT-060); null for any other kind. */
  protected override acceptedPayload(kind: string, execution: AcceptedExecution): unknown {
    return this.hooks.accepted.payload(kind, execution);
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
 * invalidates the reclaimed epoch's nonce before it frees the placement (FD-PROV-011), and revokes the lease's
 * model-lease token (MAMEKO-ISO-053).
 */
export class LivenessMonitor extends FlareDispatchLivenessMonitor {
  protected override revokeCredentials(executionId: string, epoch: number): Promise<void> {
    return revokeLease(this.env, executionId, epoch);
  }
}
