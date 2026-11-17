// A Container lease's read of the control plane (specs/interfaces.md FD-IFC-102, FD-IFC-103): `ci-triage-pr` reads its
// repository's failed executions from `GET /v1/executions` and their logs from `GET /v1/logs/:id` in its
// `agent` phase, where no Access identity exists.
//
// - The control plane mints a control-plane read token (`lease-token.ts`) for the execution at the lease's epoch,
//   expiring at its `deadline_at`, under the `CONTROL_PLANE_READ_SECRET` Worker secret, into the lease's `credentials`
//   under the grant name `control-plane-read`, the credential the egress proxy attaches to a request to those routes.
//   The run's input holds none.
// - The router's gate verifies the token: an execution whose epoch is not the token's, that has ended, or whose lease's
//   tokens were revoked is `lease_stale`, so a lease's end revokes the token at once. The token identifies the lease and the
//   execution's repository, and the routes answer it that repository's executions and logs alone. It is a bearer on
//   `GET` routes only; every other route reads no lease token.
import {
  apiError,
  LeaseReadTokens,
  type ApiError,
  type LeaseHolder,
} from "@fractalboxdev/flare-dispatch-api";
import type { CatalogEntry } from "@fractalboxdev/flare-dispatch-catalog";
import type { D1Like } from "@fractalboxdev/mameko-host-cloudflare/d1";
import { Effect, Layer } from "effect";
import {
  leaseTokensRevoked,
  signLeaseToken,
  verifyLeaseToken,
  type LeaseTokenScope,
} from "./lease-token.ts";

/** The lease credential's name: the grant whose requests the egress proxy attaches it to. */
export const CONTROL_PLANE_READ_CREDENTIAL = "control-plane-read";

export const CONTROL_PLANE_READ_TOKEN_LABEL = "flare-dispatch/control-plane-read/v1";
const CONTROL_PLANE_READ_TOKEN = { version: "cr1", label: CONTROL_PLANE_READ_TOKEN_LABEL } as const;

/** The runs whose leases carry a control-plane read token: `ci-triage-pr` reads the executions and their logs. */
export const CONTROL_PLANE_READERS: ReadonlySet<string> = new Set(["ci-triage-pr"]);

/** The bindings the token reads. */
export interface ControlPlaneReadEnv {
  readonly DB: D1Like;
  /** The Worker secret control-plane read tokens derive from, distinct from every other key; unset, none is minted. */
  readonly CONTROL_PLANE_READ_SECRET?: string;
}

export const signControlPlaneReadToken = (
  secret: string,
  scope: LeaseTokenScope,
): Promise<string> => signLeaseToken(CONTROL_PLANE_READ_TOKEN, secret, scope);

/**
 * A lease's control-plane read credential: a token bound to the execution at the lease's epoch, expiring at
 * `deadline_at`, under the grant name the egress proxy attaches it for. None for a run outside `CONTROL_PLANE_READERS`,
 * or on a deploy without the secret.
 */
export const leaseReadCredentials = async (
  env: Pick<ControlPlaneReadEnv, "CONTROL_PLANE_READ_SECRET">,
  entry: Pick<CatalogEntry, "spec"> | null,
  lease: LeaseTokenScope,
): Promise<Readonly<Record<string, string>>> => {
  const secret = env.CONTROL_PLANE_READ_SECRET;
  if (entry === null || !CONTROL_PLANE_READERS.has(entry.spec.name)) return {};
  if (secret === undefined || secret === "") return {};
  return { [CONTROL_PLANE_READ_CREDENTIAL]: await signControlPlaneReadToken(secret, lease) };
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

/**
 * The `control-plane-read` grant's credential for one Container launch: the lease's control-plane read token as a
 * bearer credential, expiring at the lease's `deadline_at` (MAMEKO-HOST-050, MAMEKO-HOST-051). A deploy without the
 * secret names no such minted grant, so the controller never asks it for one.
 */
export const mintControlPlaneReadCredential = async (
  env: Pick<ControlPlaneReadEnv, "CONTROL_PLANE_READ_SECRET">,
  lease: LeaseTokenScope,
): Promise<{ readonly credential: string; readonly expiresAt: number }> => {
  const secret = env.CONTROL_PLANE_READ_SECRET;
  if (secret === undefined || secret === "")
    throw new Error("control-plane-read: this deploy holds no control-plane read secret");
  return {
    credential: `Bearer ${await signControlPlaneReadToken(secret, lease)}`,
    expiresAt: lease.expiresAt,
  };
};

/**
 * Verifies a control-plane read token at `now`: the lease it names, with the execution's repository. A token that does
 * not verify or has passed its `deadline_at` is `unauthenticated`; one whose epoch is not the execution's current one,
 * whose execution has ended or whose lease's tokens were revoked, `lease_stale`; one whose run reads no executions,
 * `forbidden`.
 */
export const verifyControlPlaneRead = (
  env: ControlPlaneReadEnv,
  token: string,
  now: number,
): Effect.Effect<LeaseHolder, ApiError> =>
  Effect.gen(function* () {
    const secret = env.CONTROL_PLANE_READ_SECRET;
    if (secret === undefined || secret === "")
      return yield* apiError("unauthenticated", "this deploy holds no control-plane read secret");
    const verdict = yield* Effect.promise(() =>
      verifyLeaseToken(CONTROL_PLANE_READ_TOKEN, secret, token, now),
    );
    if (!verdict.ok) return yield* apiError("unauthenticated", `token ${verdict.reason}`);
    const { executionId, epoch } = verdict.scope;
    const execution = yield* Effect.tryPromise({
      try: () => executionOf(env.DB, executionId),
      catch: (cause) => apiError("unavailable", `executions: ${String(cause)}`),
    });
    if (execution === undefined || execution.epoch !== epoch)
      return yield* apiError("lease_stale", "token epoch is not current");
    if (execution.status !== "pending" && execution.status !== "running")
      return yield* apiError("lease_stale", "execution is terminal");
    const revoked = yield* Effect.tryPromise({
      try: () => leaseTokensRevoked(env.DB, executionId, epoch),
      catch: (cause) => apiError("unavailable", `revocations: ${String(cause)}`),
    });
    if (revoked) return yield* apiError("lease_stale", "token revoked");
    if (!CONTROL_PLANE_READERS.has(execution.run))
      return yield* apiError("forbidden", `the run ${execution.run} reads no executions`);
    return {
      _tag: "Lease",
      id: `lease:${executionId}`,
      executionId,
      epoch,
      repository: execution.scope_id,
    } satisfies LeaseHolder;
  });

/** The router's verifier of control-plane read tokens over the deploy's D1 database and secret. */
export const leaseReadTokens = (
  env: ControlPlaneReadEnv,
  now: () => number = Date.now,
): Layer.Layer<LeaseReadTokens> =>
  Layer.succeed(LeaseReadTokens)({ verify: (token) => verifyControlPlaneRead(env, token, now()) });
