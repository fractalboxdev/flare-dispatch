// `POST /v1/dispatch/:run`: an authenticated dispatch, through intake's one door (FD-IFC-024 to FD-IFC-036).
import { Effect, Match } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { FlareDispatchApi, type DispatchBody, type Dispatched } from "../declaration.ts";
import { apiError, type ApiError } from "../errors.ts";
import { CurrentIdentity, type AccessIdentity, type ActionsIdentity } from "../identity.ts";
import { executionLinks } from "../links.ts";
import { Intake, type DispatchSubmission } from "../ports.ts";
import type { ApiConfig } from "../config.ts";

const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{1,128}$/;

/** JSON with every object's keys sorted, so equal bodies serialize to equal text. */
export const canonicalJson = (value: unknown): string =>
  JSON.stringify(value, (_key, v: unknown) =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)),
        )
      : v,
  );

/** The `Idempotency-Key` header, validated as FD-INT-011 requires. */
export const idempotencyOf = (
  header: string | undefined,
  body: DispatchBody,
): Effect.Effect<DispatchSubmission["idempotency"], ApiError> =>
  header === undefined
    ? Effect.succeed(undefined)
    : IDEMPOTENCY_KEY.test(header)
      ? Effect.succeed({ key: header, canonicalBody: canonicalJson(body) })
      : Effect.fail(
          apiError(
            "invalid_idempotency_key",
            "Idempotency-Key is 1 to 128 characters from [A-Za-z0-9._:-]",
          ),
        );

/**
 * The submission an identity makes. An Actions token fixes the repository, ref and workflow ref from its claims
 * (FD-IFC-025), and a body naming another repository answers `repository_mismatch` (FD-IFC-026).
 */
export const submissionOf = (
  identity: AccessIdentity | ActionsIdentity,
  run: string,
  body: DispatchBody,
  idempotency: DispatchSubmission["idempotency"],
  trigger: DispatchSubmission["trigger"],
): Effect.Effect<DispatchSubmission, ApiError> => {
  const common = {
    trigger,
    run,
    label: body.label,
    inputs: body.inputs,
    class: body.class,
    signals: body.signals,
    caller: identity.id,
    idempotency,
  };
  return Match.value(identity).pipe(
    Match.tagsExhaustive({
      Actions: (actions) =>
        body.repository.toLowerCase() !== actions.repository.toLowerCase()
          ? Effect.fail(
              apiError(
                "repository_mismatch",
                `the token is for ${actions.repository}, not ${body.repository}`,
              ),
            )
          : Effect.succeed<DispatchSubmission>({
              ...common,
              repository: actions.repository,
              ref: actions.ref,
              sha: body.sha ?? actions.sha,
              workflowRef: actions.workflowRef,
              vouchedSha: actions.sha,
            }),
      Access: () =>
        Effect.succeed<DispatchSubmission>({
          ...common,
          repository: body.repository,
          ref: body.ref,
          sha: body.sha,
          workflowRef: undefined,
          vouchedSha: undefined,
        }),
    }),
  );
};

/** The 202 of an admitted or duplicate dispatch (FD-IFC-035, FD-IFC-036). */
export const submit = (
  submission: DispatchSubmission,
): Effect.Effect<Dispatched, ApiError, Intake | ApiConfig> =>
  Effect.gen(function* () {
    const intake = yield* Intake;
    const answer = yield* intake.submit(submission);
    const links = yield* executionLinks(answer.executionId, "check-run");
    return Match.value(answer).pipe(
      Match.tagsExhaustive({
        Admitted: ({ executionId, class: cls }) => ({
          execution_id: executionId,
          class: cls,
          ...links,
        }),
        Duplicate: ({ executionId, class: cls }) => ({
          execution_id: executionId,
          class: cls,
          ...links,
          duplicate: true as const,
        }),
      }),
    );
  });

const dispatcherIdentity = Effect.gen(function* () {
  const identity = yield* CurrentIdentity;
  return yield* Match.value(identity).pipe(
    Match.tag("Access", "Actions", (id) => Effect.succeed(id)),
    Match.orElse(() =>
      Effect.fail(apiError("unauthenticated", "a dispatch needs a verified identity")),
    ),
  );
});

export const DispatchHandlers = HttpApiBuilder.group(FlareDispatchApi, "dispatch", (handlers) =>
  handlers.handle("dispatch", ({ params, payload, headers }) =>
    Effect.gen(function* () {
      const identity = yield* dispatcherIdentity;
      const idempotency = yield* idempotencyOf(headers["idempotency-key"], payload);
      const submission = yield* submissionOf(
        identity,
        params.run,
        payload,
        idempotency,
        "dispatch",
      );
      return yield* submit(submission);
    }),
  ),
);
