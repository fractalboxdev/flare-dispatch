// What the control plane creates for a release whose rule sets `reproduce: true` (specs/provenance.md FD-PROV-064), and
// the admission port it creates it through. It imports nothing from the Workers runtime, so intake, which submits the
// request, reads it without the cache stores.
import { Context, Effect, Schema } from "effect";

/** The placement constraint, and the run label it holds for, of a reproduction execution (profile.md § Placement). */
export const REPRODUCTION_CONSTRAINT = "reproduction";
/** The class a reproduction execution runs at. */
export const REPRODUCTION_CLASS = "interactive";
/** The reason a release concludes with when the reproduction's subject digests differ from the release's. */
export const REPRODUCTION_MISMATCH = "provenance: reproduction mismatch";
/** The reason a release concludes with when no reproduction statement is logged by its `deadline_at`. */
export const REPRODUCTION_UNAVAILABLE = "provenance: reproduction unavailable";
/** The reason an outbox row of a reproduction execution is refused. */
export const REPRODUCTION_APPLIES_NO_INTENT = "provenance: a reproduction execution applies no intent";
/** The predicate type of a reproduction record. */
export const REPRODUCTION_RECORD_V1 =
  "https://github.com/fractalboxdev/flare-dispatch/blob/main/specs/provenance.md#reproduction";

/** A release rule's provenance fields: `reproduce: true` asks for a reproduction of each release. */
export const ReleaseRule = Schema.Struct({ reproduce: Schema.optional(Schema.Boolean) });
export type ReleaseRule = typeof ReleaseRule.Type;

/** What the control plane knows of a release execution when it creates the reproduction. */
export interface ReleaseExecution {
  readonly executionId: string;
  readonly repository: string;
  readonly ref: string;
  /** The release recipe. */
  readonly run: string;
  readonly commit: string;
  readonly definitionDigest: string;
  readonly imageDigest: string;
  readonly inputs: unknown;
}

/** The reproduction execution the control plane creates for a release (FD-PROV-064). */
export interface ReproductionRequest {
  /** The release execution this one reproduces. */
  readonly reproduces: string;
  readonly repository: string;
  readonly ref: string;
  readonly run: string;
  readonly commit: string;
  readonly definitionDigest: string;
  readonly imageDigest: string;
  readonly inputs: unknown;
  readonly class: typeof REPRODUCTION_CLASS;
  readonly placementConstraint: typeof REPRODUCTION_CONSTRAINT;
  /** The execution restores and writes no cache entry. */
  readonly caches: "off";
}

/**
 * The reproduction execution a release rule asks for (FD-PROV-064): the release's recipe, commit, run-definition digest,
 * image digest and inputs, caches off, at class `interactive` under the `reproduction` constraint. `null` when the rule
 * does not set `reproduce: true`.
 */
export const reproductionRequestFor = (
  rule: ReleaseRule,
  release: ReleaseExecution,
): ReproductionRequest | null =>
  rule.reproduce === true
    ? {
        reproduces: release.executionId,
        repository: release.repository,
        ref: release.ref,
        run: release.run,
        commit: release.commit,
        definitionDigest: release.definitionDigest,
        imageDigest: release.imageDigest,
        inputs: release.inputs,
        class: REPRODUCTION_CLASS,
        placementConstraint: REPRODUCTION_CONSTRAINT,
        caches: "off",
      }
    : null;

/** Whether an execution's recorded placement constraints make it a reproduction execution. */
export const isReproduction = (constraints: readonly string[]): boolean =>
  constraints.includes(REPRODUCTION_CONSTRAINT);

/** Admission's answer to a reproduction request. */
export type ReproductionAdmission =
  | { readonly _tag: "admitted"; readonly executionId: string }
  | { readonly _tag: "refused"; readonly reason: string }
  | { readonly _tag: "unavailable"; readonly reason: string };

/** Submits a reproduction request to admission, once per release execution however often it is submitted. */
export class ReproductionSubmitter extends Context.Service<
  ReproductionSubmitter,
  { readonly submit: (request: ReproductionRequest) => Effect.Effect<ReproductionAdmission> }
>()("@fractalboxdev/flare-dispatch-cache/ReproductionSubmitter") {}

/** Creates the reproduction execution a release rule asks for (FD-PROV-064); `null` when it asks for none. */
export const startReproduction = (rule: ReleaseRule, release: ReleaseExecution) =>
  Effect.gen(function* () {
    const request = reproductionRequestFor(rule, release);
    if (request === null) return null;
    return yield* (yield* ReproductionSubmitter).submit(request);
  });
