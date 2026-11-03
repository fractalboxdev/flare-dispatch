// The cache and upload fields of an execution lease, and the control plane's view of a lease that every presign,
// commit and compile-cache request checks. `leaseCacheFields` is what the control plane's `leaseFields` returns as
// `cache_namespaces` and `upload_grant`.
import type { ExecutorKind } from "@fractalboxdev/mameko-kernel";
import { Context, Effect } from "effect";
import { signCompileCacheToken } from "./compile-cache-token.ts";
import { GiB, MiB } from "./ledger.ts";
import { cacheNamespaces, repoSlug, type CacheExecution, type CacheNamespaces } from "./namespaces.ts";

/** Byte bounds the executor and the control plane share; the control plane enforces each. */
export interface ByteBounds {
  /** Per-object bound of a compile-cache object (FD-CACHE-053). */
  readonly maxCompileObjectBytes: number;
  /** Per-object bound of any other object (FD-CACHE-053). */
  readonly maxObjectBytes: number;
  /** An artifact body at most this size goes up in one `PUT` (FD-CACHE-072). */
  readonly singlePutMaxBytes: number;
  /** The smallest multipart part, every part but the last (FD-CACHE-072). */
  readonly minPartBytes: number;
  /** Per-execution artifact bound (FD-CACHE-074). */
  readonly maxExecutionArtifactBytes: number;
}

export const DEFAULT_BYTE_BOUNDS: ByteBounds = {
  maxCompileObjectBytes: 100 * MiB,
  maxObjectBytes: 4 * GiB,
  singlePutMaxBytes: 16 * MiB,
  minPartBytes: 8 * MiB,
  maxExecutionArtifactBytes: 2 * GiB,
};

/** The lease's `upload_grant`: where the executor's uploads go and the bounds the control plane holds them to. */
export interface UploadGrant {
  /** `cache/<namespace>/<key>/<execution_id>.<epoch>/` objects go under the writable namespace only. */
  readonly cache_prefix: string | null;
  readonly artifact_prefix: string;
  readonly log_prefix: string;
  readonly compile_cache: { readonly endpoint: string; readonly token: string } | null;
  readonly bounds: ByteBounds;
}

export interface LeaseCacheConfig {
  /** The control plane's public origin, e.g. `https://ci.example.com`; without it no compile-cache access is given. */
  readonly publicOrigin: string | undefined;
  /** The Worker secret the compile-cache token's key derives from; without it no compile-cache access is given. */
  readonly tokenSecret: string | undefined;
  readonly bounds?: ByteBounds;
}

/**
 * The cache fields of an execution lease: the namespaces of the `cacheNamespaces` binding, computed from the
 * execution row and the claiming executor's kind and never from the run inputs (FD-CACHE-016), and the upload grant
 * with a compile-cache token bound to this epoch (FD-CACHE-057). A repository whose confidentiality mode is
 * `confidential-compute` gets no L2 access at all (FD-CACHE-008).
 */
export const leaseCacheFields = async (
  execution: CacheExecution & { readonly confidential?: boolean },
  lease: { readonly epoch: number; readonly executorKind: ExecutorKind; readonly deadlineAt: number },
  config: LeaseCacheConfig,
): Promise<{ readonly cache_namespaces: CacheNamespaces; readonly upload_grant: UploadGrant }> => {
  const bounds = config.bounds ?? DEFAULT_BYTE_BOUNDS;
  const repo = repoSlug(execution.repo);
  const namespaces =
    execution.confidential === true || repo === undefined
      ? { read: [], write: null }
      : cacheNamespaces(execution, lease.executorKind);
  const epochPath = `${execution.executionId}/${lease.epoch}/`;
  const token =
    repo === undefined ||
    execution.confidential === true ||
    config.publicOrigin === undefined ||
    config.publicOrigin === "" ||
    config.tokenSecret === undefined ||
    config.tokenSecret === "" ||
    namespaces.read.length + (namespaces.write === null ? 0 : 1) === 0
      ? null
      : await signCompileCacheToken(config.tokenSecret, {
          repo,
          executionId: execution.executionId,
          epoch: lease.epoch,
          read: namespaces.read,
          write: namespaces.write,
          expiresAt: lease.deadlineAt,
        });
  return {
    cache_namespaces: namespaces,
    upload_grant: {
      cache_prefix: namespaces.write === null ? null : `cache/${namespaces.write}/`,
      artifact_prefix: `artifacts/${epochPath}`,
      log_prefix: `logs/${epochPath}`,
      compile_cache:
        token === null
          ? null
          : {
              endpoint: `${config.publicOrigin!.replace(/\/$/, "")}/v1/compile-cache/${repo}`,
              token,
            },
      bounds,
    },
  };
};

/** The control plane's view of an execution's lease, read on every presign, commit and compile-cache request. */
export interface LeaseState {
  readonly executionId: string;
  /** `owner/name`, lowercase. */
  readonly repo: string;
  /** The execution's current epoch. */
  readonly epoch: number;
  /** `active` while the execution may still write; `terminal` once it reached a terminal status. */
  readonly status: "active" | "terminal";
  readonly namespaces: CacheNamespaces;
  readonly executorId: string;
  readonly executorKind: ExecutorKind;
  readonly class: string;
  readonly deadlineAt: number;
  /** True while the repository's confidentiality mode is `confidential-compute`. */
  readonly confidential?: boolean;
}

export interface CacheLeasesService {
  readonly current: (executionId: string) => Effect.Effect<LeaseState | null>;
}

export class CacheLeases extends Context.Service<CacheLeases, CacheLeasesService>()(
  "@fractalboxdev/flare-dispatch-cache/CacheLeases",
) {}

/** The control plane's clock, epoch ms; a test supplies its own. */
export class CacheClock extends Context.Service<
  CacheClock,
  { readonly now: () => number }
>()("@fractalboxdev/flare-dispatch-cache/CacheClock") {}

/** A fixed set of leases, for tests and for a single-isolate fake. */
export const memoryLeases = (leases: Map<string, LeaseState>): CacheLeasesService => ({
  current: (id) => Effect.sync(() => leases.get(id) ?? null),
});
