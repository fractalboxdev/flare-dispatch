// Root vitest workspace — picks up every package's own vitest config so
// `pnpm test` at the repo root runs the whole monorepo's suites.
//
// The `packages/*` glob resolves each package's default `vitest.config.ts`
// (Node project). `packages/runtime-cf/vitest.workers.config.ts` is registered
// explicitly as a SECOND runtime-cf project: its `*.workers.test.ts` suites run
// inside workerd via `@cloudflare/vitest-pool-workers`. Projects don't nest, so
// it can't live under the package's own config — it's a sibling entry here.
export default [
  "packages/*",
  "packages/runtime-cf/vitest.workers.config.ts",
  "runs",
  "apps/dispatcher",
];
