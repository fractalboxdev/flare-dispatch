// @fractalbox/flare-dispatch-review-agent — tagged errors.
//
// One Schema.TaggedError per failure mode the engine surfaces. Callers
// (`pr-review` run) recover with `Effect.catchTag` — never `._tag` — so the
// error boundary that always posts a PR comment can render a precise reason.

import { Schema } from "effect";

/**
 * The upstream model call failed or returned an unusable response.
 * Provider-agnostic — the engine maps the `modelGateway` capability's
 * `ModelGatewayError` (Workers AI / any model backend) onto this.
 */
export class ModelCallFailed extends Schema.TaggedError<ModelCallFailed>()(
  "ModelCallFailed",
  {
    /** The configured backend name, for the operator-facing reason string. */
    backend: Schema.String,
    /** The model id passed through to the provider. */
    model: Schema.String,
    reason: Schema.Literal(
      "missing-api-key",
      "auth-failed",
      "rate-limited",
      "bad-response",
      "timeout",
      "unknown",
    ),
    message: Schema.String,
  },
) {}

/**
 * The configured backend could not be resolved from CONFIG_KV + secrets —
 * e.g. an unknown backend name, or a required key/secret is unset.
 */
export class BackendUnconfigured extends Schema.TaggedError<BackendUnconfigured>()(
  "BackendUnconfigured",
  {
    backend: Schema.String,
    /** The missing config key or secret name, for the operator. */
    missing: Schema.String,
  },
) {}

/**
 * The model ran in `json` mode but its text response could not be turned into
 * a Schema-valid object — used when a reasoning model (e.g. DeepSeek-R1) emits
 * `<think>…</think>` prose or otherwise non-JSON output, or returns JSON that
 * fails to decode against the `Finding[]` / `ReviewOutput` schema.
 */
export class StructuredOutputInvalid extends Schema.TaggedError<StructuredOutputInvalid>()(
  "StructuredOutputInvalid",
  {
    backend: Schema.String,
    model: Schema.String,
    /**
     * Which structured surface failed — a free-form label for diagnosis. The
     * `pr-review` engine uses `"review"` / `"coordinate"`; a downstream recipe
     * passes its own (e.g. `"spec-drift"`, `"ci-triage"`).
     */
    surface: Schema.String,
    /** Why the parse/decode failed. */
    reason: Schema.Literal("empty", "not-json", "schema-mismatch"),
    /** A short, truncated excerpt of the raw model text, for diagnosis. */
    excerpt: Schema.String,
    message: Schema.String,
  },
) {}

export type ReviewEngineError =
  | ModelCallFailed
  | BackendUnconfigured
  | StructuredOutputInvalid;
