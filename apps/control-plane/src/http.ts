// The HTTP API: `packages/api`'s router of mountable groups with intake's routes mounted under `/v1/`, and the services
// each request reads, built from the Worker's bindings. A port this deploy cannot back answers `unavailable` naming
// what it lacks.
import {
  ApiConfig,
  apiConfigFromEnv,
  apiError,
  authenticateAccess,
  Cancellation,
  ConfigInvalid,
  d1DeviceRegistry,
  d1Executions,
  errorBody,
  executionsGroup,
  executorsGroup,
  FailureSummaries,
  JwksSource,
  JwksSourceLive,
  mount,
  oidcKeyFromSecret,
  Operations,
  opsGroup,
  routerGroup,
  toFetchHandler,
  wellKnownGroup,
  type ApiEnv,
} from "@fractalboxdev/flare-dispatch-api";
import {
  AccessIdentity,
  DISPATCH_MAX_BYTES,
  handleIntake,
  WEBHOOK_MAX_BYTES,
} from "@fractalboxdev/flare-dispatch-intake";
import { livenessReport, runOpsMigrations } from "@fractalboxdev/flare-dispatch-ops";
import { Context, Effect, Layer } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { isolateServices } from "./composition.ts";
import { profileOf, type ControlPlaneEnv } from "./config.ts";

/** The Access identity the API's gate verified, as intake's dispatch route asks for it. */
const accessIdentity = Effect.gen(function* () {
  const context = yield* Effect.context<ApiConfig | JwksSource>();
  return AccessIdentity.of({
    identity: (request) =>
      authenticateAccess(request, { redirectBrowser: false }).pipe(
        Effect.map((outcome) => (outcome._tag === "Access" ? outcome.id : null)),
        Effect.orElseSucceed(() => null),
        Effect.provide(context),
      ),
  });
});

/** Intake's routes, below the `/v1/` mount: the request and the path below it, as `handleIntake` takes them. */
const intakeRoute = Effect.gen(function* () {
  const request = (yield* HttpServerRequest.HttpServerRequest).source as Request;
  const path = new URL(request.url).pathname.replace(/^\/v1\//, "");
  const response = yield* handleIntake(request, path).pipe(
    Effect.provideService(AccessIdentity, yield* accessIdentity),
  );
  return HttpServerResponse.fromWeb(
    response ?? Response.json({ error: "not_found", message: "no such route" }, { status: 404 }),
  );
});

/**
 * `POST /v1/webhooks/github` checks its own HMAC (FD-INT-022); `POST /v1/dispatch/:run` passes the gate's dispatch
 * identity check before intake looks up the run (FD-IFC-027).
 */
export const intakeGroup = routerGroup(
  "intake",
  [
    {
      method: "POST",
      path: "/v1/webhooks/github",
      surface: { _tag: "OwnCredential" },
      maxBodyBytes: WEBHOOK_MAX_BYTES,
    },
    {
      method: "POST",
      path: "/v1/dispatch/:run",
      surface: { _tag: "Dispatch" },
      maxBodyBytes: DISPATCH_MAX_BYTES,
    },
  ],
  Layer.mergeAll(
    HttpRouter.add("POST", "/v1/webhooks/github", intakeRoute),
    HttpRouter.add("POST", "/v1/dispatch/:run", intakeRoute),
  ) as never,
);

/** The groups the Worker mounts; `/v1/executors/connect` is answered before the router, since it upgrades. */
export const router = mount(wellKnownGroup, intakeGroup, executionsGroup, opsGroup, executorsGroup);

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

const requestServices = (env: ControlPlaneEnv) =>
  Layer.mergeAll(
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
    failureSummariesDeferred,
    operations(env),
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
  const services = await Effect.runPromise(Layer.build(requestServices(env)).pipe(Effect.scoped));
  return handler.fetch(
    request,
    Context.merge(isolate, services).pipe(Context.add(ApiConfig, config)) as never,
  );
};
