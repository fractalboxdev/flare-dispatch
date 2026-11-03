// The workspace rule (FD-CACHE-002, FD-CACHE-003). A checkout, a workspace and a build-output directory live inside
// the execution's job sandbox and never leave it; a reclaimed execution restarts from an empty workspace and fetches
// the commit again. The control plane's side is that nothing it hands out can carry a workspace: the lease's upload
// grant names only cache, artifact and log prefixes, and the presigner signs only those (presign.ts). The runner's
// side is checked by `checkWorkspaceStart` against what it records when it starts an execution.
import { CACHE_KINDS, type CacheKind } from "./key.ts";
import type { UploadGrant } from "./lease.ts";

/** The only R2 prefixes an executor may write through the control plane. */
export const UPLOAD_PREFIXES = ["cache/", "artifacts/", "logs/"] as const;

/** FD-CACHE-002: every prefix of an upload grant is a cache, artifact or log prefix of this execution. */
export const grantCarriesNoWorkspace = (grant: UploadGrant, executionId: string, epoch: number): boolean =>
  (grant.cache_prefix === null || grant.cache_prefix.startsWith("cache/")) &&
  grant.artifact_prefix === `artifacts/${executionId}/${epoch}/` &&
  grant.log_prefix === `logs/${executionId}/${epoch}/`;

/** What the runner must do when it starts an execution at any epoch, and what it may restore. */
export interface WorkspacePlan {
  /** The workspace directory is empty before the first step: no file from an earlier epoch or execution. */
  readonly emptyWorkspace: true;
  /** The commit is fetched from the repository, never copied from another executor or from the cache. */
  readonly fetchCommit: true;
  /** The only cache kinds the runner restores, each from the namespaces of its lease. */
  readonly restorableKinds: readonly CacheKind[];
}

export const workspacePlan = (): WorkspacePlan => ({
  emptyWorkspace: true,
  fetchCommit: true,
  restorableKinds: CACHE_KINDS,
});

/** What the runner records when it starts an execution. */
export interface WorkspaceStart {
  readonly epoch: number;
  /** Entries found in the workspace directory before the first step. */
  readonly entriesAtStart: number;
  /** The commit came from a fetch of the repository. */
  readonly fetchedCommit: boolean;
  /** The source of each path the runner placed before the first step: a cache restore of a kind, or a transfer. */
  readonly placed: readonly { readonly path: string; readonly source: CacheKind | "transfer" }[];
}

/**
 * The violations of FD-CACHE-002 and FD-CACHE-003 in a runner's start record: an epoch above 1 that started with a
 * non-empty workspace or without fetching the commit, and any path placed by transfer rather than a cache restore.
 */
export const checkWorkspaceStart = (start: WorkspaceStart): readonly string[] => {
  const violations: string[] = [];
  if (start.entriesAtStart > 0)
    violations.push(`FD-CACHE-003: epoch ${start.epoch} started with ${start.entriesAtStart} workspace entries`);
  if (!start.fetchedCommit) violations.push(`FD-CACHE-003: epoch ${start.epoch} did not fetch the commit`);
  for (const p of start.placed)
    if (p.source === "transfer") violations.push(`FD-CACHE-002: ${p.path} was transferred from another executor`);
  return violations;
};
