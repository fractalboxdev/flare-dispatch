// The HTTP API: `packages/api`'s router of mountable groups, with intake's webhook route under `/v1/`, and the services
// each request reads, built from the Worker's bindings. `POST /v1/dispatch/:run` is the declaration's dispatch group
// over intake's admission (FD-IFC-001). A port this deploy cannot back answers `unavailable` naming what it lacks.
import {
  ApiConfig,
  apiConfigFromEnv,
  apiError,
  artifactsGroup,
  Cancellation,
  ConfigInvalid,
  d1DeviceRegistry,
  d1Executions,
  dispatchGroup,
  errorBody,
  executionsGroup,
  executorsGroup,
  JwksSourceLive,
  logsGroup,
  mount,
  oidcKeyFromSecret,
  Operations,
  opsGroup,
  RequestId,
  routerGroup,
  toFetchHandler,
  wellKnownGroup,
} from "@fractalboxdev/flare-dispatch-api";
import { handleIntake, WEBHOOK_MAX_BYTES } from "@fractalboxdev/flare-dispatch-intake";
import { livenessReport, runOpsMigrations } from "@fractalboxdev/flare-dispatch-ops";
import { Context, Effect, Layer } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { ArtifactsHandlers, cacheReads, LogsHandlers } from "./cache.ts";
import { isolateServices, type IsolateServices } from "./composition.ts";
import { apiEnvOf, profileOf, type ControlPlaneEnv } from "./config.ts";
import { failureSummaries } from "./failure-summary.ts";
import { intakePort } from "./intake-port.ts";

/** Intake's webhook route, below the `/v1/` mount: the request and the path below it, as `handleIntake` takes them. */
const intakeRoute = Effect.gen(function* () {
  const request = (yield* HttpServerRequest.HttpServerRequest).source as Request;
  const path = new URL(request.url).pathname.replace(/^\/v1\//, "");
  const response = yield* handleIntake(request, path);
  return HttpServerResponse.fromWeb(
    response ??
      Response.json(errorBody(apiError("not_found", "no such route"), yield* RequestId), {
        status: 404,
      }),
  );
});

/** `POST /v1/webhooks/github` checks its own HMAC (FD-INT-022) over the raw body the declaration cannot model. */
export const intakeGroup = routerGroup(
  "intake",
  [
    {
      method: "POST",
      path: "/v1/webhooks/github",
      surface: { _tag: "OwnCredential" },
      maxBodyBytes: WEBHOOK_MAX_BYTES,
    },
  ],
  HttpRouter.add("POST", "/v1/webhooks/github", intakeRoute) as never,
);

/**
 * The groups the Worker mounts; `/v1/executors/connect` is answered before the router, since it upgrades. The log and
 * artifact reads pass the link surface's gate like every other route (FD-IFC-017).
 */
export const router = mount(
  wellKnownGroup,
  dispatchGroup,
  intakeGroup,
  executionsGroup,
  opsGroup,
  executorsGroup,
  logsGroup(LogsHandlers),
  artifactsGroup(ArtifactsHandlers),
);

const handler = toFetchHandler(router, { shared: JwksSourceLive });

/** The posture of a device enrolled with no posture source: a single operator's own workstation. */
const POSTURE_TIER = "unmanaged" as const;

/** mameko offers no cancel of an admitted execution, so cancel answers `unavailable` (FD-IFC-046). */
const cancellationDeferred = Layer.succeed(Cancellation)({
  cancel: () =>
    Effect.fail(apiError("unavailable", "cancel needs mameko's cancel of an admitted execution")),
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

const requestServices = (env: ControlPlaneEnv, isolate: Context.Context<IsolateServices>) =>
  Layer.mergeAll(
    intakePort.pipe(Layer.provide(Layer.succeedContext(isolate))),
    d1Executions(env.DB),
    d1DeviceRegistry({
      db: env.DB,
      anchor: env.EPOCH_ANCHOR.get(env.EPOCH_ANCHOR.idFromName("control-plane")),
      profile: profileOf(env),
      posture: () => Effect.succeed(POSTURE_TIER),
      verify: undefined,
    }),
    oidcKeyFromSecret(apiEnvOf(env).OIDC_SIGNING_JWK),
    cancellationDeferred,
    failureSummaries(env),
    operations(env),
    cacheReads(env),
  );

/** One request through the router, with the isolate's services and the ones its routes read. */
export const apiFetch = async (request: Request, env: ControlPlaneEnv): Promise<Response> => {
  const config = apiConfigFromEnv(apiEnvOf(env), new URL(request.url).origin);
  if (config instanceof ConfigInvalid)
    return Response.json(
      errorBody(apiError("misconfigured", config.message), crypto.randomUUID()),
      { status: 503 },
    );
  const isolate = await isolateServices(env);
  const services = await Effect.runPromise(
    Layer.build(requestServices(env, isolate)).pipe(Effect.scoped),
  );
  return handler.fetch(
    request,
    Context.merge(isolate, services).pipe(Context.add(ApiConfig, config)) as never,
  );
};
