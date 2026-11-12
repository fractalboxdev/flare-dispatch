// The execution row the cache namespaces read, from intake's record, and the cache fields of a lease at an epoch. It
// imports nothing from the Workers runtime, so it runs outside it.
import { leaseCacheFields, type CacheExecution } from "@fractalboxdev/flare-dispatch-cache";
import type { IntakeRecord } from "@fractalboxdev/flare-dispatch-intake";
import type { ExecutorKind } from "@fractalboxdev/mameko-kernel";
import type { CacheEnv } from "./cache.ts";
import { confidentialCompute, type ConfidentialityEnv } from "./dev-repository.ts";

/**
 * The execution as the cache namespaces read it: the trigger intake recorded, so a pull request writes its own
 * namespace and a push to the default branch writes the protected tier of its executor kind (FD-CACHE-019, FD-CACHE-017).
 */
export const cacheExecutionOf = (record: IntakeRecord): CacheExecution => ({
  repo: record.repo,
  executionId: record.executionId,
  class: record.className,
  constraints: record.placementConstraint === null ? [] : [record.placementConstraint],
  trigger: record.cacheTrigger,
});

/** One lease of an execution: its epoch and the kind of executor that held it, unknown when no row names it. */
export interface LeaseOf {
  readonly epoch: number;
  readonly kind: ExecutorKind | null;
}

/**
 * The `cache_namespaces` and `upload_grant` of the execution's lease at an epoch, expiring at the execution's
 * `deadline_at` as admission wrote it; an unknown kind reads as `device`. A `confidential-compute` repository's lease
 * names no namespace and carries no compile-cache token (FD-CACHE-008), and neither does the lease of a run whose job
 * sandbox is sealed: it reaches no host and holds no tenant-scope secret (FD-GATE-110).
 */
export const leaseCacheAt = (
  env: Pick<CacheEnv, "PUBLIC_ORIGIN" | "COMPILE_CACHE_SECRET"> & ConfidentialityEnv,
  record: IntakeRecord,
  lease: LeaseOf,
  deadlineAt: number,
  sealed = false,
) =>
  leaseCacheFields(
    {
      ...cacheExecutionOf(record),
      confidential: sealed || confidentialCompute(env, record.repo),
    },
    { epoch: lease.epoch, executorKind: lease.kind ?? "device", deadlineAt },
    { publicOrigin: env.PUBLIC_ORIGIN, tokenSecret: env.COMPILE_CACHE_SECRET },
  );
