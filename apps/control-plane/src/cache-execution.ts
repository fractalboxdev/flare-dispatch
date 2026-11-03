// The execution row the cache namespaces read, from intake's record. It imports types only, so it runs outside the
// Workers runtime.
import type { CacheExecution } from "@fractalboxdev/flare-dispatch-cache";
import type { IntakeRecord } from "@fractalboxdev/flare-dispatch-intake";

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
