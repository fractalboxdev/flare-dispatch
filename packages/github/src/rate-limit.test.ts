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
  call: "apply",
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
  it("MAMEKO-OUT-038 grants one permit per call and counts it against the installation", async () => {
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

  it("MAMEKO-OUT-038 keys the budget by installation", async () => {
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

  it("FD-GH-058 MAMEKO-OUT-041 at the reserve only check.open and check.conclude rows get a permit", async () => {
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

  it("FD-GH-062 MAMEKO-OUT-038 caps apply permits per minute; lookup and reconcile do not count", async () => {
    const answers = await withQuota(
      Effect.gen(function* () {
        const tags: string[] = [];
        for (let i = 0; i < 3; i++) tags.push((yield* acquire(permit()))._tag);
        tags.push((yield* acquire(permit({ call: "lookup" })))._tag);
        tags.push((yield* acquire(permit({ call: "reconcile" })))._tag);
        tags.push((yield* acquire(permit({ call: "apply" })))._tag);
        return tags;
      }),
      { ...quotaOptionsDefault, perMinute: 3 },
    );
    expect(answers).toEqual(["granted", "granted", "granted", "granted", "granted", "wait"]);
  });

  it("FD-GH-063 MAMEKO-OUT-039 a 9th concurrent call waits until a permit is released", async () => {
    const result = await withQuota(
      Effect.gen(function* () {
        const limit = yield* ApplierRateLimit;
        const permits: string[] = [];
        for (let i = 0; i < 8; i++) {
          const answer = yield* limit.acquire(permit({ call: i % 2 === 0 ? "apply" : "lookup" }));
          if (answer._tag === "granted") permits.push(answer.permitId);
        }
        const ninth = yield* limit.acquire(permit());
        const other = yield* limit.acquire(permit({ limitKey: "8" }));
        yield* limit.release(permits[0]!);
        const afterRelease = yield* limit.acquire(permit());
        const tenth = yield* limit.acquire(permit());
        return {
          permits: new Set(permits).size,
          ninth,
          other: other._tag,
          afterRelease: afterRelease._tag,
          tenth: tenth._tag,
        };
      }),
    );
    expect(result).toEqual({
      permits: 8,
      ninth: { _tag: "wait", retryAt: NOW + 1000 },
      other: "granted",
      afterRelease: "granted",
      tenth: "wait",
    });
  });

  it("MAMEKO-OUT-039 releasing an unknown or already released permit changes nothing", async () => {
    const tags = await withQuota(
      Effect.gen(function* () {
        const limit = yield* ApplierRateLimit;
        const out: string[] = [];
        for (let i = 0; i < 8; i++) {
          const answer = yield* limit.acquire(permit());
          if (answer._tag === "granted") out.push(answer.permitId);
        }
        yield* limit.release(out[0]!);
        yield* limit.release(out[0]!);
        yield* limit.release("7:999");
        return [(yield* limit.acquire(permit()))._tag, (yield* limit.acquire(permit()))._tag];
      }),
    );
    expect(tags).toEqual(["granted", "wait"]);
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
