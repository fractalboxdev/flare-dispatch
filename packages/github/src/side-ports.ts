// What the side-output appliers call beyond GitHub: the staged-write gate, the
// blob store, the release provenance gate, admission for a follow-on, email, the
// notice channel, and the configuration the appliers read, the Slack and records
// endpoints included.
import { Context, Schema, type Effect } from "effect";
import type { CommentWriteStore } from "./comment-writes.ts";

/** One reason the staged-write gate rejects an entry or the manifest (specs/runs/agentic.md § Staged write). */
export const GateReason = Schema.Struct({
  kind: Schema.String,
  path: Schema.optionalKey(Schema.String),
  detail: Schema.optionalKey(Schema.String),
});
export type GateReason = typeof GateReason.Type;

export type GateResult =
  | { readonly _tag: "accepted" }
  | { readonly _tag: "rejected"; readonly reasons: readonly GateReason[] };

/** `stagedWriteGate` over a `pr.propose` manifest (FD-AGT-016, FD-AGT-017). */
export class StagedWriteGate extends Context.Service<
  StagedWriteGate,
  { readonly check: (manifest: unknown) => Effect.Effect<GateResult> }
>()("@fractalboxdev/flare-dispatch-github/StagedWriteGate") {}

/** The blob store the executor wrote each staged blob to, keyed by its SHA-256 digest (FD-AGT-013). */
export class BlobStore extends Context.Service<
  BlobStore,
  { readonly read: (digest: string) => Effect.Effect<Uint8Array | null> }
>()("@fractalboxdev/flare-dispatch-github/BlobStore") {}

/** Admission for a `dispatch.followOn` intent, keyed `<execution_id>/<intent_key>` (FD-GH-088). */
export class FollowOnSubmitter extends Context.Service<
  FollowOnSubmitter,
  {
    readonly submit: (intent: {
      readonly executionId: string;
      readonly intentKey: string;
      readonly run: string;
      readonly label: string | null;
      readonly inputs: unknown;
    }) => Effect.Effect<
      | { readonly _tag: "admitted"; readonly executionId: string }
      | { readonly _tag: "refused"; readonly reason: string }
      | { readonly _tag: "unavailable"; readonly reason: string }
    >;
  }
>()("@fractalboxdev/flare-dispatch-github/FollowOnSubmitter") {}

/** One artifact a `release.publish` intent publishes: its asset name, the digest of its bytes and the execution that built it. */
export interface ReleasePublishArtifact {
  readonly name: string;
  /** `sha256:<hex>`. */
  readonly digest: string;
  readonly executionId: string;
}

export type ReleaseGateAnswer =
  | { readonly _tag: "admitted" }
  | { readonly _tag: "refused"; readonly reason: string; readonly artifact: string }
  | { readonly _tag: "unavailable"; readonly reason: string };

/**
 * The provenance gate on a release's publish (specs/provenance.md § Releases): over the logged statements and the
 * provenance key history, it admits the publish only when every asset the draft holds is one of the intent's artifacts
 * and a logged `platform` statement from a cloud builder names each artifact's digest (FD-PROV-062) without listing a
 * restored cache entry (FD-PROV-063).
 */
export class ReleaseProvenance extends Context.Service<
  ReleaseProvenance,
  {
    readonly gate: (release: {
      /** The names of the assets the draft release holds. */
      readonly assets: readonly string[];
      readonly artifacts: readonly ReleasePublishArtifact[];
    }) => Effect.Effect<ReleaseGateAnswer>;
  }
>()("@fractalboxdev/flare-dispatch-github/ReleaseProvenance") {}

export type DeliveryAnswer =
  | { readonly _tag: "sent"; readonly ref: string }
  | { readonly _tag: "refused"; readonly reason: string }
  | { readonly _tag: "retryable"; readonly reason: string };

/** The email binding; `messageId` derives from the intent key, so a repeat is recognisable (FD-GH-078). */
export class EmailSender extends Context.Service<
  EmailSender,
  {
    readonly send: (message: {
      readonly messageId: string;
      readonly to: readonly string[];
      readonly subject: string;
      readonly text: string;
    }) => Effect.Effect<DeliveryAnswer>;
  }
>()("@fractalboxdev/flare-dispatch-github/EmailSender") {}

/** The notice channel; the delivery id is `<run>:<use case>:<dedupe key>`. */
export class NoticeChannel extends Context.Service<
  NoticeChannel,
  {
    readonly publish: (notice: {
      readonly deliveryId: string;
      readonly title: string;
      readonly body: string;
    }) => Effect.Effect<DeliveryAnswer>;
  }
>()("@fractalboxdev/flare-dispatch-github/NoticeChannel") {}

export interface SideOutputSettings {
  /** Durable ownership of marked comment writes; absence refuses an update rather than issuing an unfenced PATCH. */
  readonly commentWrites?: CommentWriteStore;
  /** The identity the App commits as; a commit by any other author is a human's (FD-GH-084, FD-GH-087). */
  readonly appBot: { readonly login: string; readonly name: string; readonly email: string };
  /** The Slack verdict endpoint and its signing secret; unset refuses every `notify.slack` row. */
  readonly slack: { readonly url: string; readonly secret: string } | undefined;
  /**
   * `records.url` and the verdict record signing key, which `job.record` and `verdict.record` rows are delivered to and
   * signed with (specs/github-output.md § Job and verdict records); unset refuses every record row.
   */
  readonly records?: { readonly url: string; readonly secret: string } | undefined;
  readonly fetch: typeof globalThis.fetch;
}

export class SideOutputConfig extends Context.Service<SideOutputConfig, SideOutputSettings>()(
  "@fractalboxdev/flare-dispatch-github/SideOutputConfig",
) {}
