// @fractalbox/flare-dispatch-runtime-cf — CacheR2Live: the live `cache` capability.
//
// Backs `CacheService` with the R2 bucket + the Containers binding. A cache
// entry is a single gzipped tar of the requested paths.
//
//   * restoreOr — `bucket.get` the archive; on a hit, stream it into the
//     container and `tar xzf` it in place. On a miss — or any restore error —
//     run `onMiss`, then best-effort `save`.
//   * save — `tar czf` the paths inside the container, stream the archive out,
//     and `bucket.put` it.
//
// --- Cache key isolation (review fix) ---------------------------------------
//
// The R2 bucket is shared across every repo the Dispatcher serves, so the
// archive key MUST be scoped per repo — otherwise two repos with an identical
// lockfile hash would collide and one could restore (and execute) a
// `node_modules` tree another repo populated: a cross-repo cache-poisoning
// vector. The key is `cache/<repo>/<lockfile-key>.tar.gz`; `<repo>` is the
// owner/name slug threaded in by `makeCFRuntimeLive` from the execution
// context. Within a repo, entries are still reused across executions.
//
// Caching is an optimization, never a correctness primitive: the hit/miss/
// error orchestration lives in `composeRestoreOr` (cache-restore-or.ts, pure
// + unit-tested); this file wires the container-backed `restore` / `save`.
//
// ============================================================================
// Verification scope — same constraint as sandbox-cf.ts
// ============================================================================
//
// The container side (`tar`, `readFileStream`, `writeFile`) cannot run in
// `vitest-pool-workers` — Miniflare has no container runtime — so the live
// `restore` / `save` closures are verified by typecheck + `wrangler deploy
// --dry-run`. Their orchestration is covered by cache-r2.test.ts via
// `composeRestoreOr` with fakes.
//
// Spec: specs/03-dsl.md § cache, specs/02-runs.md § cache-pnpm, plan § PR8.

import { getSandbox, type Sandbox } from "@cloudflare/sandbox";
import { Effect, Layer } from "effect";
import { Cache, CacheError, type CacheService } from "@fractalbox/flare-dispatch-core";
import { readContainerFile } from "./container-file-stream";
import { putStream } from "./r2-put-stream";
import {
  composeRestoreOr,
  type RestoreFn,
  type SaveFn,
} from "./cache-restore-or";

/** Per-repo, content-addressed R2 key for a cache entry. */
const archiveKey = (repo: string, key: string): string =>
  `cache/${repo}/${key}.tar.gz`;

/** In-container scratch path the tarball is packed to / extracted from. */
const TARBALL_PATH = "/tmp/fd-cache.tar.gz";

/**
 * Build the live `Cache` Layer bound to an R2 bucket and the Containers
 * binding. Cache entries are reused across executions but isolated per repo.
 *
 * @param bucket  the R2 binding (`env.RUNS_STORAGE`).
 * @param ns      the `RUNS_SANDBOX` DurableObjectNamespace<Sandbox>.
 * @param repo    the `owner/name` slug — scopes the archive key per repo.
 */
export const makeCacheR2Live = (
  bucket: R2Bucket,
  ns: DurableObjectNamespace<Sandbox>,
  repo: string,
): Layer.Layer<Cache> => {
  const save: SaveFn = (opts) =>
    Effect.tryPromise({
      try: async () => {
        const box = getSandbox(ns, opts.container.id);
        const tar = await box.exec(
          `tar czf ${TARBALL_PATH} ${opts.paths.join(" ")}`,
          { cwd: opts.dir },
        );
        if (tar.exitCode !== 0) {
          throw new Error(`tar czf exited ${tar.exitCode}: ${tar.stderr}`);
        }
        // STREAM the archive into R2 — a node_modules / pnpm-store tarball can
        // be hundreds of MB, well past the Worker's 128 MB isolate budget if
        // buffered whole. `stat` + `readFileStream`, NOT
        // `readFile({encoding:'none'})` — that variant is rpc-transport-only
        // and broke the container upload path on the deployed dispatcher
        // (#88); see container-file-stream.ts.
        const { content, size } = await readContainerFile(box, TARBALL_PATH);
        await putStream(bucket, archiveKey(repo, opts.key), content, size, {
          contentType: "application/gzip",
        });
      },
      catch: (cause) =>
        new CacheError({ phase: "save", key: opts.key, cause }),
    });

  const restore: RestoreFn = (opts) =>
    Effect.tryPromise({
      try: async () => {
        const archive = await bucket.get(archiveKey(repo, opts.key));
        if (archive === null) return false;
        const box = getSandbox(ns, opts.container.id);
        await box.writeFile(TARBALL_PATH, archive.body);
        const untar = await box.exec(`tar xzf ${TARBALL_PATH}`, {
          cwd: opts.dir,
        });
        if (untar.exitCode !== 0) {
          throw new Error(`tar xzf exited ${untar.exitCode}: ${untar.stderr}`);
        }
        return true;
      },
      catch: (cause) =>
        new CacheError({ phase: "restore", key: opts.key, cause }),
    });

  const service: CacheService = {
    restoreOr: composeRestoreOr(restore, save),
    save,
  };

  return Layer.succeed(Cache, service);
};
