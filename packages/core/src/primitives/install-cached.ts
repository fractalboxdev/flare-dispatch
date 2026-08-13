// Primitive: installCached — R2-backed dependency install
//
// Detects the package manager from the checkout's lockfile, derives a
// content-addressed cache key from the lockfile hash, and restores the
// dependency tree from R2 — running the install only on a cache miss, then
// saving the populated directories back. This is the `cache-pnpm` / `npm` /
// `cargo` / `uv` primitive catalogued in specs/02-runs.md, as one call.
//
// Rides on the `cache` and `sandbox` capabilities. Layer: 03-dsl § Primitives.

import { Effect } from "effect";
import { cache } from "../services/cache";
import { io } from "../services/io";
import { sandbox, type Container } from "../services/sandbox";

// Per-tool: the lockfile that keys the cache, the install command, and the
// directories worth caching. The cache key here is the lockfile hash; the
// runtime `cache` Layer additionally namespaces the R2 archive key per repo,
// so two repos with an identical lockfile cannot collide (cross-repo
// poisoning) — see @fractalboxdev/flare-dispatch-runtime-cf cache-r2.ts.
//
// INVARIANT: `paths` are the directories the tool's own `install` command
// POPULATES, relative to the checkout — nothing else. `pnpm install` writes
// `node_modules` + the store, `npm ci` writes `node_modules`, `uv sync` writes
// `.venv`. Caching anything else stores a BUILD OUTPUT under a dependency key,
// and build outputs have neither of the two properties that make this cache
// safe:
//
//   * They are not bounded by the lockfile. A `target/` accumulates every
//     feature combination, profile and test binary ever produced, while the
//     key only changes when a dependency does — so it grows monotonically and
//     nothing ever evicts it.
//   * They are not free to restore. The archive is expanded onto the
//     container's disk BEFORE the run's first command. Past a point that is
//     not a speed-up but a hard failure: a consumer's cached `target/` reached
//     14 GB against an 18 GB disk, so every run began at 100% full and died on
//     the first write with a bare `disk I/O error` naming neither the disk nor
//     the cache.
//
// Build caching is a real want, but it needs its own key (toolchain + profile +
// feature set), its own eviction, and a size ceiling checked before restore. It
// is not this primitive.
// Exported so the invariant above is assertable. It is the contract this
// primitive makes with every consumer's disk, and the failure it prevents is
// silent (a run that dies at 100% full names neither the cache nor the disk),
// so "someone will notice" is not a guard.
export const TOOLS = {
  pnpm: {
    lockfile: "pnpm-lock.yaml",
    install: "pnpm install --frozen-lockfile",
    // NOT `.pnpm-store`: nothing creates one in a checkout, and `tar czf` exits
    // 2 on a missing member — listing it disabled the whole pnpm save.
    paths: ["node_modules"],
  },
  npm: { lockfile: "package-lock.json", install: "npm ci", paths: ["node_modules"] },
  cargo: {
    lockfile: "Cargo.lock",
    install: "cargo fetch --locked",
    // NOT `target` — see the invariant above. `cargo fetch` downloads sources;
    // it never writes `target`, so caching it was always storing something the
    // install step did not produce.
    //
    // Which leaves cargo with NOTHING CACHEABLE TODAY, and that is stated
    // rather than papered over: `.cargo-registry` does not exist in a checkout.
    // The sandbox image sets `CARGO_HOME=/usr/local/cargo` (infra/Dockerfile.sandbox),
    // so `cargo fetch` populates `/usr/local/cargo/registry`, while `save`/`restore`
    // tar these paths with `cwd` at the checkout — an absolute path outside it
    // cannot be named here. So this entry is inert: a Rust consumer re-downloads
    // its registry every run.
    //
    // That is a deliberate trade, not an oversight. Inert costs a download;
    // caching `target` cost every run outright. Making the registry genuinely
    // cacheable needs `CARGO_HOME` pointed inside the checkout for the install
    // AND for the run command that follows it — a change to how execs carry
    // env, not to this table.
    paths: [".cargo-registry"],
  },
  uv: { lockfile: "uv.lock", install: "uv sync --frozen", paths: [".venv"] },
} as const;

type Tool = keyof typeof TOOLS;

// Auto-detect: the first known lockfile present in the checkout wins.
const detectTool = (opts: { container: Container; dir: string }) =>
  Effect.gen(function* () {
    for (const tool of Object.keys(TOOLS) as Tool[]) {
      const probe = yield* sandbox.exec({
        cwd: opts.dir,
        container: opts.container,
        command: ["test", "-f", TOOLS[tool].lockfile],
      });
      if (probe.exitCode === 0) return tool;
    }
    return undefined;
  });

export const installCached = (opts: {
  container: Container;
  dir: string;
  tool?: Tool; // default: auto-detect from the lockfile
}) =>
  Effect.gen(function* () {
    const tool = opts.tool ?? (yield* detectTool(opts));
    // No recognized lockfile — nothing to install, nothing to cache.
    if (!tool) {
      yield* io.log("info", "installCached: no lockfile detected, skipping");
      return;
    }
    const { lockfile, install, paths } = TOOLS[tool];

    // Hash the lockfile inside the container to key the R2 cache entry.
    const hash = yield* sandbox.exec({
      cwd: opts.dir,
      container: opts.container,
      command: ["sha256sum", lockfile],
    });
    const key = `${tool}-${hash.stdout.trim().slice(0, 64)}`;

    // Restore the dependency tree from R2; on a miss, run the install and the
    // capability saves the populated paths back. Idempotent across step replay.
    yield* cache.restoreOr({
      key,
      paths,
      container: opts.container,
      dir: opts.dir,
      onMiss: () => sandbox.exec({ cwd: opts.dir, container: opts.container, command: install }),
    });
  });
