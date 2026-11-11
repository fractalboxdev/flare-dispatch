// The MCP `dispatch` tool: the caller passes the HTTP API's identity gate, and
// the call is submitted through intake as trigger kind `mcp` with the caller's
// identity on the request (FD-INT-062). It is admitted by `admitDispatch`, the
// admission `POST /v1/dispatch/:run` reaches, so the tool keeps that route's
// installation, catalog, input, signals and dedup rules (FD-IFC-074), and a
// `class` above the one `resolveClass` assigns is clamped to the assigned class
// and the clamp is logged (FD-INT-063).
import { Context, Effect, Schema } from "effect";
import { intakeError } from "./config.ts";
import { admitDispatch } from "./dispatch.ts";

/** The Access identity gate of the HTTP API: the verified identity of the request, or null when it carries none. */
export class AccessIdentity extends Context.Service<
  AccessIdentity,
  { readonly identity: (request: Request) => Effect.Effect<string | null> }
>()("@fractalboxdev/flare-dispatch-intake/AccessIdentity") {}

export const McpDispatchArgs = Schema.Struct({
  run: Schema.NonEmptyString,
  repo: Schema.NonEmptyString,
  ref: Schema.optionalKey(Schema.NonEmptyString),
  sha: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/))),
  label: Schema.optionalKey(Schema.NonEmptyString),
  inputs: Schema.optionalKey(Schema.Unknown),
  class: Schema.optionalKey(Schema.NonEmptyString),
});
export type McpDispatchArgs = typeof McpDispatchArgs.Type;

/** The tool's handler, called with the request whose identity the gate verifies and the tool's arguments. */
export const mcpDispatch = (request: Request, rawArgs: unknown) =>
  Effect.gen(function* () {
    const identity = yield* (yield* AccessIdentity).identity(request);
    if (identity === null)
      return yield* Effect.fail(
        intakeError(401, "unauthenticated", "the MCP dispatch tool needs an Access identity"),
      );
    const args = yield* Schema.decodeUnknownEffect(McpDispatchArgs)(rawArgs).pipe(
      Effect.mapError((e) => intakeError(400, "invalid_body", e.message)),
    );
    const admitted = yield* admitDispatch({
      trigger: "mcp",
      run: args.run,
      repository: args.repo,
      ref: args.ref,
      sha: args.sha,
      label: args.label ?? null,
      inputs: args.inputs,
      signals: undefined,
      classInput: args.class ?? null,
      caller: { kind: "access", id: identity },
      vouchedSha: undefined,
      idempotency: null,
    });
    return {
      execution_id: admitted.executionId,
      class: admitted.className,
      ...(admitted.duplicate ? { duplicate: true } : {}),
    };
  });
