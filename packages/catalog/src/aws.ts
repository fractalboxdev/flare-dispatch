// The services `image-publish` and `stack-deploy` reach in the `control` pool (specs/runs/gate.md § AWS builds and
// stack deploys). The control plane builds each inside the execution: it mints the OIDC token, assumes the role and
// signs every AWS call, so a run body names a target and never holds a credential (FD-GATE-117, FD-GATE-118). This
// module imports no process or file API.
import { Context, Effect, Layer, Schema } from "effect";
import * as DurableClock from "effect/workflow/DurableClock";
import type * as WorkflowEngine from "effect/workflow/WorkflowEngine";
import type { ReleaseAsset } from "./manifest.ts";

/**
 * Where one build's AWS calls go: the region, the role, and the target the OIDC audience names. The control plane
 * builds the audience from the lease's scope id, the repository its record holds, so no input can name another
 * repository's role (FD-GATE-117).
 */
export interface AwsTarget {
  readonly region: string;
  readonly roleArn: string;
  /** `image-publish`, `image-publish:<label>` or `stack:<stack>`. */
  readonly target: string;
}

/** The audience of a target: `image-publish`, `image-publish:<label>` or `stack:<stack>` (FD-GATE-117). */
export const awsAudience = (scope: string, target: string): string =>
  `flare-dispatch:${scope}:${target}`;

/** STS refused the web-identity exchange (FD-GATE-119). */
export class AwsAssumeRoleFailed extends Schema.TaggedError<AwsAssumeRoleFailed>()(
  "AwsAssumeRoleFailed",
  { code: Schema.String },
) {}

/**
 * An AWS call failed. `transient` is a network error or a 5xx status, which the recipe retries (FD-GATE-125);
 * otherwise `code` is the error code AWS answered.
 */
export class AwsCallFailed extends Schema.TaggedError<AwsCallFailed>()("AwsCallFailed", {
  service: Schema.String,
  operation: Schema.String,
  transient: Schema.Boolean,
  code: Schema.String,
}) {}

export type AwsError = AwsAssumeRoleFailed | AwsCallFailed;

/** CodeBuild's `buildStatus` values. */
export type BuildStatusName =
  | "IN_PROGRESS"
  | "SUCCEEDED"
  | "FAILED"
  | "FAULT"
  | "STOPPED"
  | "TIMED_OUT";

export interface BuildPhase {
  readonly type: string;
  readonly status?: string;
  readonly durationSec?: number;
}

/** One build as `BatchGetBuilds` answers it, in the fields the recipe reads. */
export interface BuildState {
  readonly id: string;
  readonly status: BuildStatusName;
  readonly phases: readonly BuildPhase[];
  readonly logs?: { readonly group: string; readonly stream: string };
  /** The build's exported environment variables. */
  readonly exported: Readonly<Record<string, string>>;
}

export interface StartBuildRequest {
  readonly project: string;
  readonly sourceVersion: string;
  readonly env: Readonly<Record<string, string>>;
  /** CodeBuild's idempotency token, which holds for 5 min. */
  readonly idempotencyToken: string;
}

/** One ECS service's rollout as `DescribeServices` answers it (FD-GATE-139). */
export type ServiceRollout =
  | { readonly _tag: "Missing"; readonly name: string }
  | {
      readonly _tag: "Found";
      readonly name: string;
      /** The `PRIMARY` deployment's `rolloutState`, or `undefined` where it has none. */
      readonly rolloutState: string | undefined;
      readonly runningCount: number;
      readonly desiredCount: number;
    };

/** CodeBuild and ECS under the target's role. */
export class AwsBuilds extends Context.Service<
  AwsBuilds,
  {
    readonly start: (
      target: AwsTarget,
      request: StartBuildRequest,
    ) => Effect.Effect<string, AwsError>;
    readonly get: (target: AwsTarget, buildId: string) => Effect.Effect<BuildState, AwsError>;
    readonly stop: (target: AwsTarget, buildId: string) => Effect.Effect<void, AwsError>;
    readonly services: (
      target: AwsTarget,
      cluster: string,
      services: readonly string[],
    ) => Effect.Effect<readonly ServiceRollout[], AwsError>;
  }
>()("@fractalboxdev/flare-dispatch-catalog/AwsBuilds") {}

/** The store could not be read or written. */
export class LedgerUnavailable extends Schema.TaggedError<LedgerUnavailable>()(
  "LedgerUnavailable",
  { detail: Schema.String },
) {}

/** The builds the execution started, by target (FD-GATE-121). */
export class BuildLedger extends Context.Service<
  BuildLedger,
  {
    readonly recorded: (target: string) => Effect.Effect<string | undefined, LedgerUnavailable>;
    readonly record: (target: string, buildId: string) => Effect.Effect<void, LedgerUnavailable>;
  }
>()("@fractalboxdev/flare-dispatch-catalog/BuildLedger") {}

/** Why an asset could not be staged (FD-GATE-130). */
export class AssetFailed extends Schema.TaggedError<AssetFailed>()("AssetFailed", {
  key: Schema.String,
  kind: Schema.Literals([
    "uninstalled",
    "not found",
    "too large",
    "digest mismatch",
    "unavailable",
  ]),
}) {}

/** A staged asset: a presigned GET URL and the bytes' SHA-256. */
export interface StagedAsset {
  readonly url: string;
  readonly sha256: string;
}

/** Release assets staged in the object store by digest (FD-GATE-129). */
export class ReleaseAssets extends Context.Service<
  ReleaseAssets,
  { readonly stage: (asset: ReleaseAsset) => Effect.Effect<StagedAsset, AssetFailed> }
>()("@fractalboxdev/flare-dispatch-catalog/ReleaseAssets") {}

export type ApprovalDecision = "approve" | "reject";

/** The approval record of the execution (FD-GATE-136, FD-IFC-104). */
export class StackApprovals extends Context.Service<
  StackApprovals,
  {
    /** Records that the execution waits for a decision on its commit and stack; repeating it changes nothing. */
    readonly request: (stack: string, sha: string) => Effect.Effect<void, LedgerUnavailable>;
    readonly decision: () => Effect.Effect<ApprovalDecision | undefined, LedgerUnavailable>;
  }
>()("@fractalboxdev/flare-dispatch-catalog/StackApprovals") {}

/** The durable wait between polls: `DurableClock.sleep` in the workflow body (MAMEKO-RUN-037). */
export class Pause extends Context.Service<
  Pause,
  { readonly sleep: (name: string, millis: number) => Effect.Effect<void> }
>()("@fractalboxdev/flare-dispatch-catalog/Pause") {}

/**
 * `Pause` over `DurableClock.sleep` with no in-memory threshold, so every wait is journaled and the run resumes after
 * its object is evicted. Built inside the execution, where the workflow's engine and instance are in scope.
 */
export const durablePause: Layer.Layer<
  Pause,
  never,
  WorkflowEngine.WorkflowEngine | WorkflowEngine.WorkflowInstance
> = Layer.effect(
  Pause,
  Effect.gen(function* () {
    const context = yield* Effect.context<
      WorkflowEngine.WorkflowEngine | WorkflowEngine.WorkflowInstance
    >();
    return {
      sleep: (name: string, millis: number) =>
        DurableClock.sleep({ name, duration: millis, inMemoryThreshold: 0 }).pipe(
          Effect.provide(context),
        ),
    };
  }),
);

/** `Pause` over `Effect.sleep`, for a body that runs outside a workflow. */
export const effectPause: Layer.Layer<Pause> = Layer.succeed(Pause, {
  sleep: (_name, millis) => Effect.sleep(millis),
});
