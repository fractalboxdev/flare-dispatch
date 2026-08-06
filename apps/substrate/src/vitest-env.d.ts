// Ambient types for the `@cloudflare/vitest-pool-workers` test bindings.
//
// Augments `cloudflare:test`'s `ProvidedEnv` with the substrate's own binding
// surface (`Env`) plus the `TEST_MIGRATIONS` hand-off the workers config wires
// in, so `env` is typed in the in-workerd suites and in `apply-migrations.ts`.
// The base `cloudflare:test` module declaration ships with the pool package.
import type { D1Migration } from "@cloudflare/vitest-pool-workers/config";
import type { DispatcherFacade, FractalbotFacade } from "./facade";
import type { Env } from "./env";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {
    TEST_MIGRATIONS: D1Migration[];
    /** Self-bindings to the two facade entrypoints — the consumer's own view. */
    DISPATCHER_FACADE: Service<DispatcherFacade>;
    FRACTALBOT_FACADE: Service<FractalbotFacade>;
  }
}
