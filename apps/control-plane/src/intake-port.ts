// The HTTP API's `Intake` port over intake's admission. The declared dispatch route authenticates the caller and
// decodes the body (FD-IFC-001); this port hands the submission to intake's `admitDispatch`, and every refusal leaves
// as an error of the error-model table (FD-IFC-009).
import { apiError, isErrorCode, type ApiError } from "@fractalboxdev/flare-dispatch-api/errors";
import {
  Intake,
  type DispatchSubmission,
  type IntakeAnswer,
} from "@fractalboxdev/flare-dispatch-api/ports";
import {
  admitDispatch,
  type AuthenticatedDispatch,
  type IntakeError,
} from "@fractalboxdev/flare-dispatch-intake";
import { Effect, Layer } from "effect";

/** What intake's admission reads: the isolate's intake, GitHub and admission services. */
export type IntakePortServices = Effect.Services<ReturnType<typeof admitDispatch>>;

/** The submission as intake takes it. An Actions identity carries its workflow ref; an Access identity none. */
export const authenticatedOf = (s: DispatchSubmission): AuthenticatedDispatch => ({
  trigger: s.trigger,
  run: s.run,
  repository: s.repository,
  ref: s.ref,
  sha: s.sha,
  label: s.label ?? null,
  inputs: s.inputs,
  signals: s.signals,
  classInput: s.class ?? null,
  caller:
    s.workflowRef === undefined
      ? { kind: "access", id: s.caller }
      : {
          kind: "actions-oidc",
          id: s.caller,
          workflowRef: s.workflowRef,
          ...(s.ref === undefined ? {} : { ref: s.ref }),
        },
  vouchedSha: s.vouchedSha,
  idempotency:
    s.idempotency === undefined
      ? null
      : { key: s.idempotency.key, body: JSON.parse(s.idempotency.canonicalBody) as unknown },
});

/** An intake refusal as the API answers it; a code outside the error-model table answers `internal`. */
export const refusalOf = (e: IntakeError): Effect.Effect<ApiError> =>
  isErrorCode(e.code)
    ? Effect.succeed(
        apiError(
          e.code,
          e.message,
          e.executionId === undefined ? {} : { execution_id: e.executionId },
        ),
      )
    : Effect.as(
        Effect.logError("intake refused with a code outside the error model", {
          code: e.code,
          message: e.message,
        }),
        apiError("internal", "internal error"),
      );

/** The `Intake` port, over the services the isolate built. */
export const intakePort = Layer.effect(
  Intake,
  Effect.gen(function* () {
    const services = yield* Effect.context<IntakePortServices>();
    return Intake.of({
      submit: (s) =>
        admitDispatch(authenticatedOf(s)).pipe(
          Effect.map(({ executionId, className, duplicate }): IntakeAnswer => ({
            _tag: duplicate ? "Duplicate" : "Admitted",
            executionId,
            class: className,
          })),
          Effect.catchTags({
            IntakeError: (e) => Effect.flatMap(refusalOf(e), Effect.fail),
            StoreUnavailable: () =>
              Effect.fail(apiError("unavailable", "the intake store did not answer")),
          }),
          Effect.provide(services),
        ),
    });
  }),
);
