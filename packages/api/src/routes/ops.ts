// `/v1/ops/*`: each route surfaces one of mameko's operator operations, passing the operator's Access identity, the
// reason and the request id through to the coordinator's audit row (FD-IFC-083, FD-OPS-077). The surface admits
// identities in `operators` (FD-IFC-016), and on `halt`, `quarantine`, `pause-key` and `delivery-keys` a `containment`
// identity too (FD-IFC-095), which tightens controls and never releases them (FD-IFC-096 to FD-IFC-098).
import { Effect, Match } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { ApiConfig } from "../config.ts";
import { FlareDispatchApi } from "../declaration.ts";
import { apiError } from "../errors.ts";
import { CurrentIdentity, isContainmentOnly } from "../identity.ts";
import {
  DeliveryKeys,
  Operations,
  type ControlState,
  type OperationTarget,
  type OperatorOperation,
} from "../ports.ts";
import { RequestId } from "../request-id.ts";

/** The delivery key of `job.record` and `verdict.record`, which a pause of every installation leaves flowing. */
export const RECORDS_DELIVERY_KEY = "records";

const targetOf = (
  body: { readonly executor: string } | { readonly repository: string },
): OperationTarget =>
  "executor" in body
    ? { _tag: "executor", id: body.executor }
    : { _tag: "repository", id: body.repository };

/** The Access identity of the caller; operator routes serve no other kind. */
const operatorId = Effect.gen(function* () {
  const identity = yield* CurrentIdentity;
  return yield* Match.value(identity).pipe(
    Match.tag("Access", ({ id }) => Effect.succeed(id)),
    Match.orElse(() =>
      Effect.fail(apiError("forbidden", "operator routes need an Access identity")),
    ),
  );
});

/**
 * Refuses an operation that would release a control when the caller is a `containment` identity: the state `run`
 * (FD-IFC-096), `halt-cloud` while the control state is `halt-all` (FD-IFC-097), and a pause of the `records` key
 * (FD-IFC-098). The `halt-cloud` check reads the control state, and a state it cannot read fails `unavailable`, so a
 * containment caller never loosens `halt-all` on a guessed state.
 */
const containmentRefusal = (operation: OperatorOperation) =>
  Effect.gen(function* () {
    const id = yield* operatorId;
    if (!isContainmentOnly(yield* ApiConfig, id)) return;
    const refuse = (message: string) => Effect.fail(apiError("forbidden", message));
    yield* Match.value(operation).pipe(
      Match.tag("halt", ({ state }) =>
        Match.value<ControlState>(state).pipe(
          Match.when("run", () =>
            refuse("a containment identity cannot set the control state run"),
          ),
          Match.when("halt-cloud", () =>
            Effect.flatMap(Operations, (operations) => operations.controlState).pipe(
              Effect.flatMap((current) =>
                current === "halt-all"
                  ? refuse("a containment identity cannot loosen halt-all to halt-cloud")
                  : Effect.void,
              ),
            ),
          ),
          Match.when("halt-all", () => Effect.void),
          Match.exhaustive,
        ),
      ),
      Match.tag("pause", ({ installation }) =>
        installation === RECORDS_DELIVERY_KEY
          ? refuse("a containment identity cannot pause the records delivery key")
          : Effect.void,
      ),
      Match.orElse(() => Effect.void),
    );
  });

/** Runs one operation as the current operator, and answers what the audit row recorded. */
export const operate = (operation: OperatorOperation, reason: string) =>
  Effect.gen(function* () {
    const operator = yield* operatorId;
    const requestId = yield* RequestId;
    yield* containmentRefusal(operation);
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
    .handle("deliveryKeys", () =>
      Effect.gen(function* () {
        const installations = yield* (yield* DeliveryKeys).list;
        return { installations };
      }),
    )
    .handle("health", () => Effect.flatMap(Operations, (ops) => ops.health)),
);
