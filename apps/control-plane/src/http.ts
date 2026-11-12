// The HTTP API: `packages/api`'s router of mountable groups, with intake's webhook route under `/v1/`, and the services
// each request reads, built from the Worker's bindings. `POST /v1/dispatch/:run` is the declaration's dispatch group
// over intake's admission (FD-IFC-001). A port this deploy cannot back answers `unavailable` naming what it lacks.
import {
  ApiConfig,
  apiConfigFromEnv,
  apiError,
  appleAttestationVerifier,
  artifactsGroup,
  ConfigInvalid,
  d1DeviceRegistry,
  d1Executions,
  dispatchGroup,
  errorBody,
  executionsGroup,
  executorsGroup,
  JwksSourceLive,
  logsGroup,
  mcpGroup,
  mount,
  operabilityGroup,
  oidcKeyFromSecret,
  Operations,
  opsGroup,
  provenancePolicies,
  provenancePolicyGroup,
  provenanceStatements,
  RequestId,
  routerGroup,
  toFetchHandler,
  wellKnownGroup,
} from "@fractalboxdev/flare-dispatch-api";
import {
  d1LogAppendStore,
  LogAppendFailed,
  LogAppendStore,
  parseProvenanceKey,
  PRIVATE_LOG_NAME,
  privateLogAppend,
} from "@fractalboxdev/flare-dispatch-cache";
import {
  d1KeyHistoryStore,
  d1PolicyStore,
  KeyHistoryStore,
  PolicyStore,
  PolicyTransparencyLog,
} from "@fractalboxdev/flare-dispatch-cache/provenance-policy";
import { handleIntake, WEBHOOK_MAX_BYTES } from "@fractalboxdev/flare-dispatch-intake";
import {
  livenessReport,
  OperabilityHandlers,
  OpsStore,
  runOpsMigrations,
} from "@fractalboxdev/flare-dispatch-ops";
import { Context, Effect, Layer } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { ArtifactsHandlers, cacheReads, LogsHandlers } from "./cache.ts";
import { isolateServices, type IsolateServices } from "./composition.ts";
import { apiEnvOf, deployment, profileOf, type ControlPlaneEnv } from "./config.ts";
import { failureSummaries } from "./failure-summary.ts";
import { intakeCancellation, intakePort } from "./intake-port.ts";
import { spendViewOf } from "./spend.ts";

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
 * artifact reads pass the link surface's gate like every other route (FD-IFC-017); the fleet view, the phase gate's
 * records, the spend view and the install flow pass the operability group's gates. The MCP server at `/mcp` reads the
 * same per-request ports as the routes its tools wrap, so its `dispatch` reaches intake's admission through the
 * declared dispatch route's `Intake` port, as trigger `mcp` (FD-IFC-072, FD-IFC-074, FD-INT-062).
 */
export const router = mount(
  wellKnownGroup,
  dispatchGroup,
  intakeGroup,
  executionsGroup,
  opsGroup,
  operabilityGroup(OperabilityHandlers),
  executorsGroup,
  provenancePolicyGroup,
  logsGroup(LogsHandlers),
  artifactsGroup(ArtifactsHandlers),
  mcpGroup,
);

const handler = toFetchHandler(router, { shared: JwksSourceLive });

/** The posture of a device enrolled with no posture source: a single operator's own workstation. */
const POSTURE_TIER = "unmanaged" as const;

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

/**
 * The verification policy's versions in D1, the control plane's key history beside them, and the private log the
 * `TransparencyLog` object writes, which every version is appended to before it is served (FD-PROV-046). A deploy with
 * no `TRANSPARENCY_LOG` binding fails each publish, and serves nothing it has not logged.
 */
const policies = (env: ControlPlaneEnv) => {
  const db = env.DB as unknown as D1Database;
  const api = apiEnvOf(env);
  const ns = env.TRANSPARENCY_LOG;
  return provenancePolicies({
    provenance: parseProvenanceKey(api.PROVENANCE_KEY),
    log: parseProvenanceKey(api.LOG_KEY),
  }).pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(PolicyStore)(d1PolicyStore(db)),
        Layer.succeed(KeyHistoryStore)(d1KeyHistoryStore(db)),
        Layer.succeed(PolicyTransparencyLog)({
          append:
            ns === undefined
              ? () =>
                  Effect.fail(
                    new LogAppendFailed({
                      log: "private",
                      message: "this deploy binds no TRANSPARENCY_LOG object",
                    }),
                  )
              : privateLogAppend(ns.get(ns.idFromName(PRIVATE_LOG_NAME))),
        }),
      ),
    ),
  );
};

/**
 * The statement lookups' port over the log-append intents in D1 and the private log's `TransparencyLog` object, which
 * `provenanceGroup`'s routes read (FD-PROV-071). A deploy with no `TRANSPARENCY_LOG` binding answers each inclusion
 * proof `unavailable`.
 */
const statements = (env: ControlPlaneEnv) => {
  const ns = env.TRANSPARENCY_LOG;
  return provenanceStatements(
    ns === undefined ? undefined : ns.get(ns.idFromName(PRIVATE_LOG_NAME)),
  ).pipe(
    Layer.provide(
      Layer.succeed(LogAppendStore)(d1LogAppendStore(env.DB as unknown as D1Database)),
    ),
  );
};

const requestServices = (env: ControlPlaneEnv, isolate: Context.Context<IsolateServices>) =>
  Layer.mergeAll(
    Layer.merge(intakePort, intakeCancellation).pipe(Layer.provide(Layer.succeedContext(isolate))),
    d1Executions(env.DB),
    d1DeviceRegistry({
      db: env.DB,
      anchor: env.EPOCH_ANCHOR.get(env.EPOCH_ANCHOR.idFromName("control-plane")),
      profile: profileOf(env),
      posture: () => Effect.succeed(POSTURE_TIER),
      // Managed Device Attestation rooted at the Apple Enterprise Attestation Root CA (FD-PROV-028); a `development`
      // deployment supplies none.
      verify: deployment(env) === "production" ? appleAttestationVerifier : undefined,
    }),
    oidcKeyFromSecret(apiEnvOf(env).OIDC_SIGNING_JWK),
    failureSummaries(env),
    operations(env),
    cacheReads(env),
    Layer.succeed(OpsStore)({ db: env.DB, now: Date.now }),
    spendViewOf(env),
    policies(env),
    statements(env),
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
