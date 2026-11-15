// The control plane's model route, `POST /v1/model/completions` (specs/interfaces.md § Surfaces and their identity
// gates, specs/model-gateway.md): one `ModelCompletionRequest` of an execution through the model gateway.
//
// - The route accepts only a model-lease token the control plane minted for the execution at its current epoch,
//   expiring at its `deadline_at`, under the `MODEL_LEASE_SECRET` Worker secret (`lease-token.ts`). It checks the token
//   before it reads the body (MAMEKO-MDL-041), and a token for an epoch that is not the execution's current one, for
//   an execution that has ended, or for a lease whose credentials were revoked is `lease_stale` (MAMEKO-MDL-040,
//   MAMEKO-ISO-054). A lease's end revokes its token at once (MAMEKO-ISO-053, MAMEKO-HOST-052).
// - The token is minted into the lease's `credentials` under the grant name `model-gateway`, the credential the egress
//   proxy attaches to a request to this route (FD-AGT-010); the run's input holds none. A Container pool's controller
//   mints it for each launch as the `model-gateway` grant's credential, which the Container's outbound handler sends as
//   the request's `authorization` (MAMEKO-ISO-052, MAMEKO-HOST-050).
// - A call routes by the repository's confidentiality mode: a scope that is not `non-confidential` reaches no hosted
//   model (MAMEKO-MDL-008), so the call is `model_route_refused`. A hosted call goes to the first entry of the provider
//   registry that serves its tier on a route kind this deploy holds: `workers-ai` through the `AI` binding (FD-MDL-020).
// - Spend: the gateway reserves the call maximum against the execution's model allowance in `model_calls` before the
//   upstream request and settles at the provider-reported cost (MAMEKO-MDL-025 to MAMEKO-MDL-028), pricing a
//   `workers-ai` entry only at its stated rate (FD-MDL-021). The model-call record goes to the Worker log with no
//   prompt, completion or credential (MAMEKO-MDL-072, MAMEKO-MDL-024).
import {
  apiError,
  errorBody,
  statusOfError,
  type ErrorCode,
} from "@fractalboxdev/flare-dispatch-api";
import {
  FD_ROUTE_KINDS,
  sendFdHostedCall,
  Tier,
  workersAiRoute,
  type FdRouteKind,
  type WorkersAiBinding,
} from "@fractalboxdev/flare-dispatch-agentic";
import {
  lookupRun,
  MODEL_GATEWAY_PATH,
  type CatalogEntry,
} from "@fractalboxdev/flare-dispatch-catalog";
import { routeModelCall } from "@fractalboxdev/mameko-kernel";
import { d1AllowanceStore, type D1Like } from "@fractalboxdev/mameko-host-cloudflare/d1";
import { AllowanceStore } from "@fractalboxdev/mameko-ports";
import { Effect, Match, Option, Schema } from "effect";
import { MODEL_COMPLETIONS_PATH } from "./cloud-lease.ts";
import { deployment } from "./config.ts";
import { repositoryConfidentiality, type ConfidentialityEnv } from "./dev-repository.ts";
import { bearerOf, signLeaseToken, verifyLeaseToken, type LeaseTokenScope } from "./lease-token.ts";

/** The largest model request the route reads, and the `model-gateway` grant passes. */
export const MODEL_REQUEST_MAX_BYTES = 4 * 1024 * 1024;

/** The lease credential's name: the grant whose requests the egress proxy attaches it to. */
export const MODEL_LEASE_CREDENTIAL = "model-gateway";

export const MODEL_LEASE_TOKEN_LABEL = "flare-dispatch/model-lease/v1";
const MODEL_LEASE_TOKEN = { version: "ml1", label: MODEL_LEASE_TOKEN_LABEL } as const;

/** The bindings the model route reads. */
export interface ModelGatewayEnv extends ConfidentialityEnv {
  readonly DB: D1Like;
  /** The Worker secret model-lease tokens derive from, distinct from every other key; unset, no lease carries one. */
  readonly MODEL_LEASE_SECRET?: string;
  /** The Workers AI binding, the `workers-ai` route's only credential. */
  readonly AI?: WorkersAiBinding;
  /** The rendered `{{models.registry}}`: the provider registry, keyed by model entry id. */
  readonly MODEL_REGISTRY?: unknown;
  /** The rendered `{{models.fallbackPriceUsdPerMTok}}`, 75 where the overlay sets none (MAMEKO-MDL-022). */
  readonly MODEL_FALLBACK_PRICE_USD_PER_MTOK?: unknown;
}

export const signModelLeaseToken = (secret: string, scope: LeaseTokenScope): Promise<string> =>
  signLeaseToken(MODEL_LEASE_TOKEN, secret, scope);

/**
 * A lease's model credential: a model-lease token bound to the execution at the lease's epoch, expiring at
 * `deadline_at`, under the grant name the egress proxy attaches it for. None for a run that calls no model, or on a
 * deploy without the secret.
 */
export const leaseModelCredentials = async (
  env: Pick<ModelGatewayEnv, "MODEL_LEASE_SECRET">,
  entry: Pick<CatalogEntry, "agentic"> | null,
  lease: LeaseTokenScope,
): Promise<Readonly<Record<string, string>>> => {
  const secret = env.MODEL_LEASE_SECRET;
  if (entry?.agentic?.declaration.needsModel !== true || secret === undefined || secret === "")
    return {};
  return { [MODEL_LEASE_CREDENTIAL]: await signModelLeaseToken(secret, lease) };
};

/**
 * The `model-gateway` grant's credential for one Container launch: the lease's model-lease token as a bearer
 * credential, expiring at the lease's `deadline_at` (MAMEKO-HOST-050, MAMEKO-HOST-051). A deploy without the secret
 * names no minted grant, so the controller never asks it for one.
 */
export const mintModelLeaseCredential = async (
  env: Pick<ModelGatewayEnv, "MODEL_LEASE_SECRET">,
  lease: LeaseTokenScope,
): Promise<{ readonly credential: string; readonly expiresAt: number }> => {
  const secret = env.MODEL_LEASE_SECRET;
  if (secret === undefined || secret === "")
    throw new Error("model-gateway: this deploy holds no model-lease secret");
  return {
    credential: `Bearer ${await signModelLeaseToken(secret, lease)}`,
    expiresAt: lease.expiresAt,
  };
};

/** The leases whose model-lease tokens are revoked: one row per execution and epoch, kept while the token can live. */
const REVOCATION_SCHEMA = [
  `create table if not exists fd_model_lease_revocations (
    execution_id text not null,
    epoch integer not null,
    revoked_at integer not null,
    primary key (execution_id, epoch))`,
] as const;

const revocationsMigrated = new WeakMap<object, Promise<unknown>>();

const migrateRevocations = (db: D1Like): Promise<unknown> => {
  const existing = revocationsMigrated.get(db);
  if (existing !== undefined) return existing;
  const run = (async () => {
    for (const sql of REVOCATION_SCHEMA) await db.prepare(sql).run();
  })().catch((e: unknown) => {
    revocationsMigrated.delete(db);
    throw e;
  });
  revocationsMigrated.set(db, run);
  return run;
};

/**
 * Revokes the model-lease token of the execution's lease at `epoch` as the lease ends (MAMEKO-ISO-053,
 * MAMEKO-HOST-052): the route answers that token `lease_stale` from then on, whatever the placement row says.
 */
export const revokeModelLease = async (
  db: D1Like,
  executionId: string,
  epoch: number,
  now: number,
): Promise<void> => {
  await migrateRevocations(db);
  await db
    .prepare(
      `insert into fd_model_lease_revocations (execution_id, epoch, revoked_at) values (?, ?, ?)
       on conflict (execution_id, epoch) do nothing`,
    )
    .bind(executionId, epoch, now)
    .run();
};

const revoked = async (db: D1Like, executionId: string, epoch: number): Promise<boolean> => {
  await migrateRevocations(db);
  const { results } = await db
    .prepare(
      "select 1 as revoked from fd_model_lease_revocations where execution_id = ? and epoch = ?",
    )
    .bind(executionId, epoch)
    .all();
  return results.length > 0;
};

/** One provider registry entry as the `MODEL_REGISTRY` var carries it (MAMEKO-MDL-020). */
const RegistryEntry = Schema.Struct({
  providerId: Schema.NonEmptyString,
  routeKind: Schema.NonEmptyString,
  serves: Schema.Array(Tier).check(Schema.isMinLength(1)),
  upstreamModel: Schema.NonEmptyString,
  inputPriceMicroUsdPerMTok: Schema.optionalKey(Schema.Number),
  outputPriceMicroUsdPerMTok: Schema.optionalKey(Schema.Number),
});
const decodeRegistry = Schema.decodeUnknownOption(Schema.Record(Schema.String, RegistryEntry));

/** A var as the Worker receives it: rendered as its JSON value, or hand-set as JSON text. */
const varValue = (raw: unknown): unknown => {
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
};

/** The provider registry in entry order; none where the var is unset or does not decode. */
const registryOf = (env: Pick<ModelGatewayEnv, "MODEL_REGISTRY">) =>
  Option.match(decodeRegistry(varValue(env.MODEL_REGISTRY) ?? {}), {
    onNone: () => [],
    onSome: (entries) => Object.entries(entries).map(([id, e]) => ({ id, ...e })),
  });

const fallbackPriceOf = (env: Pick<ModelGatewayEnv, "MODEL_FALLBACK_PRICE_USD_PER_MTOK">) => {
  const value = varValue(env.MODEL_FALLBACK_PRICE_USD_PER_MTOK);
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
};

/** The registered route kinds this deploy holds a route for: `workers-ai` with the `AI` binding. */
const routesOf = (
  env: Pick<ModelGatewayEnv, "AI">,
): Partial<Record<FdRouteKind, ReturnType<typeof workersAiRoute>>> =>
  env.AI === undefined ? {} : { "workers-ai": workersAiRoute(env.AI) };

const isRouteKind = (kind: string): kind is FdRouteKind =>
  (FD_ROUTE_KINDS as readonly string[]).includes(kind);

/** The request body a job's model client sends. */
const CompletionRequest = Schema.Struct({
  call_site: Schema.String,
  tier: Tier,
  messages: Schema.Array(
    Schema.Struct({
      role: Schema.Literals(["system", "user", "assistant"]),
      content: Schema.String,
    }),
  ).check(Schema.isMinLength(1)),
  max_tokens: Schema.optionalKey(Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0))),
});
const decodeRequest = Schema.decodeUnknownOption(CompletionRequest);

/** A refusal in the error model's shape (FD-IFC-009). */
const refuse = (code: ErrorCode, message: string) => {
  const error = apiError(code, message);
  return Response.json(errorBody(error, crypto.randomUUID()), { status: statusOfError(error) });
};

const executionOf = async (db: D1Like, executionId: string) =>
  (
    await db
      .prepare(
        `select e.status, e.run, e.scope_id, p.epoch from mameko_executions e
         left join mameko_placements p on p.execution_id = e.id where e.id = ?`,
      )
      .bind(executionId)
      .all()
  ).results[0] as
    | {
        readonly status: string;
        readonly run: string;
        readonly scope_id: string;
        readonly epoch: number | null;
      }
    | undefined;

/** The execution's model allowance in micro-USD, from its run's `limits.modelAllowanceUsd`; 0 for none. */
const allowanceOf = (env: Pick<ModelGatewayEnv, "DEPLOYMENT">, run: string): number =>
  Match.value(lookupRun(deployment(env), run)).pipe(
    Match.tag("Available", ({ entry }) =>
      Math.round((entry.spec.limits.modelAllowanceUsd ?? 0) * 1_000_000),
    ),
    Match.orElse(() => 0),
  );

/** The answer to a failed hosted call: the gateway's reason as the error model's code. */
const failedCall = (reason: string) =>
  reason.startsWith("rate-limited")
    ? refuse("rate_limited", reason)
    : reason.startsWith("context-overflow")
      ? refuse("model_request_invalid", reason)
      : refuse("unavailable", reason);

/**
 * Serves `POST /v1/model/completions`, or answers null for a path outside the model route. A request without a valid
 * model-lease token is `401` before its body is read; a token whose epoch is not the execution's current one, whose
 * execution has ended, or whose lease's credentials were revoked is `401 lease_stale`.
 */
export const modelGatewayFetch = async (
  request: Request,
  env: ModelGatewayEnv,
  now: number = Date.now(),
): Promise<Response | null> => {
  const { pathname } = new URL(request.url);
  if (!pathname.startsWith(MODEL_GATEWAY_PATH)) return null;
  if (pathname !== MODEL_COMPLETIONS_PATH) return refuse("not_found", "no such route");
  if (request.method !== "POST") return refuse("method_not_allowed", "the model route takes POST");
  const secret = env.MODEL_LEASE_SECRET;
  if (secret === undefined || secret === "")
    return refuse("unavailable", "this deploy holds no model-lease secret");
  const verdict = await verifyLeaseToken(MODEL_LEASE_TOKEN, secret, bearerOf(request), now);
  if (!verdict.ok) return refuse("unauthenticated", `token ${verdict.reason}`);
  const { executionId, epoch } = verdict.scope;
  const execution = await executionOf(env.DB, executionId);
  if (execution === undefined || execution.epoch !== epoch)
    return refuse("lease_stale", "token epoch is not current");
  if (execution.status !== "pending" && execution.status !== "running")
    return refuse("lease_stale", "execution is terminal");
  if (await revoked(env.DB, executionId, epoch)) return refuse("lease_stale", "token revoked");

  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > MODEL_REQUEST_MAX_BYTES)
    return refuse(
      "payload_too_large",
      `the model route reads at most ${MODEL_REQUEST_MAX_BYTES} bytes`,
    );
  const text = await request.text();
  if (new TextEncoder().encode(text).length > MODEL_REQUEST_MAX_BYTES)
    return refuse(
      "payload_too_large",
      `the model route reads at most ${MODEL_REQUEST_MAX_BYTES} bytes`,
    );
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return refuse("model_request_invalid", "the body is not JSON");
  }
  const decoded = decodeRequest(json);
  if (Option.isNone(decoded))
    return refuse("model_request_invalid", "the body is not a ModelCompletionRequest");
  const call = decoded.value;

  const mode = repositoryConfidentiality(env)(execution.scope_id);
  const route = routeModelCall({ mode, tier: call.tier, location: { kind: "cloud" } });
  if (route._tag !== "Hosted")
    return refuse("model_route_refused", `a ${mode} repository reaches no hosted model`);
  const routes = routesOf(env);
  const entry = registryOf(env).find(
    (e) =>
      e.serves.includes(call.tier) && isRouteKind(e.routeKind) && routes[e.routeKind] !== undefined,
  );
  if (entry === undefined)
    return refuse("unavailable", `no model entry this deploy routes serves ${call.tier}`);
  const fallback = fallbackPriceOf(env);

  return Effect.runPromise(
    Effect.gen(function* () {
      const allowance = yield* AllowanceStore;
      const { body, record } = yield* sendFdHostedCall({
        allowance,
        route: routes[entry.routeKind as FdRouteKind]!,
        entry: { ...entry, providerPath: "" },
        tier: call.tier,
        request: {
          messages: call.messages,
          ...(call.max_tokens === undefined ? {} : { maxTokens: call.max_tokens }),
        },
        executionId,
        allowanceMicroUsd: allowanceOf(env, execution.run),
        epoch,
        callId: crypto.randomUUID(),
        ...(fallback === undefined ? {} : { fallbackPriceUsdPerMTok: fallback }),
      });
      yield* Effect.logInfo("model call", { ...record, callSite: call.call_site });
      return Response.json(body);
    }).pipe(
      Effect.catchTags({
        AllowanceExhausted: () =>
          Effect.succeed(refuse("allowance_exhausted", "the execution's model allowance is spent")),
        ModelRequestInvalid: (e) => Effect.succeed(refuse("model_request_invalid", e.reason)),
        ModelCallFailed: (e) => Effect.succeed(failedCall(e.reason)),
      }),
      Effect.provide(d1AllowanceStore(env.DB)),
    ),
  );
};
