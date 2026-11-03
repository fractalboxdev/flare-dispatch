// The HTTP API: `packages/api`'s router of mountable groups, and the services each request reads, built from the
// Worker's bindings. A port this deploy cannot back answers `unavailable` naming what it lacks.
import {
  apiConfigFromEnv,
  apiError,
  Cancellation,
  ConfigInvalid,
  d1DeviceRegistry,
  d1Executions,
  d1Intake,
  errorBody,
  executionsGroup,
  executorsGroup,
  dispatchGroup,
  FailureSummaries,
  JwksSourceLive,
  mount,
  oidcKeyFromSecret,
  Operations,
  opsGroup,
  toFetchHandler,
  wellKnownGroup,
  type ApiEnv,
  ApiConfig,
} from "@fractalboxdev/flare-dispatch-api";
import { livenessReport, runOpsMigrations } from "@fractalboxdev/flare-dispatch-ops";
import { Context, Effect, Layer } from "effect";
import { deployment, profileOf, type ControlPlaneEnv } from "./config.ts";
import { devRepositoryOf } from "./dev-repository.ts";

/** The groups the Worker mounts; `/v1/executors/connect` is answered before the router, since it upgrades. */
export const router = mount(
  wellKnownGroup,
  dispatchGroup,
  executionsGroup,
  opsGroup,
  executorsGroup,
);

const handler = toFetchHandler(router, { shared: JwksSourceLive });

/** The posture of a device enrolled with no posture source: a single operator's own workstation. */
const POSTURE_TIER = "unmanaged" as const;

/** mameko offers no cancel of an admitted execution, so cancel answers `unavailable` (FD-IFC-046). */
const cancellationDeferred = Layer.succeed(Cancellation)({
  cancel: () =>
    Effect.fail(apiError("unavailable", "cancel needs mameko's cancel of an admitted execution")),
});

/** The `incident/v1` pack reads step logs this deploy does not index yet (FD-IFC-042). */
const failureSummariesDeferred = Layer.succeed(FailureSummaries)({
  pack: () => Effect.fail(apiError("unavailable", "no failure summary source is configured")),
});

/**
 * The liveness report reads the operability package's record; the operator operations need mameko's operator
 * transaction, which this deploy does not supply, so each answers `unavailable`.
 */
const operations = (env: ControlPlaneEnv) =>
  Layer.succeed(Operations)({
    apply: () =>
      Effect.fail(
        apiError("unavailable", "operator operations need mameko's operator transaction"),
      ),
    health: Effect.promise(async () => {
      await runOpsMigrations(env.DB);
      return (await livenessReport(env.DB, Date.now())) as unknown as Readonly<
        Record<string, unknown>
      >;
    }),
  });

/** A rendered var holding an array arrives as the array; the API reads each identity list as JSON text. */
const textVar = (value: unknown): string | undefined =>
  value === undefined || typeof value === "string" ? value : JSON.stringify(value);

export const apiEnvOf = (env: ControlPlaneEnv): ApiEnv => {
  const raw = env as unknown as Readonly<Record<string, unknown>>;
  return {
    ...(raw as ApiEnv),
    OPERATORS: textVar(raw["OPERATORS"]),
    DISPATCHERS: textVar(raw["DISPATCHERS"]),
  } as ApiEnv;
};

const servicesOf = (env: ControlPlaneEnv) => {
  const profile = profileOf(env);
  const dev = devRepositoryOf(env);
  return Layer.mergeAll(
    d1Executions(env.DB),
    d1Intake({
      db: env.DB,
      channels: env.CHANNEL,
      deployment: deployment(env),
      profile,
      installations: (repository) =>
        Effect.succeed(
          dev !== undefined && dev.repository === repository ? String(dev.installation) : undefined,
        ),
      resolveClass: ({ run, requested }) => Effect.succeed(requested ?? run.spec.limits.qosClass),
    }),
    d1DeviceRegistry({
      db: env.DB,
      anchor: env.EPOCH_ANCHOR.get(env.EPOCH_ANCHOR.idFromName("control-plane")),
      profile,
      posture: () => Effect.succeed(POSTURE_TIER),
      verify: undefined,
    }),
    oidcKeyFromSecret(apiEnvOf(env).OIDC_SIGNING_JWK),
    cancellationDeferred,
    failureSummariesDeferred,
    operations(env),
  );
};

/** One request through the router, with the services its routes read. */
export const apiFetch = async (request: Request, env: ControlPlaneEnv): Promise<Response> => {
  const config = apiConfigFromEnv(apiEnvOf(env), new URL(request.url).origin);
  if (config instanceof ConfigInvalid)
    return Response.json(
      errorBody(apiError("misconfigured", config.message), crypto.randomUUID()),
      {
        status: 503,
      },
    );
  const services = await Effect.runPromise(Layer.build(servicesOf(env)).pipe(Effect.scoped));
  return handler.fetch(request, Context.add(services, ApiConfig, config) as never);
};
