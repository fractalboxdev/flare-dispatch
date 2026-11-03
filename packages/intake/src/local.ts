// FlareDispatch's local registration port: a device's `local.register` under a
// capacity lease becomes one admission request of trigger kind `local` with the
// `local-only` placement constraint, under which the control plane posts no
// GitHub check and admits no cloud spend (FD-INT-061). mameko checks the
// capacity lease before the port is called (MAMEKO-PROTO-081).
import { LocalRegistration } from "@fractalboxdev/mameko-ports";
import { Effect, Layer, Schema } from "effect";
import { IntakeConfig, type Admission, type ClassResolver } from "./config.ts";
import type { IntakeStore, ShedRecorder } from "./store.ts";
import { submission, submit } from "./submit.ts";

export const LOCAL_ONLY = "local-only";
/** Local work is advisory and runs at the lowest class. */
export const LOCAL_CLASS = "batch";

export const LocalRegistrationBody = Schema.Struct({
  repo: Schema.NonEmptyString,
  sha: Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/)),
  ref: Schema.NonEmptyString,
  treeHash: Schema.NonEmptyString,
  inputsDigest: Schema.NonEmptyString,
  inputs: Schema.Unknown,
});

/**
 * The port's Layer over intake. A registration that does not decode, names no catalogue run, carries inputs the run
 * rejects, or that admission refuses is `rejected`; the device keeps the lease and nothing was admitted.
 */
export const localRegistrationLayer = Layer.effect(
  LocalRegistration,
  Effect.gen(function* () {
    const context = yield* Effect.context<
      IntakeConfig | Admission | ClassResolver | IntakeStore | ShedRecorder
    >();
    const rejected = { _tag: "rejected" } as const;
    return {
      register: (lease, runName, registration) =>
        Effect.gen(function* () {
          const config = yield* IntakeConfig;
          const run = config.catalog(runName);
          if (run === undefined) return rejected;
          const body = yield* Schema.decodeUnknownEffect(LocalRegistrationBody)(registration);
          const inputs = yield* Schema.decodeUnknownEffect(run.input)(body.inputs);
          const admitted = yield* submit(
            submission({
              run,
              trigger: "local",
              repo: body.repo,
              sha: body.sha,
              ref: body.ref,
              inputs,
              local: {
                leaseId: lease.leaseId,
                treeHash: body.treeHash,
                inputsDigest: body.inputsDigest,
              },
              forcedClass: LOCAL_CLASS,
              placementConstraint: LOCAL_ONLY,
              extraLabels: [LOCAL_ONLY],
              applyCooldown: false,
            }),
          );
          return {
            _tag: "accepted" as const,
            executionId: admitted.executionId,
            nonce: `${lease.leaseId}:${lease.epoch}:${admitted.executionId}`,
          };
        }).pipe(
          Effect.catchTags({
            SchemaError: () => Effect.succeed(rejected),
            IntakeError: () => Effect.succeed(rejected),
            StoreUnavailable: () => Effect.succeed(rejected),
          }),
          Effect.provide(context),
        ),
    };
  }),
);
