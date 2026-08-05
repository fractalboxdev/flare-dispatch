// flare-dispatch substrate — worker entry.
//
// The default export serves only /health; everything real crosses the facade
// entrypoints (facade.ts) or lives in the container DO classes (sandbox-do.ts),
// both re-exported here so wrangler registers them.
import { CONTRACT_VERSION } from "@fractalboxdev/flare-dispatch-substrate-contract";
import { resolvePoolCaps, validatePoolCaps, CONTAINERS_CEILING_DEFAULT } from "./admission/pools";
import { SUBSTRATE_VERSION } from "./version";
import type { Env } from "./env";

export { DispatcherFacade, FractalbotFacade } from "./facade";
export {
  SubstrateSandboxAgent,
  SubstrateSandboxBrowser,
  SubstrateSandboxLean,
  SubstrateSandboxTask,
} from "./sandbox-do";

export default {
  /**
   * `/health` reports the substrate's version (patch distribution — a
   * security advisory declares a minimum supported version against this) and
   * asserts the pool partition still fits the ceiling, so a bad caps override
   * is visible before any consumer traffic feels it.
   */
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/health") return new Response("not found", { status: 404 });

    const caps = resolvePoolCaps(env.POOL_CAPS);
    const ceiling = Number.parseInt(env.CONTAINERS_CEILING ?? "", 10) || CONTAINERS_CEILING_DEFAULT;
    try {
      validatePoolCaps(caps, ceiling);
    } catch (err) {
      return Response.json(
        {
          status: "misconfigured",
          version: SUBSTRATE_VERSION,
          reason: err instanceof Error ? err.message : String(err),
        },
        { status: 500 },
      );
    }
    return Response.json({
      status: "ok",
      version: SUBSTRATE_VERSION,
      contractVersion: CONTRACT_VERSION,
      pools: caps,
      ceiling,
    });
  },
};
