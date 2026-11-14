// The v2 control plane Worker: mameko's coordinator on host-cloudflare, FlareDispatch's profile, the dashboard pages
// and `packages/api`'s router, which serves the declared `/v1/` routes. It shares no code with the v1 dispatcher.
import { runApiMigrations } from "@fractalboxdev/flare-dispatch-api";
import { moveLegacyArtifactsTable } from "@fractalboxdev/flare-dispatch-cache";
import { migrateChildConclusions } from "@fractalboxdev/flare-dispatch-github";
import { migrateIntake } from "@fractalboxdev/flare-dispatch-intake";
import { opsFetch, scheduledHandler } from "@fractalboxdev/flare-dispatch-ops";
import { CLASS_ORDER } from "@fractalboxdev/flare-dispatch-profile";
import { routeExecutorUpgrade, runD1Migrations } from "@fractalboxdev/mameko-host-cloudflare";
import { Effect } from "effect";
import { healthOf, type ControlPlaneEnv } from "./config.ts";
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
  IntakeUnits,
  LivenessMonitor,
  TransparencyLog,
} from "./durable-objects.ts";
export {
  AgentPool,
  BrowserPool,
  ControlPool,
  LeanPool,
  PoolController,
  ReleasePool,
} from "./deferred-objects.ts";
export { InstallationQuota } from "./installation-quota.ts";
export { MamekoDrain } from "./drain.ts";

let migrated: Promise<unknown> | undefined;

const migrate = (env: ControlPlaneEnv) =>
  (migrated ??= (async () => {
    // The artifact store's table moves to `fd_artifacts` before mameko's migration 33 creates its own `artifacts`.
    await moveLegacyArtifactsTable(env.DB as unknown as D1Database);
    await runD1Migrations(env.DB);
    await Effect.runPromise(migrateChildConclusions(env.DB));
    await runApiMigrations(env.DB);
    await Effect.runPromise(migrateIntake(env.DB));
    await migrateLocalStore(env.DB);
  })().catch((e: unknown) => {
    migrated = undefined;
    throw e;
  }));

/** The dashboard's pages: the overview and one execution's page. The router serves the `/v1/` routes (FD-IFC-001). */
const DASHBOARD = /^\/(executions\/[^/]+)?$/;

export default {
  async fetch(
    request: Request,
    env: ControlPlaneEnv,
    ctx: { waitUntil(p: Promise<unknown>): void },
  ): Promise<Response> {
    const { pathname, origin } = new URL(request.url);
    // The deployment and plane id, which `pnpm ci:local` checks before it enrolls a device; `503` on a configuration
    // the API refuses, so the post-deploy probe fails the deploy.
    if (pathname === "/health") {
      const health = healthOf(env, origin);
      return Response.json(health.body, { status: health.status });
    }
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
    // The dashboard's pages, behind the Access gate.
    if (DASHBOARD.test(pathname)) {
      const ops = await opsFetch(request, env as unknown as Parameters<typeof opsFetch>[1], {
        classes: CLASS_ORDER,
        fetch: boundFetch,
      });
      if (ops !== null) return ops;
    }
    return apiFetch(request, env);
  },
  /**
   * The minute tick (FD-INT-050): liveness record, `cron-silent`, the outbox drain through the GitHub applier, the
   * enqueue of intake's sweep and schedule units (FD-INT-067), and the cache, artifact and log retention sweeps.
   */
  scheduled: scheduledHandler((env: ControlPlaneEnv) => tickDeps(env, cacheSweeps(env))),
};
