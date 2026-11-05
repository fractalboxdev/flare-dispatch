// `fd mcp`: one stdio MCP server, running as the developer, that serves the union of the dispatcher's and the local
// scheduler's tools (FD-IFC-075). `rehearse`, `lease_status` and every `local-` id go to the local scheduler's socket;
// every other call goes to the HTTP API with the developer's own Access token. Each tool's schemas are the wrapped
// route's or operation's (FD-IFC-077), its waits are bounded (FD-IFC-078), its result stays within 16 KiB
// (FD-IFC-079), every failure is a tool error with its code (FD-IFC-080), and capacity-lease verdicts are advisory
// (FD-IFC-081).
import { boundIncident } from "@fractalboxdev/flare-dispatch-api/incident";
import {
  boundResult,
  checkWait,
  MAX_REHEARSE_WAIT_S,
  MAX_WAIT_S,
  ShimTools,
  type ToolError,
} from "@fractalboxdev/flare-dispatch-api/mcp-tools";
import { NodeStdio } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import { McpProtocol, McpServer } from "effect/ai";
import { call, FdFetch, makeClient } from "./client.ts";
import { controlPlaneUrl, FdConfig, FdConfigLive } from "./config.ts";
import { accessToken, CredentialStore, CredentialStoreLive } from "./credentials.ts";
import { dispatchOnce } from "./dispatching.ts";
import { isLocalId, LocalScheduler, LocalSchedulerSocket } from "./local-scheduler.ts";
import type { FdFailure } from "./outcome.ts";

type ShimServices = FdConfig | CredentialStore | LocalScheduler;

const asToolError = <A, R>(effect: Effect.Effect<A, FdFailure | ToolError, R>) =>
  Effect.mapError(effect, (e): ToolError =>
    "_tag" in e ? { error: e.code, message: e.message } : e,
  );

const api = Effect.gen(function* () {
  const url = yield* controlPlaneUrl;
  const token = yield* accessToken;
  return yield* makeClient(url, { _tag: "Access", token }, yield* FdFetch);
});

const waitQuery = (wait: number) => (wait === 0 ? {} : { wait: String(wait) });

/** The tool handlers, over the developer's credential store and the local scheduler. */
export const shimHandlers = {
  rehearse: (p: {
    readonly run: string;
    readonly inputs?: unknown;
    readonly class?: string;
    readonly wait_seconds?: number;
  }) =>
    asToolError(
      Effect.gen(function* () {
        const wait = yield* checkWait(p.wait_seconds, MAX_REHEARSE_WAIT_S);
        const scheduler = yield* LocalScheduler;
        const submitted = yield* scheduler.submit({
          run: p.run,
          inputs: p.inputs ?? {},
          class: p.class ?? "rehearsal",
        });
        const local =
          wait === 0 ? submitted : yield* scheduler.outcome(submitted.execution_id, wait);
        return yield* boundResult(local);
      }),
    ),
  dispatch: (p: {
    readonly run: string;
    readonly repo: string;
    readonly ref?: string;
    readonly sha?: string;
    readonly inputs: unknown;
    readonly class?: string;
    readonly wait_seconds?: number;
  }) =>
    asToolError(
      Effect.gen(function* () {
        const wait = yield* checkWait(p.wait_seconds, MAX_WAIT_S);
        const client = yield* api;
        const dispatched = yield* dispatchOnce(client, p.run, {
          repository: p.repo,
          inputs: p.inputs,
          ...(p.ref === undefined ? {} : { ref: p.ref }),
          ...(p.sha === undefined ? {} : { sha: p.sha }),
          ...(p.class === undefined ? {} : { class: p.class }),
        });
        if (wait === 0) return yield* boundResult(dispatched);
        const verdict = yield* call(
          client.executions.get({
            params: { id: dispatched.execution_id },
            query: waitQuery(wait),
          }),
        );
        return yield* boundResult({ ...dispatched, verdict });
      }),
    ),
  get_verdict: (p: { readonly execution_id: string; readonly wait_seconds?: number }) =>
    asToolError(
      Effect.gen(function* () {
        const wait = yield* checkWait(p.wait_seconds, MAX_WAIT_S);
        if (isLocalId(p.execution_id)) {
          const scheduler = yield* LocalScheduler;
          return yield* boundResult(yield* scheduler.outcome(p.execution_id, wait));
        }
        const client = yield* api;
        return yield* boundResult(
          yield* call(
            client.executions.get({ params: { id: p.execution_id }, query: waitQuery(wait) }),
          ),
        );
      }),
    ),
  get_failure_summary: (p: { readonly execution_id: string }) =>
    asToolError(
      Effect.gen(function* () {
        if (isLocalId(p.execution_id)) {
          const scheduler = yield* LocalScheduler;
          return yield* boundResult(boundIncident(yield* scheduler.failureSummary(p.execution_id)));
        }
        const client = yield* api;
        return yield* boundResult(
          yield* call(client.executions.failureSummary({ params: { id: p.execution_id } })),
        );
      }),
    ),
  cancel: (p: { readonly execution_id: string }) =>
    asToolError(
      Effect.gen(function* () {
        if (isLocalId(p.execution_id)) {
          const scheduler = yield* LocalScheduler;
          return yield* boundResult(yield* scheduler.cancel(p.execution_id));
        }
        const client = yield* api;
        return yield* boundResult(
          yield* call(client.executions.cancel({ params: { id: p.execution_id } })),
        );
      }),
    ),
  lease_status: () =>
    asToolError(
      Effect.flatMap(LocalScheduler, (scheduler) =>
        Effect.flatMap(scheduler.leaseStatus, boundResult),
      ),
    ),
};

/** The toolkit's handlers, each run with the services the Layer was built with. */
export const ShimToolsLive = ShimTools.toLayer(
  Effect.gen(function* () {
    const services = yield* Effect.context<ShimServices>();
    const run = <A, E>(effect: Effect.Effect<A, E, ShimServices>) =>
      Effect.provideContext(effect, services);
    return {
      rehearse: (p: Parameters<typeof shimHandlers.rehearse>[0]) => run(shimHandlers.rehearse(p)),
      dispatch: (p: Parameters<typeof shimHandlers.dispatch>[0]) => run(shimHandlers.dispatch(p)),
      get_verdict: (p: Parameters<typeof shimHandlers.get_verdict>[0]) =>
        run(shimHandlers.get_verdict(p)),
      get_failure_summary: (p: Parameters<typeof shimHandlers.get_failure_summary>[0]) =>
        run(shimHandlers.get_failure_summary(p)),
      cancel: (p: Parameters<typeof shimHandlers.cancel>[0]) => run(shimHandlers.cancel(p)),
      lease_status: () => run(shimHandlers.lease_status()),
    } as never;
  }),
);

/** Serves the shim on stdin and stdout until the client closes it. */
export const runMcpShim = Layer.launch(
  McpServer.toolkit(ShimTools).pipe(
    Layer.provideMerge(
      McpServer.layerStdio({
        name: "flare-dispatch",
        version: "2",
        protocols: [McpProtocol.v2025_11_25, McpProtocol.v2025_06_18, McpProtocol.v2025_03_26],
      }),
    ),
    Layer.provide(ShimToolsLive),
    Layer.provide(LocalSchedulerSocket),
    Layer.provide(Layer.mergeAll(FdConfigLive, CredentialStoreLive, NodeStdio.layer)),
  ),
).pipe(Effect.orDie);
