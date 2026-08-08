// Its own module so a Node test can import it — `sandbox-do.ts` pulls in
// `cloudflare:workers`, and `vitest.workspace.ts` omits the Workers config.

export const ARTIFACTS_DIR = "/artifacts";

/**
 * Leading slash is load-bearing: the SDK's `validatePrefix` rejects without it.
 * It does not reach R2 — `normalizeObjectKey` strips it Worker-side, so the
 * stored key stays `artifacts/<doId>/<name>`.
 */
export const artifactsPrefix = (containerId: string): string => `/artifacts/${containerId}/`;
