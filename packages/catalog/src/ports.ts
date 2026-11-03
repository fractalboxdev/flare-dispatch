// The services a gate recipe reaches beyond `GateExec` and `GithubRead`. mameko names `Artifact`, `Intents`, `Cache`
// and `Children` as capabilities (`CAPABILITIES` in mameko-run) but serves none of them yet, so each is an FD-owned
// interface that an executor kind's Layer backs.
import { LocalContent } from "@fractalboxdev/mameko-run";
import { Context, Effect, Layer, Schema } from "effect";
import type { Outcome } from "./reasons.ts";

export class ArtifactUploadFailed extends Schema.TaggedError<ArtifactUploadFailed>()(
  "ArtifactUploadFailed",
  { name: Schema.String, detail: Schema.String },
) {}

/** The execution's artifact store. */
export class GateArtifacts extends Context.Service<
  GateArtifacts,
  {
    readonly upload: (name: string, bytes: Uint8Array) => Effect.Effect<void, ArtifactUploadFailed>;
  }
>()("@fractalboxdev/flare-dispatch-catalog/GateArtifacts") {}

/**
 * Artifacts on the device's local content store for the execution's tenant scope. The store keys bytes by digest only,
 * so the job's log records each artifact's name beside its digest.
 */
export const localContentArtifacts: Layer.Layer<GateArtifacts, never, LocalContent> = Layer.effect(
  GateArtifacts,
  Effect.gen(function* () {
    const content = yield* LocalContent;
    return {
      upload: (name, bytes) =>
        content.put(bytes).pipe(
          Effect.tap((digest) =>
            Effect.sync(() => process.stderr.write(`[artifact] ${name} ${digest}\n`)),
          ),
          Effect.asVoid,
          Effect.mapError((e) => new ArtifactUploadFailed({ name, detail: e.reason })),
        ),
    };
  }),
);

export class IntentRejected extends Schema.TaggedError<IntentRejected>()("IntentRejected", {
  kind: Schema.String,
  key: Schema.String,
  detail: Schema.String,
}) {}

/** One run-authored intent: its kind from the run's `intentKinds` and its key `<step name>:<index>`. */
export interface GateIntent {
  readonly kind: string;
  readonly key: string;
  readonly payload: unknown;
}

/** The run's outbox: the control plane applies each intent after it accepts the result. */
export class GateIntents extends Context.Service<
  GateIntents,
  { readonly emit: (intent: GateIntent) => Effect.Effect<void, IntentRejected> }
>()("@fractalboxdev/flare-dispatch-catalog/GateIntents") {}

/** A cache entry a manifest names: its key and the workspace paths it holds. */
export interface CacheEntry {
  readonly key: string;
  readonly paths: readonly string[];
}

/**
 * The cache in the namespaces the control plane assigned to the execution. An executor kind builds this Layer from the
 * lease's `cache_namespaces`, so no run input or job can name a namespace (FD-GATE-015, FD-CACHE-016).
 */
export class GateCache extends Context.Service<
  GateCache,
  {
    /** Answers whether the entry restored; a miss leaves the workspace as it was. */
    readonly restore: (entry: CacheEntry, workspace: string) => Effect.Effect<boolean>;
    readonly save: (entry: CacheEntry, workspace: string) => Effect.Effect<void>;
  }
>()("@fractalboxdev/flare-dispatch-catalog/GateCache") {}

/** A child execution's end as the parent reads it: an outcome, or none recorded. */
export type ChildVerdict =
  | { readonly _tag: "Recorded"; readonly outcome: Outcome }
  | { readonly _tag: "NoVerdict" };

/** The child execution a matrix parent requests for one job. */
export interface ChildRequest {
  readonly key: string;
  /** `<parent dedup key>/<job key>`, so a replay of the parent creates no second job (FD-GATE-031). */
  readonly dedupKey: string;
  readonly run: string;
  readonly input: unknown;
  /** The class the job runs at, where it differs from the parent's. */
  readonly className?: string;
  /** The check the job reports under, where the matrix sets `checkPerJob` (FD-GATE-046). */
  readonly checkName?: string;
}

export interface ChildHandle {
  readonly key: string;
  readonly executionId: string;
}

export class ChildStartFailed extends Schema.TaggedError<ChildStartFailed>()("ChildStartFailed", {
  key: Schema.String,
  detail: Schema.String,
}) {}

/** A discovery job's end: its exit code and stdout, or an outcome that ended it before an exit. */
export type DiscoveryResult =
  | { readonly _tag: "Exited"; readonly code: number; readonly output: string }
  | { readonly _tag: "Ended"; readonly outcome: Outcome };

/**
 * A parent's child executions. Each child has its own placement, execution lease, hold and workspace (FD-GATE-030);
 * the parent itself makes no sandbox call (FD-GATE-045).
 */
export class MatrixChildren extends Context.Service<
  MatrixChildren,
  {
    readonly start: (request: ChildRequest) => Effect.Effect<ChildHandle, ChildStartFailed>;
    readonly await: (handle: ChildHandle) => Effect.Effect<ChildVerdict>;
    /** Cancels through mameko's cancellation path (FD-GATE-042). */
    readonly cancel: (handle: ChildHandle) => Effect.Effect<void>;
    /** Runs a discovery command on one commit as a job and answers its stdout (FD-GATE-048). */
    readonly discover: (request: ChildRequest) => Effect.Effect<DiscoveryResult, ChildStartFailed>;
  }
>()("@fractalboxdev/flare-dispatch-catalog/MatrixChildren") {}
