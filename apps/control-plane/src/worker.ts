// The v2 control plane Worker: mameko's coordinator on host-cloudflare, FlareDispatch's profile, the operability
// routes and `packages/api`'s router. It shares no code with the v1 dispatcher.
import { runApiMigrations } from "@fractalboxdev/flare-dispatch-api";
import { opsFetch, scheduledHandler, tickDepsFromEnv } from "@fractalboxdev/flare-dispatch-ops";
import { CLASS_ORDER } from "@fractalboxdev/flare-dispatch-profile";
import { routeExecutorUpgrade, runD1Migrations } from "@fractalboxdev/mameko-host-cloudflare";
import { deployment, profileOf, type ControlPlaneEnv } from "./config.ts";
import { apiFetch } from "./http.ts";

export {
  EpochAnchor,
  ExecutionEngine,
  ExecutorChannel,
  LivenessMonitor,
} from "./durable-objects.ts";

let migrated: Promise<unknown> | undefined;

const migrate = (env: ControlPlaneEnv) =>
  (migrated ??= (async () => {
    await runD1Migrations(env.DB);
    await runApiMigrations(env.DB);
  })().catch((e: unknown) => {
    migrated = undefined;
    throw e;
  }));

/** `fetch` as a plain function: workerd refuses it called as a method of another object, as the JWKS cache does. */
const boundFetch: typeof fetch = (input, init) => fetch(input, init);

/** The paths `packages/api` declares that the operability routes also match; the API's routes serve them. */
const API_OWNED = /^\/v1\/executions(\/[^/]+\/cancel)?$/;

export default {
  async fetch(request: Request, env: ControlPlaneEnv): Promise<Response> {
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
  /** The minute tick (FD-INT-050): outbox drain, liveness record and the `cron-silent` alarm. */
  scheduled: scheduledHandler((env: ControlPlaneEnv) =>
    tickDepsFromEnv(env as unknown as Parameters<typeof tickDepsFromEnv>[0], {
      profile: profileOf(env),
    }),
  ),
};
