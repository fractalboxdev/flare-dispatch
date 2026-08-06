// Root vitest workspace — picks up every package's own vitest config so
// `pnpm test` at the repo root runs the whole monorepo's suites.
//
// The `packages/*` glob resolves each package's default `vitest.config.ts`
// (Node project). `packages/runtime-cf/vitest.workers.config.ts` and
// `apps/substrate/vitest.workers.config.ts` are registered explicitly as SECOND
// projects for those packages: their `*.workers.test.ts` suites run inside
// workerd via `@cloudflare/vitest-pool-workers`. Projects don't nest, so neither
// can live under its package's own config — they're sibling entries here.
export default [
  "packages/*",
  "packages/runtime-cf/vitest.workers.config.ts",
  "runs",
  "apps/dispatcher",
  "apps/substrate",
  "apps/substrate/vitest.workers.config.ts",
];
