// @fractalboxdev/flare-dispatch-runtime-cf — the pure cache `restoreOr` orchestration.
//
// Factored out of cache-r2.ts so it imports NO Cloudflare bindings (no
// `@cloudflare/sandbox`) and is therefore unit-testable in plain vitest —
// cache-r2.ts wires the live, container-backed `restore` / `save`; this file
// owns only the hit/miss/error sequencing.
//
// Spec: specs/03-dsl.md § cache, specs/pm/plan.md § PR8.

import { Effect } from "effect";
import { CacheError, type Container } from "@fractalboxdev/flare-dispatch-core";

/** Restore a cached archive into a container. `true` = hit, `false` = miss. */
export type RestoreFn = (opts: {
  key: string;
  container: Container;
  dir?: string;
}) => Effect.Effect<boolean, CacheError>;

/** Pack container paths into an archive and persist it. */
export type SaveFn = (opts: {
  key: string;
  paths: readonly string[];
  container: Container;
  dir?: string;
}) => Effect.Effect<void, CacheError>;

/**
 * The pure `restoreOr` orchestration, factored out of any binding so it is
 * unit-testable with fake `restore` / `save`. Best-effort by construction:
 *
 *   - a restore error is swallowed (`orElseSucceed(false)`) → treated as a miss;
 *   - on a hit, `onMiss` is skipped and the Effect completes with `void`;
 *   - on a miss, `onMiss` runs, then `save` runs but its failure is swallowed
 *     (`Effect.ignore`) — the `onMiss` work already succeeded.
 *
 * Returns `void`: on a cache hit there is no `onMiss` value, so `restoreOr`
 * cannot honestly yield an `A`. Consumers (`installCached`) discard it anyway.
 */
export const composeRestoreOr =
  (restore: RestoreFn, save: SaveFn) =>
  <A, E, R>(opts: {
    key: string;
    paths: readonly string[];
    container: Container;
    dir?: string;
    onMiss: () => Effect.Effect<A, E, R>;
  }): Effect.Effect<void, E | CacheError, R> =>
    restore(opts).pipe(
      Effect.orElseSucceed(() => false),
      Effect.flatMap((hit) =>
        hit
          ? Effect.void
          : opts.onMiss().pipe(
              Effect.tap(() => Effect.ignore(save(opts))),
              Effect.asVoid,
            ),
      ),
    );
