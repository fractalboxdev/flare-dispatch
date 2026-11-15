// The deploy claim of `worker-deploy` (FD-GATE-067): the record that an execution's deploy command started, held by the
// control plane because a Container's file system does not outlive a reclaim. `POST /v1/deploy-claims/<execution id>`
// writes one `deploy_claims` row per execution; the first claim of an execution answers `{ "claimed": true }` and every
// later claim, from any epoch, answers `{ "claimed": false }`, so the run records `infra: DeployAlreadyStarted`.
//
// The route accepts only a deploy-claim token the control plane minted for the execution at its current epoch:
//
//   token   = "dc1." base64url(payload) "." base64url(mac)
//   payload = canonical JSON { execution_id, epoch, exp }
//   mac     = HMAC-SHA256(k_dc, "dc1\n" base64url(payload))
//   k_dc    = HKDF-SHA256(DEPLOY_CLAIM_SECRET, info = "flare-dispatch/deploy-claim/v1")
//
// `exp` is the execution's `deadline_at`. The token reaches the run in the lease's input (`WorkerDeployInput`'s
// `deployClaim`): the run payload the device executor builds for the runner child carries the lease's fixed fields and
// its input and no other lease field, and the run body receives the input alone.
import {
  apiError,
  errorBody,
  statusOfError,
  type ErrorCode,
} from "@fractalboxdev/flare-dispatch-api";
import {
  DEPLOY_CLAIM_ROUTE,
  type CatalogEntry,
  type DeployClaimGrant,
} from "@fractalboxdev/flare-dispatch-catalog";
import type { D1Like } from "@fractalboxdev/mameko-host-cloudflare/d1";
import {
  bearerOf,
  signLeaseToken,
  verifyLeaseToken,
  type LeaseTokenRefusal,
  type LeaseTokenScope,
} from "./lease-token.ts";

export const DEPLOY_CLAIM_TOKEN_LABEL = "flare-dispatch/deploy-claim/v1";
const DEPLOY_CLAIM_TOKEN = { version: "dc1", label: DEPLOY_CLAIM_TOKEN_LABEL } as const;

/** The bindings the deploy claim reads. */
export interface DeployClaimEnv {
  readonly DB: D1Like;
  /** The Worker secret deploy-claim tokens derive from, distinct from every other key; unset, no lease carries one. */
  readonly DEPLOY_CLAIM_SECRET?: string;
  /** The dispatcher's public origin, which a lease's deploy-claim URL names. */
  readonly PUBLIC_ORIGIN?: string;
}

/** What a deploy-claim token binds: one execution at one epoch, until an expiry. */
export type DeployClaimScope = LeaseTokenScope;

export const signDeployClaimToken = (secret: string, scope: DeployClaimScope): Promise<string> =>
  signLeaseToken(DEPLOY_CLAIM_TOKEN, secret, scope);

export type DeployClaimRefusal = LeaseTokenRefusal;

/** Verifies `presented` for the execution the request path names, at `nowMs`. */
export const verifyDeployClaimToken = (
  secret: string,
  executionId: string,
  presented: string | null,
  nowMs: number,
) => verifyLeaseToken(DEPLOY_CLAIM_TOKEN, secret, presented, nowMs, executionId);

/** One row per execution whose deploy command was claimed, with the epoch that claimed it. */
export const DEPLOY_CLAIM_SCHEMA = [
  `create table if not exists deploy_claims (
    execution_id text primary key,
    epoch integer not null,
    claimed_at integer not null)`,
];

const migrated = new WeakMap<D1Like, Promise<unknown>>();

/** Creates the deploy-claim table once per database handle. */
export const migrateDeployClaims = (db: D1Like): Promise<unknown> => {
  const existing = migrated.get(db);
  if (existing !== undefined) return existing;
  const run = (async () => {
    for (const sql of DEPLOY_CLAIM_SCHEMA) await db.prepare(sql).run();
  })().catch((e: unknown) => {
    migrated.delete(db);
    throw e;
  });
  migrated.set(db, run);
  return run;
};

/** The dispatcher's public origin without a trailing slash, or undefined where the deploy names none. */
const publicOriginOf = (env: Pick<DeployClaimEnv, "PUBLIC_ORIGIN">): string | undefined => {
  const origin = env.PUBLIC_ORIGIN?.trim().replace(/\/+$/, "");
  return origin === undefined || origin === "" ? undefined : origin;
};

/** The dispatcher's hostname, which the `deploy-claim` grant covers, or undefined where the deploy names no origin. */
export const deployClaimHost = (env: Pick<DeployClaimEnv, "PUBLIC_ORIGIN">): string | undefined => {
  const origin = publicOriginOf(env);
  if (origin === undefined) return undefined;
  try {
    return new URL(origin).hostname;
  } catch {
    return undefined;
  }
};

/**
 * A lease's deploy claim: the route for the execution and a token bound to it at the lease's epoch, expiring at
 * `deadline_at`. None for a run other than `worker-deploy`, or on a deploy without the secret or a public origin.
 */
export const leaseDeployClaim = async (
  env: Pick<DeployClaimEnv, "DEPLOY_CLAIM_SECRET" | "PUBLIC_ORIGIN">,
  entry: Pick<CatalogEntry, "spec"> | null,
  lease: DeployClaimScope,
): Promise<DeployClaimGrant | null> => {
  const origin = publicOriginOf(env);
  const secret = env.DEPLOY_CLAIM_SECRET;
  if (entry?.spec.name !== "worker-deploy" || origin === undefined) return null;
  if (secret === undefined || secret === "") return null;
  return {
    url: `${origin}${DEPLOY_CLAIM_ROUTE}${encodeURIComponent(lease.executionId)}`,
    token: await signDeployClaimToken(secret, lease),
  };
};

/**
 * A `worker-deploy` lease's input: the recorded input without any `deployClaim` it carries, with the lease's own where
 * the control plane mints one. Any other run's input is unchanged.
 */
export const withDeployClaim = (
  entry: Pick<CatalogEntry, "spec"> | null,
  inputs: unknown,
  claim: DeployClaimGrant | null,
): unknown => {
  if (entry?.spec.name !== "worker-deploy" || !isRecord(inputs)) return inputs;
  const { deployClaim: _recorded, ...rest } = inputs;
  return claim === null ? rest : { ...rest, deployClaim: claim };
};

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** A refusal in the error model's shape (FD-IFC-009). */
const refuse = (code: ErrorCode, message: string) => {
  const error = apiError(code, message);
  return Response.json(errorBody(error, crypto.randomUUID()), { status: statusOfError(error) });
};

const executionOf = async (db: D1Like, executionId: string) =>
  (
    await db
      .prepare(
        `select e.status, p.epoch from mameko_executions e left join mameko_placements p on p.execution_id = e.id
         where e.id = ?`,
      )
      .bind(executionId)
      .all()
  ).results[0] as { readonly status: string; readonly epoch: number | null } | undefined;

/**
 * Serves `POST /v1/deploy-claims/<execution id>`, or answers null for a path this route does not serve. A request
 * without a valid token for the path's execution is `401`; a token for another execution, for an epoch other than the
 * execution's current one, or for an execution that has ended is `403` and claims nothing.
 */
export const deployClaimFetch = async (
  request: Request,
  env: DeployClaimEnv,
  now: number = Date.now(),
): Promise<Response | null> => {
  const { pathname } = new URL(request.url);
  if (!pathname.startsWith(DEPLOY_CLAIM_ROUTE)) return null;
  const segment = pathname.slice(DEPLOY_CLAIM_ROUTE.length);
  if (segment === "" || segment.includes("/")) return refuse("not_found", "no such route");
  if (request.method !== "POST")
    return refuse("method_not_allowed", "the deploy-claim route takes POST");
  const secret = env.DEPLOY_CLAIM_SECRET;
  if (secret === undefined || secret === "")
    return refuse("unavailable", "this deploy holds no deploy-claim secret");
  const executionId = decodeURIComponent(segment);
  const verdict = await verifyDeployClaimToken(secret, executionId, bearerOf(request), now);
  if (!verdict.ok)
    return verdict.reason === "other-execution"
      ? refuse("forbidden", "token other-execution")
      : refuse("unauthenticated", `token ${verdict.reason}`);
  const execution = await executionOf(env.DB, executionId);
  if (execution === undefined || execution.epoch !== verdict.scope.epoch)
    return refuse("forbidden", "token epoch is not current");
  if (execution.status !== "pending" && execution.status !== "running")
    return refuse("forbidden", "execution is terminal");
  await migrateDeployClaims(env.DB);
  const { results } = await env.DB.prepare(
    `insert into deploy_claims (execution_id, epoch, claimed_at) values (?, ?, ?)
     on conflict (execution_id) do nothing returning execution_id`,
  )
    .bind(executionId, verdict.scope.epoch, now)
    .all();
  return Response.json({ claimed: results.length === 1 });
};
