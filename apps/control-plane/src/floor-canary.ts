// The floor canary on the Container pools (specs/operability.md FD-OPS-050, MAMEKO-OPS-012 to MAMEKO-OPS-018): mameko's
// `floor-canary` run, admitted through intake's admission as an ops run of the canary's class, cloud-pinned, pinned to its
// pool, sealed, with no check run. The minute tick's `floor-canary` unit admits each canary pool's canary once per 2 h slot and judges the
// slot before it; `POST /v1/ops/floor-canary` admits one at once for `fd deploy`, and `GET /v1/ops/floor-canary/:id`
// answers its verdict.
import { FLOOR_CANARY_CLASS, floorCanary } from "@fractalboxdev/flare-dispatch-catalog";
import {
  Admission,
  IntakeConfig,
  IntakeStore,
  type IntakeAdmitInput,
  type IntakeRecord,
} from "@fractalboxdev/flare-dispatch-intake";
import {
  FloorCanary,
  FloorCanaryPoolUnknown,
  FloorCanaryUnavailable,
} from "@fractalboxdev/flare-dispatch-ops";
import { placementInputs, type Profile } from "@fractalboxdev/flare-dispatch-profile";
import {
  dedupKey,
  executionId as newExecutionId,
  floorCanaryPass,
  floorCanaryVerdict,
  type FloorCanaryPool,
} from "@fractalboxdev/mameko-coordinator";
import { d1ExecutionStore } from "@fractalboxdev/mameko-host-cloudflare/d1";
import { CONTROL_POOL } from "@fractalboxdev/mameko-kernel";
import { ExecutionStore, type AlarmPort } from "@fractalboxdev/mameko-ports";
import { Context, Effect, Layer, Match } from "effect";
import type { ControlPlaneEnv } from "./config.ts";
import { launchKeysOf, poolsServing } from "./pools.ts";

/** The tenant scope every floor canary is admitted under: an ops run of the plane, of no repository. */
export const FLOOR_CANARY_SCOPE = "ops:floor-canary";

const PINNED_DIGEST = /^sha256:[0-9a-f]{64}$/;

/**
 * The pools the floor canary runs on: each Container pool whose partition serves the canary's class, with the gate
 * image's digest every Container pool runs; never the `control` pool, which starts no Container. None on a deploy without a launch signing key, whose pools start no
 * Container, or without a pinned gate image.
 */
export const floorCanaryPools = (
  env: Pick<ControlPlaneEnv, "LAUNCH_SIGNING_KEY" | "GATE_IMAGE_DIGEST">,
  profile: Profile,
): readonly FloorCanaryPool[] => {
  const digest = env.GATE_IMAGE_DIGEST ?? "";
  if (launchKeysOf(env) === null || !PINNED_DIGEST.test(digest)) return [];
  return poolsServing(profile, FLOOR_CANARY_CLASS)
    .filter((pool) => pool !== CONTROL_POOL)
    .map((pool) => ({ pool, imageDigest: digest }));
};

/** What one canary admission answers: queued now, or already admitted under the same id. */
export type CanaryAdmission =
  | { readonly _tag: "Queued"; readonly executionId: string }
  | { readonly _tag: "Duplicate"; readonly executionId: string }
  | { readonly _tag: "Concluded"; readonly executionId: string; readonly reason: string };

/**
 * Admits the floor canary of `pool` as an ops run (MAMEKO-SPD-065) under `executionId`, or a fresh id when absent. Its
 * intake record goes in first, as every admission's does, so the claiming pool finds its lease fields; the canary's
 * dedup key names the pool and the id, so a second admission of a slot's id answers `Duplicate`.
 */
export const admitFloorCanary = (
  pool: string,
  options: {
    readonly executionId?: string;
    readonly trigger: "cron" | "dispatch";
    readonly now: number;
  },
) =>
  Effect.gen(function* () {
    const { profile } = yield* IntakeConfig;
    const store = yield* IntakeStore;
    const admission = yield* Admission;
    const { now } = options;
    const id = options.executionId ?? newExecutionId(now, Math.random);
    const known = yield* store.get(id);
    if (known !== null && known.status !== null)
      return { _tag: "Duplicate", executionId: id } satisfies CanaryAdmission;
    const run = floorCanary.spec.name;
    const canonical = `${run}:${pool}:${id}`;
    const key = yield* Effect.promise(() => dedupKey([{ name: run, run: () => canonical }], null));
    // Cloud-pinned and cloud-only: the canary tests a Container pool's image, so no device takes it.
    const { facts, params } = placementInputs(profile, {
      class: FLOOR_CANARY_CLASS,
      labels: ["cloud-only"],
      constraints: ["cloud-pinned"],
    });
    const record: IntakeRecord = {
      executionId: id,
      trigger: options.trigger,
      run,
      label: null,
      repo: FLOOR_CANARY_SCOPE,
      sha: "",
      ref: "",
      inputs: { pool },
      className: FLOOR_CANARY_CLASS,
      labels: ["cloud-only"],
      attempt: 1,
      familyRoot: id,
      installation: null,
      caller: null,
      notBefore: null,
      spendLine: null,
      placementConstraint: null,
      cacheTrigger: { _tag: "Other" },
      eligibleKinds: null,
      repositoryPublic: null,
      inputAssociations: [],
      createdAt: now,
    };
    const admit: IntakeAdmitInput = {
      executionId: id,
      scopeId: FLOOR_CANARY_SCOPE,
      run,
      className: FLOOR_CANARY_CLASS,
      labels: ["cloud-only"],
      enqueuedAtMs: now,
      dedup: {
        sha256: key.sha256,
        canonical,
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
      maxDurationSec: floorCanary.spec.limits.maxDurationSec,
      grants: { setup: [], agent: [] },
      source: null,
      requiresWorkspace: false,
      check: null,
      opsRun: true,
      // The canary tests its own pool's image, so only that pool claims it (MAMEKO-LEASE-101).
      pool,
    };
    if (known === null) yield* store.put(record);
    const answer = yield* admission.admit(admit).pipe(
      Effect.catchTag("ExecutionStartFailed", (e) =>
        // The execution is admitted; the admission sweep starts its workflow.
        Effect.as(
          Effect.logWarning("floor canary workflow start failed; the admission sweep starts it", {
            executionId: e.executionId,
            cause: e.cause,
          }),
          { _tag: "Queued", executionId: e.executionId } as const,
        ),
      ),
      Effect.tapError(() => (known === null ? store.drop(id) : Effect.void)),
    );
    return yield* Match.value(answer).pipe(
      Match.tag("Queued", ({ executionId }) =>
        Effect.gen(function* () {
          yield* store.placed(executionId);
          yield* admission.queued(FLOOR_CANARY_CLASS);
          return { _tag: "Queued", executionId } satisfies CanaryAdmission;
        }),
      ),
      Match.tag("Concluded", (c) =>
        Effect.as(store.placed(c.executionId), {
          _tag: "Concluded",
          executionId: c.executionId,
          reason: c.reason ?? c.outcome,
        } satisfies CanaryAdmission),
      ),
      Match.tag("Duplicate", "Conflict", ({ executionId }) =>
        Effect.succeed({ _tag: "Duplicate", executionId } satisfies CanaryAdmission),
      ),
      Match.exhaustive,
    );
  });

/** The services a canary admission reads: intake's admission and store, and its configuration. */
type CanaryServices = Admission | IntakeConfig | IntakeStore;

/**
 * The minute tick's `floor-canary` unit (MAMEKO-OPS-012, MAMEKO-OPS-016): mameko's pass over the canary pools, each
 * slot's canary admitted through `admitFloorCanary`, and a failed stage of the slot before paged as
 * `floor-canary-failed` with the pool's image digest.
 */
export const floorCanaryUnit = (
  env: Pick<ControlPlaneEnv, "DB">,
  pools: readonly FloorCanaryPool[],
  now: number,
) =>
  floorCanaryPass(now, pools, (pool, executionId) =>
    Effect.map(
      admitFloorCanary(pool, { executionId, trigger: "cron", now }),
      (a) => a._tag === "Queued",
    ),
  ).pipe(Effect.provide(d1ExecutionStore(env.DB)));

/** The verdict body of a canary execution's record (MAMEKO-OPS-018). */
const verdictOf = (executionId: string, verdict: ReturnType<typeof floorCanaryVerdict>) =>
  Match.value(verdict).pipe(
    Match.tag("Running", () => ({ verdict: "running" as const, stage: null, detail: null })),
    Match.tag("Passed", () => ({ verdict: "passed" as const, stage: null, detail: null })),
    Match.tag("Failed", ({ stage, detail }) => ({ verdict: "failed" as const, stage, detail })),
    Match.tag("Inconclusive", ({ detail }) => ({
      verdict: "inconclusive" as const,
      stage: null,
      detail,
    })),
    Match.exhaustive,
    (body) => ({ execution_id: executionId, ...body }),
  );

/**
 * The floor canary port the operability routes read: `start` admits one canary on a canary pool for `fd deploy`, and
 * `verdict` judges a canary from its execution record. A deploy with no canary pool refuses every pool.
 */
export const floorCanaryLayer = (
  env: Pick<ControlPlaneEnv, "DB" | "LAUNCH_SIGNING_KEY" | "GATE_IMAGE_DIGEST">,
  services: Context.Context<CanaryServices | AlarmPort>,
  profile: Profile,
) =>
  Layer.succeed(FloorCanary, {
    start: (requested) =>
      Effect.gen(function* () {
        const pools = floorCanaryPools(env, profile);
        const pool = requested ?? pools[0]?.pool;
        const target = pools.find((p) => p.pool === pool);
        if (target === undefined)
          return yield* new FloorCanaryPoolUnknown({
            pool: pool ?? "",
            pools: pools.map((p) => p.pool),
          });
        const answer = yield* admitFloorCanary(target.pool, {
          trigger: "dispatch",
          now: Date.now(),
        }).pipe(
          Effect.provideContext(services),
          Effect.mapError((e) => new FloorCanaryUnavailable({ reason: String(e._tag ?? e) })),
        );
        return {
          execution_id: answer.executionId,
          pool: target.pool,
          image_digest: target.imageDigest,
        };
      }),
    verdict: (executionId) =>
      Effect.flatMap(ExecutionStore, (store) => store.record(executionId)).pipe(
        Effect.map((record) => verdictOf(executionId, floorCanaryVerdict(record, Date.now()))),
        Effect.provide(d1ExecutionStore(env.DB)),
        Effect.catchCause((cause) =>
          Effect.fail(new FloorCanaryUnavailable({ reason: String(cause) })),
        ),
      ),
  });
