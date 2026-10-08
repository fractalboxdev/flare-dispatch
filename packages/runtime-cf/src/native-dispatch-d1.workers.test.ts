import { env } from "cloudflare:test";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { NativeReceiptRefused, type NativeRequest } from "@fractalboxdev/flare-dispatch-core";
import { makeNativeDispatchD1 } from "./native-dispatch-d1";
import { makeNativeGithubProvider } from "./native-github-provider";
import { readNativeControllerIdentity } from "@fractalboxdev/flare-dispatch-github-app";

const controller = { appId: 123, actorLogin: "native-controller[bot]" };
const request: NativeRequest = {
  repo: "owner/context", head: "1".repeat(40), base: "2".repeat(40), executor_ref: "3".repeat(40),
  nonce: "native-0123456789abcdef", target: "aarch64-pc-windows-msvc", mode: "gate", profile: "",
  command_sha256: "e964c83ffcc2427c138b484a6fc61f7ebcf70b59186899176e48da89516bb2da",
};
const run = (id = 456) => ({
  repo: request.repo, runId: id, runAttempt: 1, event: "workflow_dispatch",
  executorRef: request.executor_ref, workflowPath: ".github/workflows/native-windows.yml",
  runName: `native-${request.nonce}`, actorLogin: controller.actorLogin, actorType: "Bot",
});
const runEffect = Effect.runPromise;
const loseWriteResponse = (matching: string): Pick<D1Database, "prepare"> => {
  const wrap = (statement: D1PreparedStatement, sql: string): D1PreparedStatement => new Proxy(statement, {
    get(target, property) {
      if (property === "bind") return (...values: Parameters<D1PreparedStatement["bind"]>) => wrap(target.bind(...values), sql);
      if (property === "run" && sql.includes(matching)) return async () => {
        await target.run();
        throw new Error("fixture response lost after actual D1 write");
      };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { prepare: (sql) => wrap(env.RUNS_METADATA.prepare(sql), sql) };
};

describe("durable native dispatch in workerd", () => {
  it("reserves before POST and sends exactly once across concurrent starts and reopening", async () => {
    let posts = 0;
    const provider = {
      dispatch: () => Effect.gen(function* () {
        const row = yield* Effect.promise(() => env.RUNS_METADATA.prepare(
          "SELECT state FROM native_dispatches WHERE repo=? AND nonce=?",
        ).bind(request.repo, request.nonce).first<{ state: string }>());
        expect(row?.state).toBe("dispatching");
        posts++;
      }),
      listRuns: () => Effect.succeed([run()]),
    };
    const jobs = makeNativeDispatchD1(env.RUNS_METADATA, controller, provider);
    await Promise.all([runEffect(jobs.start(request)), runEffect(jobs.start(request))]);
    expect(posts).toBe(1);
    expect((await runEffect(jobs.observe(request))).state).toBe("accepted");
    await runEffect(makeNativeDispatchD1(env.RUNS_METADATA, controller, provider).start(request));
    expect(posts).toBe(1);
  });

  it("preserves an ambiguous POST and reconciles authentic API identity without another POST", async () => {
    let posts = 0;
    const jobs = makeNativeDispatchD1(env.RUNS_METADATA, controller, {
      dispatch: () => Effect.gen(function* () {
        posts++;
        return yield* Effect.fail(new NativeReceiptRefused({ reason: "fixture lost dispatch response" }));
      }),
      listRuns: () => Effect.succeed([run()]),
    });
    expect((await runEffect(jobs.start(request))).state).toBe("dispatching");
    expect((await runEffect(jobs.start(request))).state).toBe("dispatching");
    const reconciled = await runEffect(jobs.reconcile(request));
    expect(reconciled).toMatchObject({ state: "bound", runId: 456, runAttempt: 1 });
    await runEffect(jobs.start(request));
    expect(posts).toBe(1);
  });

  it("refuses nonce reuse, unconfigured controller and invalid commands before POST", async () => {
    let posts = 0;
    const provider = { dispatch: () => Effect.sync(() => { posts++; }), listRuns: () => Effect.succeed([]) };
    const jobs = makeNativeDispatchD1(env.RUNS_METADATA, controller, provider);
    await runEffect(jobs.start(request));
    for (const changed of [{ head: "4".repeat(40) }, { command_sha256: "4".repeat(64) }, { profile: "contextful-full" }]) {
      await expect(runEffect(jobs.start({ ...request, ...changed }))).rejects.toThrow();
    }
    await expect(runEffect(makeNativeDispatchD1(env.RUNS_METADATA,
      { ...controller, actorLogin: "" }, provider).start(request))).rejects.toThrow();
    await expect(runEffect(makeNativeDispatchD1(env.RUNS_METADATA,
      { ...controller, appId: 124 }, provider).start(request))).rejects.toThrow();
    expect(posts).toBe(1);
  });

  it("keeps missing, duplicate and forged API claims unresolved", async () => {
    let posts = 0;
    let runs: readonly unknown[] = [];
    const jobs = makeNativeDispatchD1(env.RUNS_METADATA, controller, {
      dispatch: () => Effect.sync(() => { posts++; }), listRuns: () => Effect.succeed(runs),
    });
    await runEffect(jobs.start(request));
    expect((await runEffect(jobs.reconcile(request))).state).toBe("accepted");
    for (const claims of [
      [run(), run(457)], [{ ...run(), actorLogin: "other[bot]" }],
      [{ ...run(), actorType: "User" }], [{ ...run(), executorRef: "4".repeat(40) }],
      [{ ...run(), event: "push" }], [{ ...run(), workflowPath: "different.yml" }],
    ]) {
      runs = claims;
      await expect(runEffect(jobs.reconcile(request))).rejects.toThrow();
      expect((await runEffect(jobs.observe(request))).state).toBe("accepted");
    }
    expect(posts).toBe(1);
  });

  it("refuses conflicting API identities after a run binding is durable", async () => {
    let runs = [run()];
    const jobs = makeNativeDispatchD1(env.RUNS_METADATA, controller, {
      dispatch: () => Effect.void, listRuns: () => Effect.succeed(runs),
    });
    await runEffect(jobs.start(request));
    await runEffect(jobs.reconcile(request));
    runs = [run(457)];
    await expect(runEffect(jobs.reconcile(request))).rejects.toThrow();
    expect((await runEffect(jobs.observe(request))).runId).toBe(456);
  });

  it("reopens a committed reservation after its response is lost", async () => {
    let posts = 0;
    const provider = { dispatch: () => Effect.sync(() => { posts++; }), listRuns: () => Effect.succeed([]) };
    await expect(runEffect(makeNativeDispatchD1(loseWriteResponse("INSERT OR IGNORE"),
      controller, provider).start(request))).rejects.toThrow();
    expect(posts).toBe(0);
    const jobs = makeNativeDispatchD1(env.RUNS_METADATA, controller, provider);
    expect((await runEffect(jobs.observe(request))).state).toBe("reserved");
    await runEffect(jobs.start(request));
    expect(posts).toBe(1);
  });

  it("never POSTs after a dispatch claim committed but its response was lost", async () => {
    let posts = 0;
    const provider = { dispatch: () => Effect.sync(() => { posts++; }), listRuns: () => Effect.succeed([]) };
    await expect(runEffect(makeNativeDispatchD1(loseWriteResponse("SET state='dispatching'"),
      controller, provider).start(request))).rejects.toThrow();
    const jobs = makeNativeDispatchD1(env.RUNS_METADATA, controller, provider);
    expect((await runEffect(jobs.start(request))).state).toBe("dispatching");
    expect((await runEffect(jobs.reconcile(request))).state).toBe("dispatching");
    expect(posts).toBe(0);
  });

  it("preserves an accepted POST after its D1 acknowledgement response was lost", async () => {
    let posts = 0;
    const provider = { dispatch: () => Effect.sync(() => { posts++; }), listRuns: () => Effect.succeed([run()]) };
    await expect(runEffect(makeNativeDispatchD1(loseWriteResponse("SET state='accepted'"),
      controller, provider).start(request))).rejects.toThrow();
    const jobs = makeNativeDispatchD1(env.RUNS_METADATA, controller, provider);
    expect((await runEffect(jobs.start(request))).state).toBe("accepted");
    expect((await runEffect(jobs.reconcile(request))).state).toBe("bound");
    expect(posts).toBe(1);
  });

  it("reconciles actual GitHub transport decoding and authenticated App identity through durable D1", async () => {
    let posts = 0;
    let reads = 0;
    const fetchImpl: typeof fetch = async (url, init) => {
      const headers = new Headers(init?.headers);
      if (String(url) === "https://api.github.com/app") {
        expect(headers.get("authorization")).toBe("Bearer fixture-app-jwt");
        return Response.json({ id: 123, slug: "native-controller" });
      }
      expect(headers.get("authorization")).toBe("Bearer fixture-installation");
      if (init?.method === "POST") {
        posts++;
        expect(JSON.parse(String(init.body))).toEqual({
          ref: request.executor_ref, inputs: { request: JSON.stringify(request) },
        });
        throw new Error("fixture POST response lost after provider accepts request");
      }
      reads++;
      return Response.json({ total_count: 1, workflow_runs: [{
        id: 456, run_attempt: 1, event: "workflow_dispatch", head_sha: request.executor_ref,
        path: ".github/workflows/native-windows.yml", display_title: `native-${request.nonce}`,
        repository: { full_name: request.repo }, actor: { login: "native-controller[bot]", type: "Bot" },
      }] });
    };
    const authenticated = await readNativeControllerIdentity({ appId: "123", appJwt: "fixture-app-jwt", fetchImpl });
    const jobs = makeNativeDispatchD1(env.RUNS_METADATA, authenticated,
      makeNativeGithubProvider({ repo: request.repo, token: "fixture-installation", fetchImpl }));
    expect((await runEffect(jobs.start(request))).state).toBe("dispatching");
    await runEffect(jobs.start(request));
    expect(await runEffect(jobs.reconcile(request))).toEqual({ state: "bound", runId: 456, runAttempt: 1 });
    expect(posts).toBe(1);
    expect(reads).toBe(1);
  });
});
