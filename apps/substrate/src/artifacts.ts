// Its own module so a Node test can import it — `sandbox-do.ts` pulls in
// `cloudflare:workers`, and the Workers pool is not in the root workspace.

export const ARTIFACTS_DIR = "/artifacts";

/** Leading slash is load-bearing: the SDK's `validatePrefix` rejects without it. */
export const artifactsPrefix = (containerId: string): string => `/artifacts/${containerId}/`;
