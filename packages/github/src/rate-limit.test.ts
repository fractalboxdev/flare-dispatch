import { ActuatorRateLimit, type PermitRequest } from "@fractalboxdev/mameko-ports";
import { Effect, Layer } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";
import {
  GithubClient,
  githubClientLayer,
  GithubHttpError,
  GithubNetworkError,
  observeHeaders,
} from "./client.ts";
import { InstallationDirectory } from "./directory.ts";
import {
  ActuatorRateLimitLive,
  emptyQuotaLedger,
  InstallationQuota,
  installationQuotaLayer,
  installationQuotaObjectLayer,
  quotaObjectOver,
  quotaOptionsDefault,
  QuotaUnavailable,
  type QuotaLedger,
  type QuotaObject,
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

/** `acme/app` is served by installation 7, `acme/down` cannot be read and no installation serves any other repository. */
const directory = Layer.succeed(InstallationDirectory, {
  installationFor: (scope) =>
    scope === "acme/down"
      ? Effect.fail(new GithubNetworkError({ sent: false, message: "unreachable" }))
      : Effect.succeed(scope === "acme/app" ? 7 : null),
});

/** Runs against a fresh quota at a fixed test time. */
const withQuota = <A, E>(
  effect: Effect.Effect<A, E, ActuatorRateLimit | InstallationQuota>,
  options = quotaOptionsDefault,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      return yield* effect;
    }).pipe(
      // One quota instance serves both services.
      Effect.provide(
        Layer.provideMerge(
          ActuatorRateLimitLive,
          Layer.merge(installationQuotaLayer(options), directory),
        ),
      ),
      Effect.provide(TestClock.layer()),
    ),
  );

const acquire = (r: PermitRequest) =>
  Effect.gen(function* () {
    const limit = yield* ActuatorRateLimit;
    return yield* limit.acquire(r);
  });
const observe = (key: string, o: Parameters<InstallationQuota["Service"]["observe"]>[1]) =>
  Effect.gen(function* () {
    const quota = yield* InstallationQuota;
    yield* quota.observe(key, o);
  });

describe("applier rate limit", () => {
  it("MAMEKO-OUT-040 grants one permit per call and counts it against the installation", async () => {
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

  it("MAMEKO-OUT-040 keys the budget by installation", async () => {
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

  it("[FD-GH-056] MAMEKO-OUT-059 a row keyed by its repository takes its permit from its installation's quota", async () => {
    const answers = await withQuota(
      Effect.gen(function* () {
        yield* observe("7", { limit: 100, remaining: 0, resetAt: NOW + 5000 });
        return [
          yield* acquire(permit({ limitKey: "acme/app", drawsReserve: true })),
          (yield* acquire(permit({ limitKey: "acme/other" })))._tag,
          (yield* acquire(permit({ limitKey: "app" })))._tag,
        ];
      }),
    );
    // The repository resolves to installation 7, which is spent; an unserved repository and the App's key are not.
    expect(answers).toEqual([{ _tag: "wait", retryAt: NOW + 5000 }, "granted", "granted"]);
  });

  it("[FD-GH-056] permits keyed by the installation and by its repository share one concurrency bound", async () => {
    const result = await withQuota(
      Effect.gen(function* () {
        const limit = yield* ActuatorRateLimit;
        const permits: string[] = [];
        for (let i = 0; i < 8; i++) {
          const key = i % 2 === 0 ? "7" : "acme/app";
          const answer = yield* limit.acquire(permit({ limitKey: key }));
          if (answer._tag === "granted") permits.push(answer.permitId);
        }
        const ninth = (yield* limit.acquire(permit({ limitKey: "acme/app" })))._tag;
        yield* limit.release(permits[1]!);
        const afterRelease = (yield* limit.acquire(permit({ limitKey: "7" })))._tag;
        return { granted: permits.length, ninth, afterRelease };
      }),
    );
    expect(result).toEqual({ granted: 8, ninth: "wait", afterRelease: "granted" });
  });

  it("[FD-GH-056] a repository whose installation cannot be read gets no permit until a later request", async () => {
    const answer = await withQuota(acquire(permit({ limitKey: "acme/down", drawsReserve: true })));
    expect(answer).toEqual({ _tag: "wait", retryAt: NOW + quotaOptionsDefault.concurrentRetryMs });
  });

  it("[FD-GH-058] MAMEKO-OUT-043 at the reserve only check.open and check.conclude rows get a permit", async () => {
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

  it("[FD-GH-059] at 30% the lowest-rank class gets no permit outside the reserve kinds", async () => {
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

  it("[FD-GH-060] grants nothing before a Retry-After instant", async () => {
    const answer = await withQuota(
      Effect.gen(function* () {
        yield* observe("7", { retryAfterAt: NOW + 30_000 });
        return yield* acquire(permit({ drawsReserve: true }));
      }),
    );
    expect(answer).toEqual({ _tag: "wait", retryAt: NOW + 30_000 });
  });

  it("[FD-GH-061] at 0 remaining grants nothing until the reset, then the budget refills", async () => {
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

  it("[FD-GH-062] MAMEKO-OUT-040 caps apply permits per minute; lookup and reconcile do not count", async () => {
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

  it("[FD-GH-062] counts apply permits over any 60 s, not a window that restarts", async () => {
    const answers = await withQuota(
      Effect.gen(function* () {
        const out: unknown[] = [(yield* acquire(permit()))._tag];
        yield* TestClock.adjust("59 seconds");
        out.push((yield* acquire(permit()))._tag, yield* acquire(permit()));
        // 60 s on, the first grant leaves the span: one more fits, and the next waits until the 59 s grant leaves it.
        yield* TestClock.adjust("1 second");
        out.push((yield* acquire(permit()))._tag, yield* acquire(permit()));
        return out;
      }),
      { ...quotaOptionsDefault, perMinute: 2 },
    );
    expect(answers).toEqual([
      "granted",
      "granted",
      { _tag: "wait", retryAt: NOW + 60_000 },
      "granted",
      { _tag: "wait", retryAt: NOW + 119_000 },
    ]);
  });

  it("[FD-GH-062] caps apply permits per hour at the default 500", async () => {
    const answers = await withQuota(
      Effect.gen(function* () {
        let granted = 0;
        // 81 calls a minute for 7 minutes: 80 each minute fit the minute cap until the hour's 500 are out.
        for (let minute = 0; minute < 7; minute++) {
          for (let i = 0; i < 81; i++) {
            const answer = yield* acquire(permit());
            if (answer._tag === "granted") {
              granted++;
              yield* ActuatorRateLimit.use((l) => l.release(answer.permitId));
            }
          }
          yield* TestClock.adjust("1 minute");
        }
        return { granted, next: yield* acquire(permit()) };
      }),
    );
    expect(quotaOptionsDefault).toMatchObject({ perMinute: 80, perHour: 500 });
    expect(answers).toEqual({ granted: 500, next: { _tag: "wait", retryAt: NOW + 3_600_000 } });
  });

  it("[FD-GH-058] a row of the outcome tier draws the reserve though mameko writes it unflagged", async () => {
    const answers = await withQuota(
      Effect.gen(function* () {
        yield* observe("7", { limit: 100, remaining: 10, resetAt: NOW + 5000 });
        return [
          (yield* acquire(permit({ kind: "check.conclude", tier: "outcome" })))._tag,
          (yield* acquire(permit({ kind: "comment", tier: "effect" })))._tag,
        ];
      }),
    );
    expect(answers).toEqual(["granted", "wait"]);
  });

  it("[FD-GH-063] MAMEKO-OUT-041 a 9th concurrent call waits until a permit is released", async () => {
    const result = await withQuota(
      Effect.gen(function* () {
        const limit = yield* ActuatorRateLimit;
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

  it("MAMEKO-OUT-041 releasing an unknown or already released permit changes nothing", async () => {
    const tags = await withQuota(
      Effect.gen(function* () {
        const limit = yield* ActuatorRateLimit;
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

  it("[FD-GH-057] stores x-ratelimit-remaining and x-ratelimit-reset from every response", () => {
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

  it("[FD-GH-057] [FD-GH-061] a response's headers reach the installation's quota", async () => {
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
        const limit = yield* ActuatorRateLimit;
        return yield* limit.acquire(permit({ drawsReserve: true }));
      }).pipe(
        Effect.provide(
          Layer.provideMerge(ActuatorRateLimitLive, Layer.merge(live(fetch), directory)),
        ),
      ),
    );
    expect(calls).toEqual(["POST https://github.test/repos/acme/app/check-runs"]);
    expect(answer).toEqual({ _tag: "wait", retryAt: 4_102_444_800_000 });
  });

  it("[FD-GH-056] headers observed under the installation reach a row keyed by its repository", async () => {
    const fetch: typeof globalThis.fetch = async () =>
      response(
        201,
        { id: 5 },
        {
          "x-ratelimit-limit": "100",
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": "4102444800",
        },
      );
    const answer = await Effect.runPromise(
      Effect.gen(function* () {
        const github = yield* GithubClient;
        yield* github.createCheckRun({ installation: 7, repo: "acme/app", body: { name: "n" } });
        const limit = yield* ActuatorRateLimit;
        return yield* limit.acquire(permit({ limitKey: "acme/app", drawsReserve: true }));
      }).pipe(
        Effect.provide(
          Layer.provideMerge(ActuatorRateLimitLive, Layer.merge(live(fetch), directory)),
        ),
      ),
    );
    expect(answer).toEqual({ _tag: "wait", retryAt: 4_102_444_800_000 });
  });

  it("[FD-GH-046] marks a secondary-rate-limit 403 as rate-limited and a permission 403 as not", async () => {
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

describe("shared installation quota", () => {
  /** `InstallationQuota` objects by name, each holding its ledger in memory, and the name each call reached. */
  const objects = () => {
    const ledgers = new Map<string, QuotaObject>();
    const reached: string[] = [];
    const objectOf = (name: string): QuotaObject => {
      reached.push(name);
      let object = ledgers.get(name);
      if (object === undefined) {
        let ledger: QuotaLedger = emptyQuotaLedger;
        object = quotaObjectOver(quotaOptionsDefault, {
          read: () => ledger,
          write: async (next) => {
            ledger = next;
          },
        });
        ledgers.set(name, object);
      }
      return object;
    };
    return { objectOf, reached };
  };

  /** One isolate's rate limit and quota: fresh services, so nothing it holds outlives the effect it runs. */
  const isolate =
    (objectOf: (name: string) => QuotaObject) =>
    <A, E>(effect: Effect.Effect<A, E, ActuatorRateLimit | InstallationQuota>) =>
      effect.pipe(
        Effect.provide(
          Layer.provideMerge(
            ActuatorRateLimitLive,
            Layer.merge(installationQuotaObjectLayer(objectOf), directory),
          ),
        ),
      );

  const atNow = <A, E>(effect: Effect.Effect<A, E>) =>
    Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(NOW);
        return yield* effect;
      }).pipe(Effect.provide(TestClock.layer())),
    );

  it("[FD-ARCH-003] applier calls in two isolates take their permits from the one InstallationQuota object of their installation", async () => {
    const { objectOf, reached } = objects();
    const a = isolate(objectOf);
    const b = isolate(objectOf);
    const result = await atNow(
      Effect.gen(function* () {
        const granted: string[] = [];
        for (let i = 0; i < 8; i++) {
          const answer = yield* a(acquire(permit({ limitKey: i % 2 === 0 ? "7" : "acme/app" })));
          if (answer._tag === "granted") granted.push(answer.permitId);
        }
        // The second isolate holds no state of its own: installation 7's object is at its concurrency bound.
        const ninth = yield* b(acquire(permit({ limitKey: "acme/app" })));
        const otherInstallation = (yield* b(acquire(permit({ limitKey: "8" }))))._tag;
        // A release from the first isolate frees the slot the second isolate asks for.
        yield* a(ActuatorRateLimit.use((l) => l.release(granted[0]!)));
        const afterRelease = (yield* b(acquire(permit({ limitKey: "7" }))))._tag;
        return { granted: granted.length, ninth, otherInstallation, afterRelease };
      }),
    );
    expect(result).toEqual({
      granted: 8,
      ninth: { _tag: "wait", retryAt: NOW + 1000 },
      otherInstallation: "granted",
      afterRelease: "granted",
    });
    // A row keyed by its repository reaches its installation's object; no object exists per repository.
    expect(new Set(reached)).toEqual(new Set(["7", "8"]));
  });

  it("[FD-ARCH-003] a response one isolate's client observes stops the next permit another isolate asks for", async () => {
    const { objectOf } = objects();
    const fetch: typeof globalThis.fetch = async () =>
      new Response(JSON.stringify({ id: 5 }), {
        status: 201,
        headers: {
          "content-type": "application/json",
          "x-ratelimit-limit": "100",
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": String((NOW + 600_000) / 1000),
        },
      });
    const writer = Layer.provideMerge(
      githubClientLayer({
        fetch,
        token: () => Effect.succeed("t"),
        baseUrl: "https://github.test",
      }),
      installationQuotaObjectLayer(objectOf),
    );
    const answers = await atNow(
      Effect.gen(function* () {
        const before = yield* isolate(objectOf)(acquire(permit({ limitKey: "acme/app" })));
        yield* GithubClient.use((github) =>
          github.createCheckRun({ installation: 7, repo: "acme/app", body: { name: "n" } }),
        ).pipe(Effect.provide(writer));
        const after = yield* isolate(objectOf)(acquire(permit({ limitKey: "acme/app" })));
        const share = yield* isolate(objectOf)(InstallationQuota.use((q) => q.remainingShare("7")));
        return { before: before._tag, after, share };
      }),
    );
    expect(answers).toEqual({
      before: "granted",
      after: { _tag: "wait", retryAt: NOW + 600_000 },
      share: 0,
    });
  });

  it("[FD-ARCH-003] an InstallationQuota object that cannot be reached grants nothing and reports no budget share", async () => {
    const unreachable = (): QuotaObject => {
      throw new Error("object unreachable");
    };
    const run = isolate(unreachable);
    const out = await atNow(
      Effect.gen(function* () {
        const answer = yield* run(acquire(permit({ drawsReserve: true })));
        const share = yield* run(
          InstallationQuota.use((q) => q.remainingShare("7")).pipe(Effect.flip),
        );
        // An observation or a release that does not arrive is logged; the drainer's run goes on.
        yield* run(observe("7", { remaining: 10 }));
        yield* run(ActuatorRateLimit.use((l) => l.release("7:1")));
        return { answer, share };
      }),
    );
    expect(out.answer).toEqual({ _tag: "wait", retryAt: NOW + 1000 });
    expect(out.share).toBeInstanceOf(QuotaUnavailable);
    expect(out.share).toMatchObject({ limitKey: "7" });
  });

  it("[FD-GH-063] MAMEKO-OUT-041 a permit no drainer released stops counting once the drainer's claim on its row has expired", async () => {
    const { objectOf } = objects();
    const run = isolate(objectOf);
    const out = await atNow(
      Effect.gen(function* () {
        for (let i = 0; i < 8; i++) yield* run(acquire(permit({ call: "lookup" })));
        const held = (yield* run(acquire(permit({ call: "lookup" }))))._tag;
        yield* TestClock.adjust(quotaOptionsDefault.permitLifetimeMs - 1);
        const before = (yield* run(acquire(permit({ call: "lookup" }))))._tag;
        yield* TestClock.adjust(1);
        const after = (yield* run(acquire(permit({ call: "lookup" }))))._tag;
        return { held, before, after };
      }),
    );
    expect(out).toEqual({ held: "wait", before: "wait", after: "granted" });
  });
});
