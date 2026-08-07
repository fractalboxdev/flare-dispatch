// Where a container's command output lands, and under what key.
//
// Its own module, importing nothing from the Cloudflare runtime, for one
// reason: `sandbox-do.ts` pulls in `Sandbox` and `cloudflare:workers`, so a
// test that imports it can only run in the Workers pool — and
// `apps/substrate/vitest.workers.config.ts` is deliberately NOT registered in
// the root workspace (its header explains why: container-backed Durable
// Objects cannot construct without a container engine, so listing it "turns
// every PR red"). A guard that lives only there is a guard `pnpm test` never
// runs. Split out, the prefix rule is pinned by a Node test CI actually
// executes.

/** The container path the artifacts bucket is mounted at. */
export const ARTIFACTS_DIR = "/artifacts";

/**
 * The per-container R2 prefix `/artifacts` is mounted at.
 *
 * ABSOLUTE, and that is the whole point of naming it. The SDK's
 * `validatePrefix` throws `InvalidMountConfigError` on any prefix that does not
 * start with `/`, identically in 0.10.1 and 0.12.4, and it runs before any
 * container work — so a relative prefix is not a degraded mount, it is a mount
 * that never happens, on every boot, deterministically.
 *
 * The leading slash does not reach R2. For an R2-binding mount the prefix is
 * enforced Worker-side, where the handler normalises the key (leading slashes
 * stripped) before use, so the stored key stays `artifacts/<doId>/<name>`.
 *
 * Scoped by container id because one bucket serves every execution and two of
 * them must not read or overwrite each other's output.
 */
export const artifactsPrefix = (containerId: string): string => `/artifacts/${containerId}/`;
