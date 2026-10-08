import { env } from "cloudflare:test";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { NativeReceiptRefused, type NativeRequest } from "@fractalboxdev/flare-dispatch-core";
import { makeNativeDispatchD1 } from "./native-dispatch-d1";

const controller = { appId: 123, actorLogin: "native-controller[bot]" };
const request: NativeRequest = { repo: "owner/context", head: "1".repeat(40), base: "2".repeat(40), executor_ref: "3".repeat(40),
  nonce: "native-0123456789abcdef", target: "aarch64-pc-windows-msvc", mode: "gate", profile: "",
  command_sha256: "e964c83ffcc2427c138b484a6fc61f7ebcf70b59186899176e48da89516bb2da" };
const policy = { timeoutSec: 60 };
const provider = (dispatch: () => Effect.Effect<void, NativeReceiptRefused>) => ({ dispatch,
  listRuns: () => Effect.succeed([]), readRun: () => Effect.fail(new NativeReceiptRefused({ reason: "fixture has no bound run" })) });
const row = () => env.RUNS_METADATA.prepare("SELECT * FROM native_dispatches WHERE repo=? AND nonce=?").bind(request.repo, request.nonce)
  .first<{ admitted_at: number; timeout_sec: number | null; deadline_at: number | null; state: string }>();
const wrapWrite = (sqlMatch: string, intercept: (statement: D1PreparedStatement) => Promise<D1Result>): Pick<D1Database, "prepare"> => {
  const wrap = (statement: D1PreparedStatement, sql: string): D1PreparedStatement => new Proxy(statement, { get(target, key) {
    if (key === "bind") return (...values: Parameters<D1PreparedStatement["bind"]>) => wrap(target.bind(...values), sql);
    if (key === "run" && sql.includes(sqlMatch)) return () => intercept(target);
    const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
  } });
  return { prepare: (sql) => wrap(env.RUNS_METADATA.prepare(sql), sql) };
};

describe("native immutable admission deadline in actual D1", () => {
  it("persists the chosen duration and database-derived deadline before the single POST", async () => {
    let posts = 0;
    const jobs = makeNativeDispatchD1(env.RUNS_METADATA, controller, provider(() => Effect.promise(async () => {
      const intent = await row(); posts++;
      expect(intent?.timeout_sec).toBe(60);
      expect(intent?.deadline_at).toBe(intent!.admitted_at + 60);
    })), policy);
    await Effect.runPromise(jobs.start(request));
    const before = await row(); expect(before?.timeout_sec).toBe(60);
    expect(before?.deadline_at).toBe(before!.admitted_at + 60); expect(posts).toBe(1);
    await expect(env.RUNS_METADATA.prepare("UPDATE native_dispatches SET timeout_sec=120, deadline_at=admitted_at+120 WHERE repo=? AND nonce=?")
      .bind(request.repo, request.nonce).run()).rejects.toThrow();
    expect(await row()).toEqual(before);
  });
  it("refuses policy widening or omission on replay after an ambiguous POST", async () => {
    let posts = 0;
    const backend = provider(() => Effect.sync(() => { posts++; }).pipe(Effect.andThen(Effect.fail(new NativeReceiptRefused({ reason: "fixture accepted POST acknowledgement lost" })))));
    const first = makeNativeDispatchD1(env.RUNS_METADATA, controller, backend, policy);
    await Effect.runPromise(first.start(request)); const before = await row();
    await expect(Effect.runPromise(makeNativeDispatchD1(env.RUNS_METADATA, controller, backend, { timeoutSec: 120 }).start(request))).rejects.toThrow();
    await expect(Effect.runPromise(makeNativeDispatchD1(env.RUNS_METADATA, controller, backend).start(request))).rejects.toThrow();
    await Effect.runPromise(first.start(request)); expect(posts).toBe(1); expect(await row()).toEqual(before);
  });
  it("refuses an expired reserved intent after its actual reservation acknowledgement is lost", async () => {
    let posts = 0;
    const db = wrapWrite("INSERT OR IGNORE", async (statement) => { await statement.run(); throw new Error("fixture reservation acknowledgement lost"); });
    const backend = provider(() => Effect.sync(() => { posts++; }));
    await expect(Effect.runPromise(makeNativeDispatchD1(db, controller, backend, { timeoutSec: 1 }).start(request))).rejects.toThrow();
    expect((await row())?.state).toBe("reserved");
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await expect(Effect.runPromise(makeNativeDispatchD1(env.RUNS_METADATA, controller, backend, { timeoutSec: 1 }).start(request))).rejects.toThrow();
    expect(posts).toBe(0); expect((await row())?.state).toBe("reserved");
  });
  it("refuses a deadline crossed between the preflight read and the claim CAS", async () => {
    let posts = 0;
    const db = wrapWrite("SET state='dispatching'", async (statement) => {
      await new Promise((resolve) => setTimeout(resolve, 1100)); return statement.run();
    });
    await expect(Effect.runPromise(makeNativeDispatchD1(db, controller, provider(() => Effect.sync(() => { posts++; })),
      { timeoutSec: 1 }).start(request))).rejects.toThrow();
    expect(posts).toBe(0); expect((await row())?.state).toBe("reserved");
  });
  it("refuses to infer policy for a legacy policy-less intent", async () => {
    let posts = 0; const backend = provider(() => Effect.sync(() => { posts++; }));
    await Effect.runPromise(makeNativeDispatchD1(env.RUNS_METADATA, controller, backend).start(request));
    await expect(Effect.runPromise(makeNativeDispatchD1(env.RUNS_METADATA, controller, backend, policy).start(request))).rejects.toThrow();
    expect(posts).toBe(1);
  });
  it("refuses to POST when a successful claim acknowledgement arrives after the immutable deadline", async () => {
    let posts = 0;
    const db = wrapWrite("SET state='dispatching'", async (statement) => {
      const result = await statement.run(); await new Promise((resolve) => setTimeout(resolve, 1100)); return result;
    });
    await expect(Effect.runPromise(makeNativeDispatchD1(db, controller, provider(() => Effect.sync(() => { posts++; })),
      { timeoutSec: 1 }).start(request))).rejects.toThrow();
    expect(posts).toBe(0); expect((await row())?.state).toBe("dispatching");
  });
});
