// `POST /v1/ops/revoke`: mameko's device revoke (MAMEKO-OPS-043 to MAMEKO-OPS-045) through its operator transaction,
// with the audit row FlareDispatch passes through (FD-IFC-083), and the credentials of every lease the device held
// revoked once the revoke changes state (MAMEKO-HOST-052).
import { apiError, type ApiError, type OperatorCall } from "@fractalboxdev/flare-dispatch-api";
import { operate } from "@fractalboxdev/mameko-coordinator";
import { d1OperatorStore, type D1Like } from "@fractalboxdev/mameko-host-cloudflare/d1";
import { Effect } from "effect";
import { revokeLeaseCredentials } from "./lease.ts";

/** The cancel and halt steps a revoke never takes; each answers `unavailable` rather than act. */
const notRevoke = apiError("unavailable", "this deploy applies only the revoke operation");

/**
 * Revokes the device `executorId`: mameko removes its key, quarantines it and requeues each execution it held under
 * the next epoch, in the operator transaction with the audit row; then each held lease's nonce and model-lease token
 * are revoked. A reason outside 1 to 500 characters is `reason_required` (FD-IFC-047); a failed store transaction is
 * `unavailable` with no state changed (FD-IFC-049).
 */
export const revokeDevice = (
  db: D1Like,
  executorId: string,
  call: OperatorCall,
): Effect.Effect<{ readonly target: string }, ApiError> =>
  operate(
    {
      operator: call.identity,
      reason: call.reason,
      requestId: call.requestId,
      operation: { operation: "revoke", executorId },
    },
    call.now,
    {
      cancel: () => Effect.fail(notRevoke),
      haltAll: Effect.fail(notRevoke),
      revokeCredentials: (leases) =>
        Effect.forEach(
          leases,
          (lease) => revokeLeaseCredentials(db, lease.executionId, lease.epoch, call.now),
          { discard: true },
        ),
    },
  ).pipe(
    Effect.provide(d1OperatorStore(db)),
    Effect.map(() => ({ target: `executor:${executorId}` })),
    Effect.catchTags({
      OperatorReasonInvalid: ({ length }) =>
        Effect.fail(apiError("reason_required", `a reason of 1 to 500 characters, not ${length}`)),
      OperatorExpiryInvalid: () => Effect.fail(notRevoke),
      OperatorAmountInvalid: () => Effect.fail(notRevoke),
    }),
    Effect.catchDefect(() =>
      Effect.fail(apiError("unavailable", "the operator transaction failed; nothing changed")),
    ),
  );
