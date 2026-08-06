import { fileURLToPath } from "node:url";
import { defineWorkersConfig, readD1Migrations } from "@cloudflare/vitest-pool-workers/config";

// Substrate Workers-pool project — the `*.workers.test.ts` suites run INSIDE
// workerd via `@cloudflare/vitest-pool-workers`, against real DO storage and a
// real D1. The Node project (vitest.config.ts) covers the pure engine; this one
// covers what only the runtime can answer: the ticket gate refusing a boot, the
// facade's admission round-trip, and the idempotency-key dedupe.
//
// Pinned to the 0.12.x line for the same reason runtime-cf is — 0.13+ moved to
// Vitest 4's `poolRunner` API.
//
// The DO bindings carry a `container` designator because `Container`'s
// constructor throws when `ctx.container` is undefined — without one, no
// substrate DO class is constructible at all. Nothing is ever built or pulled:
// the engine is off (`enableContainers: false` below), no suite calls `start()`,
// and `this.container.running` reads false throughout. That un-booted state is
// exactly the one the ticket gate and the dedupe record are supposed to work in.
//
// Migrations are read Node-side (`node:fs` does not exist in workerd) and handed
// to the runtime through the `TEST_MIGRATIONS` binding; `src/apply-migrations.ts`
// seeds them into each suite's isolated storage.

const migrations = await readD1Migrations(
  fileURLToPath(new URL("./migrations", import.meta.url)),
);

/**
 * Miniflare's "bind to the worker under test" marker. Written as the registry
 * symbol rather than imported: `miniflare` is the pool's own dependency, not
 * this package's, and `Symbol.for` resolves to the same value across copies —
 * so this needs no dependency and cannot drift from the pool's version.
 */
const CURRENT_WORKER = Symbol.for("miniflare.kCurrentWorker") as never;

export default defineWorkersConfig({
  test: {
    name: "substrate-workers",
    include: ["src/**/*.workers.test.ts"],
    setupFiles: ["./src/apply-migrations.ts"],
    // `@cloudflare/sandbox` ships an ESM bundle that imports
    // `@cloudflare/containers` by bare specifier, and workerd's fallback module
    // service cannot resolve that across the pnpm store ("No such module
    // .../dist/@cloudflare/containers"). Pre-bundling the sandbox package
    // inlines its dependency and the specifier disappears — the pool's
    // documented module-resolution workaround.
    deps: {
      optimizer: { ssr: { enabled: true, include: ["@cloudflare/sandbox"] } },
    },
    poolOptions: {
      workers: {
        singleWorker: true,
        main: "./src/index.ts",
        miniflare: {
          compatibilityDate: "2026-05-01",
          compatibilityFlags: ["nodejs_compat"],
          // No container engine, on purpose. `ctx.container` is still handed to
          // the DO — which is all `Container`'s constructor asks for — but a
          // path that tried to *start* one fails fast here instead of reaching
          // for Docker, so the suite runs identically on a laptop and on a
          // runner and can never silently begin depending on an image.
          enableContainers: false,
          d1Databases: ["ADMISSION_DB"],
          r2Buckets: ["BACKUP_BUCKET"],
          durableObjects: {
            SANDBOX_LEAN: {
              className: "SubstrateSandboxLean",
              useSQLite: true,
              container: { imageName: "substrate-test-lean" },
            },
            SANDBOX_BROWSER: {
              className: "SubstrateSandboxBrowser",
              useSQLite: true,
              container: { imageName: "substrate-test-browser" },
            },
            SANDBOX_AGENT: {
              className: "SubstrateSandboxAgent",
              useSQLite: true,
              container: { imageName: "substrate-test-agent" },
            },
            SANDBOX_TASK: {
              className: "SubstrateSandboxTask",
              useSQLite: true,
              container: { imageName: "substrate-test-task" },
            },
          },
          // Self-bindings to the two facade entrypoints, so the round-trip
          // tests cross a real service binding — the same hop a consumer makes,
          // structured-clone included, rather than an in-isolate method call.
          serviceBindings: {
            DISPATCHER_FACADE: { name: CURRENT_WORKER, entrypoint: "DispatcherFacade" },
            FRACTALBOT_FACADE: { name: CURRENT_WORKER, entrypoint: "FractalbotFacade" },
          },
          bindings: {
            TEST_MIGRATIONS: migrations,
            TICKET_SECRET: "substrate-test-ticket-secret",
            SANDBOX_SLEEP_AFTER: "10m",
            CONTAINERS_CEILING: "16",
            // Small caps so the cap-refusal path is two admissions away rather
            // than seven. Exercises the `POOL_CAPS` override on the way.
            POOL_CAPS: JSON.stringify({ lean: 2, task: 1 }),
          },
        },
      },
    },
  },
});
