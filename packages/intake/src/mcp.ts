// The MCP `dispatch` tool: the caller passes the HTTP API's identity gate, and
// the call is submitted through intake as trigger kind `mcp` with the caller's
// identity on the request (FD-INT-062). A `class` above the one `resolveClass`
// assigns is clamped to the assigned class and the clamp is logged (FD-INT-063).
import { GithubRead } from "@fractalboxdev/flare-dispatch-github";
import { Effect, Option, Schema } from "effect";
import { IntakeConfig, intakeError } from "./config.ts";
import { AccessIdentity, lowerOnlyClass } from "./dispatch.ts";
import type { Caller } from "./event.ts";
import { submission, submit } from "./submit.ts";
import { readManifest } from "./triggers.ts";

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

const branchOf = (ref: string) =>
  ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;

/** The tool's handler, called with the request whose identity the gate verifies and the tool's arguments. */
export const mcpDispatch = (request: Request, rawArgs: unknown) =>
  Effect.gen(function* () {
    const identity = yield* (yield* AccessIdentity).identity(request);
    if (identity === null)
      return yield* Effect.fail(
        intakeError(401, "unauthenticated", "the MCP dispatch tool needs an Access identity"),
      );
    const caller: Caller = { kind: "access", id: identity };
    const config = yield* IntakeConfig;
    const github = yield* GithubRead;
    const args = yield* Schema.decodeUnknownEffect(McpDispatchArgs)(rawArgs).pipe(
      Effect.mapError((e) => intakeError(400, "invalid_body", e.message)),
    );
    const run = config.catalog(args.run);
    if (run === undefined)
      return yield* Effect.fail(intakeError(404, "run_not_found", `no run named ${args.run}`));
    const inputs = yield* Schema.decodeUnknownEffect(run.input)(args.inputs ?? {}).pipe(
      Effect.mapError((e) => intakeError(400, "invalid_inputs", e.message)),
    );
    const label = args.label ?? null;
    const defaultBranch = yield* github.defaultBranch(args.repo);
    const manifest = yield* readManifest(
      args.repo,
      yield* github.branchHead(args.repo, defaultBranch),
    );
    const listed = Option.exists(manifest, (m) =>
      m.runs.some(
        (e) => e.recipe === run.name && (e.label ?? null) === label && e.triggers.includes("mcp"),
      ),
    );
    if (!listed || !config.allows(args.repo, run.name))
      return yield* Effect.fail(
        intakeError(
          404,
          "run_not_found",
          `${args.repo}'s manifest lists no MCP dispatch of ${run.name}`,
        ),
      );
    const ref = args.ref ?? `refs/heads/${defaultBranch}`;
    const sha = args.sha ?? (yield* github.branchHead(args.repo, branchOf(ref)));

    const classInput = yield* lowerOnlyClass({
      run,
      repo: args.repo,
      ref,
      sha,
      defaultBranch,
      label,
      caller,
      requested: args.class ?? null,
    });
    const admitted = yield* submit(
      submission({
        run,
        trigger: "mcp",
        label,
        repo: args.repo,
        sha,
        ref,
        inputs,
        caller,
        classInput,
      }),
    );
    return {
      execution_id: admitted.executionId,
      class: admitted.className,
      ...(admitted.duplicate ? { duplicate: true } : {}),
    };
  });
