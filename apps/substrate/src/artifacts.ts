// Where a container's command output lands, and under what key.
//
// Its own module, importing nothing from the Cloudflare runtime, so a Node test
// can reach it. `sandbox-do.ts` pulls in `Sandbox` and `cloudflare:workers`, so
// anything importing it runs only in the Workers pool — which the root
// `vitest.workspace.ts` deliberately omits, meaning `pnpm test` never sees it.
// Split out, the prefix rule is pinned by a suite CI actually runs.

/** The container path the artifacts bucket is mounted at. */
export const ARTIFACTS_DIR = "/artifacts";

/**
 * The per-container R2 prefix `/artifacts` is mounted at.
 *
 * ABSOLUTE, and that is the whole point of naming it: the SDK's
 * `validatePrefix` throws on any prefix without a leading `/`, before any
 * container work, so a relative one is a mount that never happens.
 *
 * The slash does not reach R2 — `normalizeObjectKey` strips it Worker-side, so
 * the stored key stays `artifacts/<doId>/<name>`.
 */
export const artifactsPrefix = (containerId: string): string => `/artifacts/${containerId}/`;
