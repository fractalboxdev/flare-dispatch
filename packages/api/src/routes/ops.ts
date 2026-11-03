// `/v1/ops/*`: each route surfaces one of mameko's operator operations, passing the operator's Access identity, the
// reason and the request id through to the coordinator's audit row (FD-IFC-083, FD-OPS-077). The surface admits only
// identities in `operators` (FD-IFC-016).
import { Effect, Match } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { FlareDispatchApi } from "../declaration.ts";
import { apiError } from "../errors.ts";
import { CurrentIdentity } from "../identity.ts";
import { Operations, type OperationTarget, type OperatorOperation } from "../ports.ts";
import { RequestId } from "../request-id.ts";

const targetOf = (
  body: { readonly executor: string } | { readonly repository: string },
): OperationTarget =>
  "executor" in body
    ? { _tag: "executor", id: body.executor }
    : { _tag: "repository", id: body.repository };

/** Runs one operation as the current operator, and answers what the audit row recorded. */
export const operate = (operation: OperatorOperation, reason: string) =>
  Effect.gen(function* () {
    const identity = yield* CurrentIdentity;
    const requestId = yield* RequestId;
    const operator = yield* Match.value(identity).pipe(
      Match.tag("Access", ({ id }) => Effect.succeed(id)),
      Match.orElse(() =>
        Effect.fail(apiError("forbidden", "operator routes need an Access identity")),
      ),
    );
    const operations = yield* Operations;
    const now = Date.now();
    const { target } = yield* operations.apply(operation, {
      identity: operator,
      requestId,
      reason,
      now,
    });
    return { operation: operation._tag, target, request_id: requestId, at: now };
  });

export const OpsHandlers = HttpApiBuilder.group(FlareDispatchApi, "ops", (handlers) =>
  handlers
    .handle("halt", ({ payload }) =>
      operate({ _tag: "halt", state: payload.state }, payload.reason),
    )
    .handle("quarantine", ({ payload }) =>
      operate({ _tag: "quarantine", target: targetOf(payload) }, payload.reason),
    )
    .handle("release", ({ payload }) =>
      operate({ _tag: "release", target: targetOf(payload) }, payload.reason),
    )
    .handle("forceAdmit", ({ payload }) =>
      operate(
        { _tag: "force-admit", executionId: payload.execution_id, expiresAt: payload.expires_at },
        payload.reason,
      ),
    )
    .handle("topUp", ({ payload }) =>
      operate(
        { _tag: "top-up", amountMicroUsd: payload.amount_micro_usd, expiresAt: payload.expires_at },
        payload.reason,
      ),
    )
    .handle("drain", ({ payload }) =>
      operate({ _tag: "drain", executor: payload.executor }, payload.reason),
    )
    .handle("revoke", ({ payload }) =>
      operate({ _tag: "revoke", executor: payload.executor }, payload.reason),
    )
    .handle("pauseKey", ({ payload }) =>
      operate({ _tag: "pause", installation: payload.installation }, payload.reason),
    )
    .handle("resumeKey", ({ payload }) =>
      operate({ _tag: "resume", installation: payload.installation }, payload.reason),
    )
    .handle("health", () => Effect.flatMap(Operations, (ops) => ops.health)),
);
