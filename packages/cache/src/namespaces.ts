// Cache namespaces and cache tiers (specs/cache-artifacts.md § Cache namespaces and cache tiers). The control plane
// assigns them at every lease grant from the execution and the claiming executor's kind; a run or a job never names
// one. The write rule (who may write a tier) and the read rule (who may restore it) together keep a pull-request
// writer from changing what a protected-branch reader restores.
import type { ExecutorKind } from "@fractalboxdev/mameko-kernel";
import { Match } from "effect";

export type CacheTier = "protected-cloud" | "protected-device" | "pull-request" | "execution" | "content";

/** The readable namespace that covers every `cas/<sha256>` entry; a reader requests a digest it already holds. */
export const CONTENT_NAMESPACE = "cas";

/** What started the execution, as far as cache writes are concerned. */
export type CacheTrigger =
  | { readonly _tag: "PullRequest"; readonly number: number }
  /** A push; `protected` is true for the default branch or a branch or tag its ruleset or branch protection guards. */
  | { readonly _tag: "Push"; readonly ref: string; readonly protected: boolean }
  | { readonly _tag: "MergeGroup" }
  /**
   * A rehearsal registered from a capacity lease: a local run, never a protected trigger or a pull request (README
   * § Glossary), so it reads and writes its own execution namespace without widening what either of those reads.
   */
  | { readonly _tag: "Rehearsal" }
  /** A schedule, a manual dispatch or any other trigger: it reads like a protected-branch reader and writes nothing. */
  | { readonly _tag: "Other" };

/** The execution row's facts the `cacheNamespaces` binding reads. */
export interface CacheExecution {
  /** `owner/name`; compared lowercase. */
  readonly repo: string;
  readonly executionId: string;
  readonly class: string;
  /** The placement constraints that held, as the execution row records them (e.g. `cloud-only`). */
  readonly constraints: readonly string[];
  readonly trigger: CacheTrigger;
}

/** The lease's `cache_namespaces` field: readable namespaces in lookup order and at most one writable namespace. */
export interface CacheNamespaces {
  readonly read: readonly string[];
  readonly write: string | null;
}

const OWNER = /^[a-z0-9][a-z0-9-]{0,38}$/;
const NAME = /^[a-z0-9._-]{1,100}$/;

/** The lowercase `owner/name`, or `undefined` when it is not a repository slug. */
export const repoSlug = (repo: string): string | undefined => {
  const [owner, name, ...rest] = repo.toLowerCase().split("/");
  if (rest.length > 0 || owner === undefined || name === undefined) return undefined;
  if (!OWNER.test(owner) || !NAME.test(name) || name === "." || name === "..") return undefined;
  return `${owner}/${name}`;
};

export const protectedCloud = (repo: string) => `protected/${repo}/cloud`;
export const protectedDevice = (repo: string) => `protected/${repo}/device`;
export const pullRequestNamespace = (repo: string, number: number) => `pr/${repo}/${number}`;
export const executionNamespace = (repo: string, executionId: string) =>
  `exec/${repo}/${executionId}`;

const CLOUD_KINDS: readonly ExecutorKind[] = ["cloudflare", "aws"];
export const isCloudKind = (kind: ExecutorKind): boolean => CLOUD_KINDS.includes(kind);

/** A `gh-readonly-queue/*` push carries several pull requests' code and is never a protected trigger. */
const isMergeQueueRef = (ref: string) =>
  ref.replace(/^refs\/heads\//, "").startsWith("gh-readonly-queue/");

/** A protected trigger (README § Glossary): a protected push that is not a merge-queue branch. */
export const isProtectedTrigger = (trigger: CacheTrigger): boolean =>
  Match.value(trigger).pipe(
    Match.tag("Push", (p) => p.protected && !isMergeQueueRef(p.ref)),
    Match.orElse(() => false),
  );

/** `release` builds cold and `cloud-only` restores nothing (FD-CACHE-028). */
export const restoresNothing = (execution: Pick<CacheExecution, "class" | "constraints">) =>
  execution.class === "release" || execution.constraints.includes("cloud-only");

const writable = (execution: CacheExecution, repo: string, kind: ExecutorKind): string | null => {
  // FD-CACHE-021: a rehearsal or a `gha` execution writes at most its own execution namespace.
  if (kind === "gha") return executionNamespace(repo, execution.executionId);
  return Match.value(execution.trigger).pipe(
    Match.tag("Rehearsal", () => executionNamespace(repo, execution.executionId)),
    Match.tag("PullRequest", ({ number }) => pullRequestNamespace(repo, number)),
    Match.tag("Push", (push) => {
      if (!isProtectedTrigger(push)) return null;
      if (isCloudKind(kind)) return protectedCloud(repo);
      return kind === "device" ? protectedDevice(repo) : null;
    }),
    Match.tag("MergeGroup", () => null),
    Match.tag("Other", () => null),
    Match.exhaustive,
  );
};

const readable = (execution: CacheExecution, repo: string, kind: ExecutorKind): string[] => {
  if (restoresNothing(execution)) return [];
  // FD-CACHE-025: a cloud executor never reads the device tier.
  const protectedTiers =
    kind === "device" ? [protectedCloud(repo), protectedDevice(repo)] : [protectedCloud(repo)];
  const own = Match.value(execution.trigger).pipe(
    Match.tag("PullRequest", ({ number }) => [pullRequestNamespace(repo, number)]),
    Match.orElse(() => [] as string[]),
  );
  // A rehearsal reads its own execution namespace; a `gha` execution writes its own but reads only what its trigger
  // may, so FD-CACHE-022 and FD-CACHE-023 hold for it too.
  const exec =
    execution.trigger._tag === "Rehearsal" ? [executionNamespace(repo, execution.executionId)] : [];
  // FD-CACHE-024: the execution's own namespace comes before any protected tier.
  return [...exec, ...own, ...protectedTiers, CONTENT_NAMESPACE];
};

/**
 * The profile's `cacheNamespaces` binding (FD-CACHE-015): the namespaces an execution reads, in lookup order, and the
 * one it writes, from the execution row and the claiming executor's kind. An execution whose repository is not a
 * slug gets no namespace, so a malformed row reads and writes no cache.
 */
export const cacheNamespaces = (execution: CacheExecution, kind: ExecutorKind): CacheNamespaces => {
  const repo = repoSlug(execution.repo);
  if (repo === undefined) return { read: [], write: null };
  return { read: readable(execution, repo, kind), write: writable(execution, repo, kind) };
};

/** A capacity lease's member and repository, as the `capacityGrant` binding sees them. */
export interface CapacityLeaseFacts {
  readonly repo: string;
  readonly leaseId: string;
}

/**
 * The profile's `capacityGrant` binding's namespaces (FD-CACHE-015 under FD-CACHE-021): a capacity lease's work is
 * rehearsal work, so it writes only its own execution namespace and reads it, the protected tiers a device may read
 * and the content tier.
 */
export const capacityNamespaces = (lease: CapacityLeaseFacts): CacheNamespaces => {
  const repo = repoSlug(lease.repo);
  if (repo === undefined) return { read: [], write: null };
  const own = executionNamespace(repo, lease.leaseId);
  return {
    read: [own, protectedCloud(repo), protectedDevice(repo), CONTENT_NAMESPACE],
    write: own,
  };
};

/** The tier of a namespace id, or `undefined` for an id outside the grammar. */
export const tierOf = (namespace: string): CacheTier | undefined => {
  if (namespace === CONTENT_NAMESPACE || /^cas\/[0-9a-f]{64}$/.test(namespace)) return "content";
  const parts = namespace.split("/");
  if (parts[0] === "protected" && parts.length === 4)
    return parts[3] === "cloud"
      ? "protected-cloud"
      : parts[3] === "device"
        ? "protected-device"
        : undefined;
  if (parts[0] === "pr" && parts.length === 4 && /^[1-9][0-9]{0,9}$/.test(parts[3] ?? ""))
    return "pull-request";
  if (parts[0] === "exec" && parts.length === 4) return "execution";
  return undefined;
};

/** The `owner/name` a namespace belongs to, or `undefined` for the content tier. */
export const repoOfNamespace = (namespace: string): string | undefined => {
  const parts = namespace.split("/");
  return parts.length === 4 && parts[0] !== "cas" ? `${parts[1]}/${parts[2]}` : undefined;
};
