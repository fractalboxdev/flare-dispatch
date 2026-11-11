// The v2 control plane Worker: mameko's coordinator on host-cloudflare, FlareDispatch's profile, the operability
// routes and `packages/api`'s router. It shares no code with the v1 dispatcher.
import { runApiMigrations } from "@fractalboxdev/flare-dispatch-api";
import { migrateIntake } from "@fractalboxdev/flare-dispatch-intake";
import { opsFetch, scheduledHandler } from "@fractalboxdev/flare-dispatch-ops";
import { CLASS_ORDER } from "@fractalboxdev/flare-dispatch-profile";
import { routeExecutorUpgrade, runD1Migrations } from "@fractalboxdev/mameko-host-cloudflare";
import { Effect } from "effect";
import { deployment, type ControlPlaneEnv } from "./config.ts";
import { migrateLocalStore } from "./agentic.ts";
import { cacheFetch, cacheSweeps } from "./cache.ts";
import { boundFetch } from "./github.ts";
import { apiFetch } from "./http.ts";
import { tickDeps } from "./tick.ts";

export {
  CacheLedger,
  EpochAnchor,
  ExecutionEngine,
  ExecutorChannel,
  LivenessMonitor,
} from "./durable-objects.ts";
export {
  AgentPool,
  BrowserPool,
  ControlPool,
  InstallationQuota,
  LeanPool,
  PoolController,
  ReleasePool,
} from "./deferred-objects.ts";

let migrated: Promise<unknown> | undefined;

const migrate = (env: ControlPlaneEnv) =>
  (migrated ??= (async () => {
    await runD1Migrations(env.DB);
    await runApiMigrations(env.DB);
    await Effect.runPromise(migrateIntake(env.DB));
    await migrateLocalStore(env.DB);
  })().catch((e: unknown) => {
    migrated = undefined;
    throw e;
  }));

/** The paths `packages/api` declares that the operability routes also match; the API's routes serve them. */
const API_OWNED = /^\/v1\/executions(\/[^/]+\/cancel)?$/;

export default {
  async fetch(
    request: Request,
    env: ControlPlaneEnv,
    ctx: { waitUntil(p: Promise<unknown>): void },
  ): Promise<Response> {
    const { pathname } = new URL(request.url);
    // The deployment and plane id, which `pnpm dogfood` checks before it enrolls a device.
    if (pathname === "/health")
      return Response.json({ status: "ok", deployment: deployment(env), plane_id: env.PLANE_ID });
    await migrate(env);
    // The route verifies the upgrade's connect signature, the one device credential (FD-IFC-085).
    if (pathname === "/v1/executors/connect")
      return routeExecutorUpgrade(request, {
        db: env.DB,
        channel: env.CHANNEL,
        planeId: env.PLANE_ID,
      });
    // The compile-cache route checks its own token (FD-CACHE-051); the log and artifact reads are the router's.
    const cached = await cacheFetch(request, env, (p) => ctx.waitUntil(p));
    if (cached !== null) return cached;
    // The dashboard, `/v1/ops/health`, `/v1/ops/fleet`, the install routes and `/v1/spend`, each behind its own gate.
    if (!API_OWNED.test(pathname)) {
      const ops = await opsFetch(request, env as unknown as Parameters<typeof opsFetch>[1], {
        classes: CLASS_ORDER,
        fetch: boundFetch,
      });
      if (ops !== null) return ops;
    }
    return apiFetch(request, env);
  },
  /**
   * The minute tick (FD-INT-050): liveness record, `cron-silent`, the outbox drain through the GitHub applier and
   * intake's sweep and schedule units, and the cache, artifact and log retention sweeps.
   */
  scheduled: scheduledHandler((env: ControlPlaneEnv) => tickDeps(env, cacheSweeps(env))),
};
