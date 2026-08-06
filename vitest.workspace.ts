// Root vitest workspace — picks up every package's own vitest config so
// `pnpm test` at the repo root runs the whole monorepo's suites.
//
// The `packages/*` glob resolves each package's default `vitest.config.ts`
// (Node project). `packages/runtime-cf/vitest.workers.config.ts` is registered
// explicitly as a SECOND runtime-cf project: its `*.workers.test.ts` suites run
// inside workerd via `@cloudflare/vitest-pool-workers`. Projects don't nest, so
// it can't live under the package's own config — it's a sibling entry here.
//
// `apps/substrate/vitest.workers.config.ts` is deliberately NOT listed. It is a
// second workers-pool project like runtime-cf's, but its Durable Objects are
// container-backed, and a container-backed DO needs a container engine to
// construct at all — which the sandbox that runs `offload-test` does not have.
// Measured in that exact image (`cloudflare/sandbox:0.10.1`): runtime-cf's
// workers project passes 32/32 while the substrate's fails 22/29 on workerd
// `internal error`, so listing it here turns every PR red. Run it with
// `pnpm --filter @fractalboxdev/flare-dispatch-substrate test:workers`; the
// project's own header explains what CI therefore does not cover.
export default [
  "packages/*",
  "packages/runtime-cf/vitest.workers.config.ts",
  "runs",
  "apps/dispatcher",
  "apps/substrate",
];
