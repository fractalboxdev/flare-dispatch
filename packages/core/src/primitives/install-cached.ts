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
// poisoning) — see @fractalbox/flare-dispatch-runtime-cf cache-r2.ts.
const TOOLS = {
  pnpm: {
    lockfile: "pnpm-lock.yaml",
    install: "pnpm install --frozen-lockfile",
    paths: ["node_modules", ".pnpm-store"],
  },
  npm: { lockfile: "package-lock.json", install: "npm ci", paths: ["node_modules"] },
  cargo: {
    lockfile: "Cargo.lock",
    install: "cargo fetch --locked",
    paths: ["target", ".cargo-registry"],
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
      onMiss: () =>
        sandbox.exec({ cwd: opts.dir, container: opts.container, command: install }),
    });
  });
