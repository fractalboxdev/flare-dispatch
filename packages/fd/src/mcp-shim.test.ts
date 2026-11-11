import {
  DispatchBody,
  Dispatched,
  ExecutionView,
  IncidentV1,
} from "@fractalboxdev/flare-dispatch-api/declaration";
import {
  CancelTool,
  DispatchTool,
  GetFailureSummaryTool,
  GetVerdictTool,
  LocalExecution,
  MAX_TOOL_RESULT_BYTES,
  ShimTools,
} from "@fractalboxdev/flare-dispatch-api/mcp-tools";
import {
  DISPATCHER,
  makeHarness,
  MEMBER,
  ORIGIN,
  record,
  type Harness,
} from "@fractalboxdev/flare-dispatch-api/test-support";
import { Effect, Layer } from "effect";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { FdFetch } from "./client.ts";
import { FdConfig } from "./config.ts";
import { memoryStore, signedIn } from "./fd.test-support.ts";
import { LocalScheduler, LocalSchedulerSocket } from "./local-scheduler.ts";
import { shimHandlers } from "./mcp-shim.ts";

let h: Harness;
beforeAll(async () => {
  h = await makeHarness();
  h.doubles.executions.set(
    "01JOK",
    record({ execution_id: "01JOK", verdict: "success", conclusion: "success" }),
  );
  h.doubles.executions.set("01JBAD", record({ execution_id: "01JBAD" }));
});

const local = (id: string): typeof LocalExecution.Type => ({
  execution_id: id,
  status: "done",
  queue_position: null,
  verdict: "success",
  reason: null,
  advisory: true,
});

const calls: string[] = [];
const schedulerDouble = Layer.succeed(LocalScheduler)({
  submit: (s) =>
    Effect.sync(
      () => (
        calls.push(`submit ${s.run} ${s.class}`),
        { ...local("local-01JREH"), status: "queued" as const, verdict: null, queue_position: 2 }
      ),
    ),
  outcome: (id, wait) => Effect.sync(() => (calls.push(`outcome ${id} ${wait}`), local(id))),
  failureSummary: (id) =>
    Effect.succeed({
      contractVersion: "v1" as const,
      incidentId: id,
      class: "ci" as const,
      repo: "acme/widgets",
      suspectFiles: Array.from({ length: 50 }, () => "p".repeat(1000)),
    }),
  cancel: (id) =>
    Effect.sync(
      () => (calls.push(`cancel ${id}`), { ...local(id), verdict: "cancelled" as const }),
    ),
  queue: Effect.succeed([]),
  leaseStatus: Effect.succeed({
    state: "held",
    slots: { batch: 2 },
    remaining_token_allowance: 1000,
    offline: false,
  }),
});

const run = async <A, E>(
  effect: Effect.Effect<
    A,
    E,
    FdConfig | LocalScheduler | import("./credentials.ts").CredentialStore
  >,
  options: { readonly email?: string; readonly scheduler?: Layer.Layer<LocalScheduler> } = {},
) => {
  const store =
    options.email === undefined ? new Map<string, string>() : await signedIn(h, options.email);
  const config = Layer.succeed(FdConfig)({ url: ORIGIN, schedulerSocket: undefined });
  return Effect.runPromise(
    Effect.result(effect).pipe(
      Effect.provideService(FdFetch, h.asFetch()),
      Effect.provide(
        Layer.mergeAll(memoryStore(store), options.scheduler ?? schedulerDouble, config),
      ),
    ),
  );
};

const ok = <A>(r: { readonly _tag: string; readonly success?: A }) => {
  expect(r._tag).toBe("Success");
  return r.success as A;
};
const toolError = (r: { readonly _tag: string; readonly failure?: unknown }) => {
  expect(r._tag).toBe("Failure");
  return r.failure as { readonly error: string; readonly message: string };
};

describe("fd mcp", () => {
  it("[FD-IFC-075]: the shim serves the union of the dispatcher's and the local scheduler's tools", () => {
    expect(Object.keys(ShimTools.tools).sort()).toEqual([
      "cancel",
      "dispatch",
      "get_failure_summary",
      "get_verdict",
      "lease_status",
      "rehearse",
    ]);
  });

  it("[FD-IFC-075]: rehearse, lease_status and local- ids go to the local scheduler", async () => {
    calls.length = 0;
    ok(await run(shimHandlers.rehearse({ run: "check", wait_seconds: 30 })));
    ok(await run(shimHandlers.get_verdict({ execution_id: "local-01JREH" })));
    ok(await run(shimHandlers.cancel({ execution_id: "local-01JREH" })));
    expect(ok(await run(shimHandlers.lease_status()))).toMatchObject({ state: "held" });
    expect(calls).toEqual([
      "submit check rehearsal",
      "outcome local-01JREH 30",
      "outcome local-01JREH 0",
      "cancel local-01JREH",
    ]);
  });

  it("[FD-IFC-075]: every other call goes to the HTTP API with the developer's own Access token", async () => {
    const view = ok(
      await run(shimHandlers.get_verdict({ execution_id: "01JOK" }), { email: MEMBER }),
    );
    expect(view).toMatchObject({ execution_id: "01JOK", verdict: "success" });
    h.doubles.intake = (s) =>
      Effect.succeed({ _tag: "Admitted", executionId: "01JSHIM", class: s.class ?? "batch" });
    ok(
      await run(shimHandlers.dispatch({ run: "check", repo: "acme/widgets", inputs: {} }), {
        email: DISPATCHER,
      }),
    );
    expect(h.doubles.calls.submissions.at(-1)?.caller).toBe(DISPATCHER);
    const anonymous = toolError(await run(shimHandlers.get_verdict({ execution_id: "01JOK" })));
    expect(anonymous.error).toBe("unauthenticated");
    expect(anonymous.message).toContain("fd login");
  });

  it("[FD-IFC-077]: each control-plane tool takes its schemas from the route it wraps", () => {
    const params = DispatchTool.parametersSchema as unknown as { fields: Record<string, unknown> };
    expect(params.fields["repo"]).toBe(DispatchBody.fields.repository);
    expect(params.fields["inputs"]).toBe(DispatchBody.fields.inputs);
    const success = DispatchTool.successSchema as unknown as { fields: Record<string, unknown> };
    for (const key of Object.keys(Dispatched.fields))
      expect(success.fields[key]).toBe((Dispatched.fields as Record<string, unknown>)[key]);
    expect(GetVerdictTool.successSchema).toBe(ExecutionView);
    expect(CancelTool.successSchema).toBe(ExecutionView);
    expect(GetFailureSummaryTool.successSchema).toBe(IncidentV1);
  });

  it("[FD-IFC-078]: wait_seconds over 60 on get_verdict and dispatch, or 600 on rehearse, is the invalid_wait tool error", async () => {
    expect(
      toolError(await run(shimHandlers.get_verdict({ execution_id: "01JOK", wait_seconds: 61 })))
        .error,
    ).toBe("invalid_wait");
    expect(
      toolError(
        await run(shimHandlers.dispatch({ run: "c", repo: "a/b", inputs: {}, wait_seconds: 61 })),
      ).error,
    ).toBe("invalid_wait");
    expect(toolError(await run(shimHandlers.rehearse({ run: "c", wait_seconds: 601 }))).error).toBe(
      "invalid_wait",
    );
    ok(await run(shimHandlers.rehearse({ run: "c", wait_seconds: 600 })));
  });

  it("[FD-IFC-079]: every result stays within 16 KiB", async () => {
    const pack = ok(await run(shimHandlers.get_failure_summary({ execution_id: "local-01JREH" })));
    expect(new TextEncoder().encode(JSON.stringify(pack)).byteLength).toBeLessThanOrEqual(
      MAX_TOOL_RESULT_BYTES,
    );
    const remote = ok(
      await run(shimHandlers.get_failure_summary({ execution_id: "01JBAD" }), { email: MEMBER }),
    );
    expect(new TextEncoder().encode(JSON.stringify(remote)).byteLength).toBeLessThanOrEqual(
      MAX_TOOL_RESULT_BYTES,
    );
  });

  it("[FD-IFC-080]: a route or scheduler error is a tool error with its code", async () => {
    expect(
      toolError(await run(shimHandlers.get_verdict({ execution_id: "nope" }), { email: MEMBER }))
        .error,
    ).toBe("execution_not_found");
    const unreachable = toolError(
      await run(shimHandlers.lease_status(), {
        scheduler: LocalSchedulerSocket.pipe(
          Layer.provide(Layer.succeed(FdConfig)({ url: ORIGIN, schedulerSocket: undefined })),
        ),
      }),
    );
    expect(unreachable.error).toBe("scheduler_unreachable");
  });

  it("[FD-IFC-081]: a verdict of capacity-lease work is advisory", async () => {
    expect(ok(await run(shimHandlers.get_verdict({ execution_id: "local-01JREH" }))).advisory).toBe(
      true,
    );
    expect(ok(await run(shimHandlers.rehearse({ run: "check" }))).advisory).toBe(true);
    expect(
      ok(await run(shimHandlers.get_verdict({ execution_id: "01JOK" }), { email: MEMBER }))
        .advisory,
    ).toBe(false);
  });
});

describe("fd-mcp over stdio", () => {
  it("[FD-IFC-075]: the executable serves the six tools over stdio and exits 0 when the client closes it", async () => {
    const child = spawn(
      process.execPath,
      [
        "--experimental-strip-types",
        "--no-warnings",
        join(import.meta.dirname, "../bin/fd-mcp.mjs"),
      ],
      {
        stdio: ["pipe", "pipe", "inherit"],
        env: { ...process.env, FD_URL: ORIGIN },
      },
    );
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
    const exited = new Promise<number | null>((resolve) => child.on("close", resolve));
    const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`);
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "t", version: "0" },
      },
    });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const deadline = Date.now() + 10_000;
    while (!out.includes('"id":2') && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 50));
    child.stdin.end();
    expect(await exited).toBe(0);
    const list = out
      .split("\n")
      .map((l) =>
        l.trim() === ""
          ? undefined
          : (JSON.parse(l) as { id?: number; result?: { tools?: { name: string }[] } }),
      )
      .find((m) => m?.id === 2);
    expect(list?.result?.tools?.map((t) => t.name).sort()).toEqual([
      "cancel",
      "dispatch",
      "get_failure_summary",
      "get_verdict",
      "lease_status",
      "rehearse",
    ]);
  }, 20_000);
});
