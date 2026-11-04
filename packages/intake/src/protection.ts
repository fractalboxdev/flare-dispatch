// The protection reads intake takes from GitHub: each branch's required set, the `protection-snapshot` input of class
// resolution, and whether a ruleset or branch protection protects a ref, which decides a protected trigger
// (specs/profile.md § Class resolution, specs/README.md § Glossary). Both are cached for at most 10 min and dropped for
// a repository on every `repository_ruleset` and `branch_protection_rule` webhook (FD-PROF-014). A read that fails
// answers `Unavailable` with the reason the binding acts on, never an empty set or `false`.
import { GithubRead, type GithubReadError } from "@fractalboxdev/flare-dispatch-github";
import {
  PROTECTION_TTL_MS,
  ProtectionSnapshotCache,
  type ProtectionSnapshot,
} from "@fractalboxdev/flare-dispatch-profile";
import type { Unavailable } from "@fractalboxdev/mameko-coordinator";
import { Clock, Context, Effect, Layer, Match, Option } from "effect";

/** How long one protection read may take before it answers `Unavailable` with reason `timeout`. */
export const PROTECTION_READ_TIMEOUT = "10 seconds";

/** The events that drop a repository's cached protection (FD-PROF-014). */
export const PROTECTION_EVENTS: ReadonlySet<string> = new Set([
  "repository_ruleset",
  "branch_protection_rule",
]);

export const isUnavailable = (v: unknown): v is Unavailable =>
  typeof v === "object" && v !== null && (v as { _tag?: unknown })._tag === "Unavailable";

const unavailable = (reason: "forbidden" | "timeout" | "server-error"): Unavailable => ({
  _tag: "Unavailable",
  reason,
});

/**
 * A refused read is `forbidden` (FD-PROF-016): a `401` or `403` that is not a rate limit, or no installation serving the
 * repository. No answer is `timeout`; every other failure is `server-error` (FD-PROF-015).
 */
export const unavailableOf = (e: GithubReadError): Unavailable =>
  Match.value(e).pipe(
    Match.tag("GithubHttpError", (h) =>
      (h.status === 401 || h.status === 403) && !h.rateLimited
        ? unavailable("forbidden")
        : unavailable("server-error"),
    ),
    Match.tag("GithubUncredentialed", () => unavailable("forbidden")),
    Match.tag("GithubNetworkError", () => unavailable("timeout")),
    Match.tag("GithubUnexpected", () => unavailable("server-error")),
    Match.exhaustive,
  );

const bounded = <A>(read: Effect.Effect<A, GithubReadError>): Effect.Effect<A | Unavailable> =>
  read.pipe(
    Effect.timeoutOption(PROTECTION_READ_TIMEOUT),
    Effect.map(Option.getOrElse((): A | Unavailable => unavailable("timeout"))),
    Effect.catch((e) => Effect.succeed(unavailableOf(e))),
  );

export class ProtectionSnapshots extends Context.Service<
  ProtectionSnapshots,
  {
    /** The `protection-snapshot` input for `branch`: its ruleset and branch-protection required check names. */
    readonly requiredSet: (
      repo: string,
      branch: string,
    ) => Effect.Effect<ProtectionSnapshot | Unavailable>;
    /** Whether a ruleset or branch protection protects `ref`, a `refs/heads/` or `refs/tags/` ref. */
    readonly refProtected: (repo: string, ref: string) => Effect.Effect<boolean | Unavailable>;
    /**
     * Drops the cached protection of `repo`, or of every repository when the event names none (an organization
     * ruleset), when `event` is one of the two protection events; answers whether it was.
     */
    readonly refresh: (event: string, repo: string | null) => Effect.Effect<boolean>;
  }
>()("@fractalboxdev/flare-dispatch-intake/ProtectionSnapshots") {}

/** The protection reads over `GithubRead`, with one cache per isolate. */
export const protectionSnapshotsLayer = Layer.effect(
  ProtectionSnapshots,
  Effect.gen(function* () {
    const github = yield* GithubRead;
    let required = new ProtectionSnapshotCache();
    const refs = new Map<string, { readonly at: number; readonly value: boolean }>();

    return {
      requiredSet: (repo, branch) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const hit = required.get(repo, branch, now);
          if (hit !== undefined) return hit;
          const read = yield* bounded(github.requiredChecks(repo, branch));
          if (isUnavailable(read)) return read;
          const snapshot: ProtectionSnapshot = { requiredChecks: read };
          required.put(repo, branch, snapshot, now);
          return snapshot;
        }),
      refProtected: (repo, ref) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const key = `${repo}#${ref}`;
          const hit = refs.get(key);
          if (hit !== undefined && now - hit.at < PROTECTION_TTL_MS) return hit.value;
          refs.delete(key);
          const read = yield* bounded(github.refProtected(repo, ref));
          if (!isUnavailable(read)) refs.set(key, { at: now, value: read });
          return read;
        }),
      refresh: (event, repo) =>
        Effect.sync(() => {
          if (!PROTECTION_EVENTS.has(event)) return false;
          if (repo === null) {
            required = new ProtectionSnapshotCache();
            refs.clear();
            return true;
          }
          required.onWebhook(event, repo);
          for (const key of refs.keys()) if (key.startsWith(`${repo}#`)) refs.delete(key);
          return true;
        }),
    };
  }),
);
