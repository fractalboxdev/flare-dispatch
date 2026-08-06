// flare-dispatch substrate — worker entry.
//
// The default export serves only /health; everything real crosses the facade
// entrypoints (facade.ts) or lives in the container DO classes (sandbox-do.ts),
// both re-exported here so wrangler registers them.
import { CONTRACT_VERSION } from "@fractalboxdev/flare-dispatch-substrate-contract";
import { resolvePoolCaps, validatePoolCaps, CONTAINERS_CEILING_DEFAULT } from "./admission/pools";
import { deploymentIdOf, handleVerifyRequest, readCanaryHealth } from "./verify/routes";
import { SUBSTRATE_VERSION } from "./version";
import type { Env } from "./env";

export { DispatcherFacade, FractalbotFacade, SelfCheckFacade } from "./facade";
export {
  SubstrateSandboxAgent,
  SubstrateSandboxBrowser,
  SubstrateSandboxLean,
  SubstrateSandboxTask,
} from "./sandbox-do";

export default {
  /**
   * `/health` reports the substrate's version (patch distribution — a
   * security advisory declares a minimum supported version against this),
   * asserts the pool partition still fits the ceiling, so a bad caps override
   * is visible before any consumer traffic feels it, and answers the question
   * ADR-0011 makes the BYOC health check: has *this build* proved it still
   * denies egress to an unlisted host?
   *
   * That last one fails closed — a deployment with no fresh passing canary
   * answers 503 `unverified`. It reports a claim about a security floor, and an
   * unverified floor must not render the same as a verified one.
   */
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const verify = await handleVerifyRequest(url, request, env, ctx);
    if (verify) return verify;
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

    const canary = await readCanaryHealth(env);
    return Response.json(
      {
        status: canary.verified ? "ok" : "unverified",
        version: SUBSTRATE_VERSION,
        contractVersion: CONTRACT_VERSION,
        deployment: deploymentIdOf(env),
        pools: caps,
        ceiling,
        canary: canary.report,
      },
      { status: canary.verified ? 200 : 503 },
    );
  },
};
