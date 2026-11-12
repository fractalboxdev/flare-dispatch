// The local submit: a device's `local.register` under a capacity lease, which the control plane's local registration
// port passes here, becomes one admission request of trigger kind `local` with the `local-only` placement
// constraint, under which the control plane posts no GitHub check and admits no cloud spend (FD-INT-061). mameko
// checks the capacity lease before the port is called (MAMEKO-PROTO-082).
import { Effect, Schema } from "effect";
import { IntakeConfig, type Admission, type ClassResolver } from "./config.ts";
import type { HeldCheckReporter } from "./ports.ts";
import type { IntakeStore, ShedRecorder } from "./store.ts";
import { submission, submit } from "./submit.ts";

export const LOCAL_ONLY = "local-only";
/** Local work is advisory and runs at the lowest class. */
export const LOCAL_CLASS = "batch";

/** What a local submit carries: the repository, base commit and ref a rehearsal tested, and its run inputs. */
export const LocalSubmitBody = Schema.Struct({
  repository: Schema.NonEmptyString,
  baseCommit: Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/)),
  ref: Schema.NonEmptyString,
  treeHash: Schema.NonEmptyString,
  inputsDigest: Schema.NonEmptyString,
  inputs: Schema.Unknown,
});

export type LocalSubmitAnswer =
  | { readonly _tag: "admitted"; readonly executionId: string }
  | { readonly _tag: "rejected" };

const rejected = { _tag: "rejected" } as const;

/**
 * Submits one local registration through admission. A body that does not decode, a run outside the catalogue,
 * inputs the run rejects and a refusal by admission answer `rejected`; nothing was admitted and the device keeps the
 * lease.
 */
export const submitLocal = (
  lease: { readonly leaseId: string; readonly epoch: number },
  runName: string,
  body: unknown,
) =>
  Effect.gen(function* () {
    const config = yield* IntakeConfig;
    const run = config.catalog(runName);
    if (run === undefined) return rejected as LocalSubmitAnswer;
    const local = yield* Schema.decodeUnknownEffect(LocalSubmitBody)(body);
    const inputs = yield* Schema.decodeUnknownEffect(run.input)(local.inputs);
    const admitted = yield* submit(
      submission({
        run,
        trigger: "local",
        repo: local.repository,
        sha: local.baseCommit,
        ref: local.ref,
        inputs,
        local: {
          leaseId: lease.leaseId,
          treeHash: local.treeHash,
          inputsDigest: local.inputsDigest,
        },
        forcedClass: LOCAL_CLASS,
        placementConstraint: LOCAL_ONLY,
        extraLabels: [LOCAL_ONLY],
        applyCooldown: false,
      }),
    );
    return { _tag: "admitted", executionId: admitted.executionId } as LocalSubmitAnswer;
  }).pipe(
    Effect.catchTags({
      SchemaError: () => Effect.succeed(rejected),
      IntakeError: () => Effect.succeed(rejected),
      StoreUnavailable: () => Effect.succeed(rejected),
    }),
  );

/** `submitLocal` over the intake services in reach, for the control plane's local registration port to call. */
export const localSubmitter = Effect.gen(function* () {
  const context = yield* Effect.context<
    IntakeConfig | Admission | ClassResolver | IntakeStore | ShedRecorder | HeldCheckReporter
  >();
  return {
    submit: (
      lease: { readonly leaseId: string; readonly epoch: number },
      runName: string,
      body: unknown,
    ): Effect.Effect<LocalSubmitAnswer> =>
      submitLocal(lease, runName, body).pipe(Effect.provide(context)),
  };
});
