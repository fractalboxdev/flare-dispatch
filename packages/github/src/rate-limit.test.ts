import { ApplierRateLimit, type PermitRequest } from "@fractalboxdev/mameko-ports";
import { Effect, Layer } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";
import { GithubClient, githubClientLayer, GithubHttpError, observeHeaders } from "./client.ts";
import {
  ApplierRateLimitLive,
  InstallationQuota,
  installationQuotaLayer,
  quotaOptionsDefault,
} from "./rate-limit.ts";

const permit = (overrides: Partial<PermitRequest> = {}): PermitRequest => ({
  limitKey: "7",
  kind: "comment",
  tier: "effect",
  priority: 2,
  drawsReserve: false,
  classRank: 1,
  insertedAt: 0,
  ...overrides,
});

const NOW = 1_000_000;

/** Runs against a fresh quota at a fixed test time. */
const withQuota = <A, E>(
  effect: Effect.Effect<A, E, ApplierRateLimit | InstallationQuota>,
  options = quotaOptionsDefault,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      return yield* effect;
    }).pipe(
      // One quota instance serves both services.
      Effect.provide(Layer.provideMerge(ApplierRateLimitLive, installationQuotaLayer(options))),
      Effect.provide(TestClock.layer()),
    ),
  );

const acquire = (r: PermitRequest) =>
  Effect.gen(function* () {
    const limit = yield* ApplierRateLimit;
    return yield* limit.acquire(r);
  });
const observe = (key: string, o: Parameters<InstallationQuota["Service"]["observe"]>[1]) =>
  Effect.gen(function* () {
    const quota = yield* InstallationQuota;
    yield* quota.observe(key, o);
  });

describe("applier rate limit", () => {
  it("MAMEKO-OUT-037 grants one permit per call and counts it against the installation", async () => {
    const answers = await withQuota(
      Effect.gen(function* () {
        yield* observe("7", { limit: 100, remaining: 12 });
        const first = yield* acquire(permit());
        const second = yield* acquire(permit());
        const third = yield* acquire(permit());
        return [first._tag, second._tag, third._tag];
      }),
    );
    // 12 → 11 → 10, and at 10 (the reserve) a non-reserve kind waits.
    expect(answers).toEqual(["granted", "granted", "wait"]);
  });

  it("MAMEKO-OUT-037 keys the budget by installation", async () => {
    const answers = await withQuota(
      Effect.gen(function* () {
        yield* observe("7", { limit: 100, remaining: 0, resetAt: NOW + 5000 });
        return [
          (yield* acquire(permit({ limitKey: "7" })))._tag,
          (yield* acquire(permit({ limitKey: "8" })))._tag,
        ];
      }),
    );
    expect(answers).toEqual(["wait", "granted"]);
  });

  it("FD-GH-058 MAMEKO-OUT-039 at the reserve only check.open and check.conclude rows get a permit", async () => {
    const answers = await withQuota(
      Effect.gen(function* () {
        yield* observe("7", { limit: 100, remaining: 10, resetAt: NOW + 5000 });
        return [
          yield* acquire(permit({ kind: "check.start", priority: 1 })),
          (yield* acquire(permit({ kind: "check.open", priority: 0, drawsReserve: true })))._tag,
          (yield* acquire(permit({ kind: "check.conclude", tier: "outcome", drawsReserve: true })))
            ._tag,
        ];
      }),
    );
    expect(answers).toEqual([{ _tag: "wait", retryAt: NOW + 5000 }, "granted", "granted"]);
  });

  it("FD-GH-059 at 30% the lowest-rank class gets no permit outside the reserve kinds", async () => {
    const answers = await withQuota(
      Effect.gen(function* () {
        yield* observe("7", { limit: 100, remaining: 30, resetAt: NOW + 5000 });
        return [
          (yield* acquire(permit({ classRank: 3 })))._tag,
          (yield* acquire(permit({ classRank: 3, kind: "check.open", drawsReserve: true })))._tag,
          (yield* acquire(permit({ classRank: 2 })))._tag,
        ];
      }),
    );
    expect(answers).toEqual(["wait", "granted", "granted"]);
  });

  it("FD-GH-060 grants nothing before a Retry-After instant", async () => {
    const answer = await withQuota(
      Effect.gen(function* () {
        yield* observe("7", { retryAfterAt: NOW + 30_000 });
        return yield* acquire(permit({ drawsReserve: true }));
      }),
    );
    expect(answer).toEqual({ _tag: "wait", retryAt: NOW + 30_000 });
  });

  it("FD-GH-061 at 0 remaining grants nothing until the reset, then the budget refills", async () => {
    const answers = await withQuota(
      Effect.gen(function* () {
        yield* observe("7", { limit: 100, remaining: 0, resetAt: NOW + 60_000 });
        const before = yield* acquire(permit({ drawsReserve: true }));
        yield* TestClock.adjust("61 seconds");
        const after = yield* acquire(permit());
        return [before, after._tag];
      }),
    );
    expect(answers).toEqual([{ _tag: "wait", retryAt: NOW + 60_000 }, "granted"]);
  });

  it("FD-GH-062 caps content-creating permits per minute", async () => {
    const answers = await withQuota(
      Effect.gen(function* () {
        const tags: string[] = [];
        for (let i = 0; i < 4; i++) tags.push((yield* acquire(permit()))._tag);
        return tags;
      }),
      { ...quotaOptionsDefault, perMinute: 3 },
    );
    expect(answers).toEqual(["granted", "granted", "granted", "wait"]);
  });
});

describe("live client", () => {
  const response = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", ...headers },
    });

  const live = (fetch: typeof globalThis.fetch) =>
    Layer.provideMerge(
      githubClientLayer({
        fetch,
        token: () => Effect.succeed("t"),
        baseUrl: "https://github.test",
      }),
      installationQuotaLayer(),
    );

  it("FD-GH-057 stores x-ratelimit-remaining and x-ratelimit-reset from every response", () => {
    const headers = new Headers({
      "x-ratelimit-limit": "5000",
      "x-ratelimit-remaining": "42",
      "x-ratelimit-reset": "2000",
    });
    expect(observeHeaders(headers, NOW)).toEqual({
      limit: 5000,
      remaining: 42,
      resetAt: 2_000_000,
    });
    expect(observeHeaders(new Headers({ "retry-after": "30" }), NOW)).toEqual({
      retryAfterAt: NOW + 30_000,
    });
  });

  it("FD-GH-057 FD-GH-061 a response's headers reach the installation's quota", async () => {
    const calls: string[] = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      calls.push(`${init?.method} ${String(input)}`);
      return response(
        201,
        { id: 5 },
        {
          "x-ratelimit-limit": "100",
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": "4102444800",
        },
      );
    };
    const answer = await Effect.runPromise(
      Effect.gen(function* () {
        const github = yield* GithubClient;
        yield* github.createCheckRun({ installation: 7, repo: "acme/app", body: { name: "n" } });
        const limit = yield* ApplierRateLimit;
        return yield* limit.acquire(permit({ drawsReserve: true }));
      }).pipe(Effect.provide(Layer.provideMerge(ApplierRateLimitLive, live(fetch)))),
    );
    expect(calls).toEqual(["POST https://github.test/repos/acme/app/check-runs"]);
    expect(answer).toEqual({ _tag: "wait", retryAt: 4_102_444_800_000 });
  });

  it("FD-GH-046 marks a secondary-rate-limit 403 as rate-limited and a permission 403 as not", async () => {
    const run = (headers: Record<string, string>, message: string) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const github = yield* GithubClient;
          return yield* Effect.flip(
            github.updateCheckRun({ installation: 7, repo: "acme/app", checkRunId: 1, body: {} }),
          );
        }).pipe(Effect.provide(live(async () => response(403, { message }, headers)))),
      );
    const secondary = await run(
      { "retry-after": "60" },
      "You have exceeded a secondary rate limit",
    );
    const forbidden = await run({}, "Resource not accessible by integration");
    expect(secondary).toBeInstanceOf(GithubHttpError);
    expect(secondary).toMatchObject({ status: 403, rateLimited: true });
    expect(forbidden).toMatchObject({ status: 403, rateLimited: false });
  });
});
