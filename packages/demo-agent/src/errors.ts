// @fractalboxdev/flare-dispatch-demo-agent — tagged errors.
//
// One Schema.TaggedError per failure mode the CLI can surface. The CLI's
// top-level catch maps each to a one-line stderr message + non-zero exit;
// downstream consumers (the `product-demo` run, tests) match on the tag, not
// on `_tag` or the message string. Keeping the union closed here means a new
// failure mode is a type error if it isn't added to the runtime Match.

import { Schema } from "effect";

/** `--cdp-ws` failed to attach — bad WS URL, expired token, or network. */
export class CdpAttachFailed extends Schema.TaggedError<CdpAttachFailed>()(
  "CdpAttachFailed",
  {
    wsEndpoint: Schema.String,
    reason: Schema.Literal(
      "invalid-url",
      "connect-refused",
      "auth-failed",
      "timeout",
      "unknown",
    ),
    message: Schema.String,
  },
) {}

/** A CDP command failed mid-session (Page.navigate, Input.dispatchMouseEvent, …). */
export class CdpCommandFailed extends Schema.TaggedError<CdpCommandFailed>()(
  "CdpCommandFailed",
  {
    method: Schema.String,
    message: Schema.String,
  },
) {}

/** The Browser Rendering recording REST endpoint did not return events. */
export class RecordingFetchFailed extends Schema.TaggedError<RecordingFetchFailed>()(
  "RecordingFetchFailed",
  {
    sessionId: Schema.String,
    reason: Schema.Literal(
      "not-found",
      "auth-failed",
      "still-processing",
      "malformed",
      "unknown",
    ),
    message: Schema.String,
  },
) {}

/**
 * The upstream model call failed or returned an unparseable response.
 * Provider-agnostic — works for any `@effect/ai` provider Layer
 * (OpenAI-compatible endpoint, Workers AI, an AI Gateway with BYOK, …).
 */
export class ModelCallFailed extends Schema.TaggedError<ModelCallFailed>()(
  "ModelCallFailed",
  {
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

/** A required environment variable is missing (e.g. CF_AI_GATEWAY_ID). */
export class MissingEnv extends Schema.TaggedError<MissingEnv>()(
  "MissingEnv",
  {
    name: Schema.String,
  },
) {}

/** Filesystem read/write failed. */
export class FsFailed extends Schema.TaggedError<FsFailed>()("FsFailed", {
  path: Schema.String,
  op: Schema.Literal("read", "write", "mkdir"),
  message: Schema.String,
}) {}

export type AgentError =
  | CdpAttachFailed
  | CdpCommandFailed
  | RecordingFetchFailed
  | ModelCallFailed
  | MissingEnv
  | FsFailed;
