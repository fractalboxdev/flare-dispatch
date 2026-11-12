// The reproduction submitter (specs/provenance.md FD-PROV-064): one request for the release's recipe on the release's
// commit, ref and inputs, through intake, at class `interactive` under the `reproduction` placement constraint. The
// request carries `reproduction` as a run label, which the profile's `reproduction` constraint holds for, and as its
// recorded placement constraint, which the cache namespaces read to turn caches off. The request is keyed
// `<release execution id>/reproduction`, so a repeated submit starts no second reproduction of one release.
import {
  REPRODUCTION_CLASS,
  REPRODUCTION_CONSTRAINT,
  ReproductionSubmitter,
  type ReproductionRequest,
} from "@fractalboxdev/flare-dispatch-cache/reproduction-request";
import { Effect, Layer, Result, Schema } from "effect";
import { IntakeConfig, type Admission, type ClassResolver } from "./config.ts";
import type { HeldCheckReporter } from "./ports.ts";
import { IntakeStore, type IntakeRecord, type ShedRecorder } from "./store.ts";
import { submission, submit, type Submission } from "./submit.ts";

/** The intent key a reproduction request is keyed by under its release execution. */
export const REPRODUCTION_INTENT_KEY = "reproduction";

/**
 * The submission of a reproduction request over the release's intake record: the release's run, commit, ref and inputs,
 * `interactive`, the `reproduction` constraint, a control-plane dispatch that waits out no cooldown.
 */
export const reproductionSubmission = (
  release: IntakeRecord,
  request: ReproductionRequest,
  run: Submission["run"],
  inputs: unknown,
): Submission =>
  submission({
    run,
    trigger: "dispatch",
    label: release.label,
    repo: request.repository,
    sha: request.commit,
    ref: request.ref,
    inputs,
    installation: release.installation,
    caller: { kind: "control-plane", id: `reproduction:${request.reproduces}` },
    forcedClass: REPRODUCTION_CLASS,
    placementConstraint: REPRODUCTION_CONSTRAINT,
    extraLabels: [REPRODUCTION_CONSTRAINT],
    applyCooldown: false,
    repositoryPublic: release.repositoryPublic,
    inputAssociations: release.inputAssociations,
    followOn: { executionId: request.reproduces, intentKey: REPRODUCTION_INTENT_KEY },
  });

export const reproductionSubmitterLayer = Layer.effect(
  ReproductionSubmitter,
  Effect.gen(function* () {
    const context = yield* Effect.context<
      IntakeConfig | Admission | ClassResolver | IntakeStore | ShedRecorder | HeldCheckReporter
    >();
    return {
      submit: (request) =>
        Effect.gen(function* () {
          const config = yield* IntakeConfig;
          const release = yield* (yield* IntakeStore).get(request.reproduces);
          if (release === null)
            return { _tag: "refused" as const, reason: `reproduction: no execution ${request.reproduces}` };
          if (
            release.repo !== request.repository ||
            release.sha !== request.commit ||
            release.run !== request.run
          )
            return {
              _tag: "refused" as const,
              reason: `reproduction: the request names another run, repository or commit than ${request.reproduces}`,
            };
          const run = config.catalog(request.run);
          if (run === undefined)
            return { _tag: "refused" as const, reason: `reproduction: no run named ${request.run}` };
          const inputs = Schema.decodeUnknownResult(run.input)(request.inputs);
          if (Result.isFailure(inputs))
            return { _tag: "refused" as const, reason: `reproduction: inputs: ${inputs.failure.message}` };
          const admitted = yield* submit(reproductionSubmission(release, request, run, inputs.success));
          return { _tag: "admitted" as const, executionId: admitted.executionId };
        }).pipe(
          Effect.catchTags({
            IntakeError: (e) =>
              Effect.succeed(
                e.status === 503
                  ? { _tag: "unavailable" as const, reason: e.message }
                  : { _tag: "refused" as const, reason: `${e.code}: ${e.message}` },
              ),
            StoreUnavailable: (e) => Effect.succeed({ _tag: "unavailable" as const, reason: e.message }),
          }),
          Effect.provide(context),
        ),
    };
  }),
);
