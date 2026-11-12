// The `dispatch.followOn` applier's admission port: one request for the named
// run on its parent's commit, through intake, keyed by the `follow-on` recipe
// as `<execution_id>/<intent_key>`, so a repeated apply starts no second
// execution (FD-GH-088).
import { FollowOnSubmitter } from "@fractalboxdev/flare-dispatch-github";
import { DeploySmokeEntrySchema } from "@fractalboxdev/flare-dispatch-catalog";
import { Effect, Layer, Result, Schema } from "effect";
import { IntakeConfig, type Admission, type ClassResolver } from "./config.ts";
import type { HeldCheckReporter } from "./ports.ts";
import { ManifestSource } from "./manifest.ts";
import { IntakeStore, type ShedRecorder } from "./store.ts";
import { submission, submit } from "./submit.ts";

export const followOnSubmitterLayer = Layer.effect(
  FollowOnSubmitter,
  Effect.gen(function* () {
    const context = yield* Effect.context<
      | IntakeConfig
      | Admission
      | ClassResolver
      | IntakeStore
      | ShedRecorder
      | HeldCheckReporter
      | ManifestSource
    >();
    return {
      submit: (intent) =>
        Effect.gen(function* () {
          const config = yield* IntakeConfig;
          const parent = yield* (yield* IntakeStore).get(intent.executionId);
          if (parent === null)
            return {
              _tag: "refused" as const,
              reason: `follow-on: no execution ${intent.executionId}`,
            };
          const run = config.catalog(intent.run);
          if (run === undefined)
            return { _tag: "refused" as const, reason: `follow-on: no run named ${intent.run}` };
          // A dispatch-only run starts from a dispatch, never from another run's intent (FD-GATE-111).
          if (run.dispatchOnly === true)
            return {
              _tag: "refused" as const,
              reason: `follow-on: ${intent.run} starts only from a dispatch`,
            };
          let requested = intent.inputs;
          if (parent.run === "worker-deploy" && intent.run === "deploy-smoke") {
            // The deploy executor cannot select another commit or arbitrary probe targets. The parent pins the
            // repository and commit; that commit's manifest supplies deploySmoke.hosts and paths (FD-GATE-069/071).
            const manifest = yield* (yield* ManifestSource).read(
              parent.repo,
              parent.sha,
              config.catalog,
            );
            if (manifest._tag === "Unreadable")
              return {
                _tag: "unavailable" as const,
                reason: `follow-on manifest: ${manifest.reason}`,
              };
            if (manifest._tag !== "Valid")
              return {
                _tag: "refused" as const,
                reason: "follow-on: deploy-smoke manifest absent or invalid",
              };
            const entry = manifest.manifest.runs.find(
              (e) => e.recipe === "deploy-smoke" && (e.label ?? null) === intent.label,
            );
            const params = Schema.decodeUnknownResult(DeploySmokeEntrySchema)(entry?.params);
            if (Result.isFailure(params))
              return {
                _tag: "refused" as const,
                reason: "follow-on: deploy-smoke entry absent or invalid",
              };
            requested = { ...params.success, scope: parent.repo, sha: parent.sha };
          }
          const inputs = Schema.decodeUnknownResult(run.input)(requested);
          if (Result.isFailure(inputs))
            return {
              _tag: "refused" as const,
              reason: `follow-on: inputs: ${inputs.failure.message}`,
            };
          const admitted = yield* submit(
            submission({
              run,
              trigger: parent.trigger,
              label: intent.label,
              repo: parent.repo,
              sha: parent.sha,
              ref: parent.ref,
              inputs: inputs.success,
              installation: parent.installation,
              // A follow-on reads its parent's input, so it keeps the parent's data classes (FD-AGT-005).
              repositoryPublic: parent.repositoryPublic,
              inputAssociations: parent.inputAssociations,
              followOn: { executionId: intent.executionId, intentKey: intent.intentKey },
            }),
          );
          return { _tag: "admitted" as const, executionId: admitted.executionId };
        }).pipe(
          Effect.catchTags({
            IntakeError: (e) =>
              Effect.succeed(
                e.status === 503
                  ? { _tag: "unavailable" as const, reason: e.message }
                  : { _tag: "refused" as const, reason: `${e.code}: ${e.message}` },
              ),
            StoreUnavailable: (e) =>
              Effect.succeed({ _tag: "unavailable" as const, reason: e.message }),
          }),
          Effect.provide(context),
        ),
    };
  }),
);
