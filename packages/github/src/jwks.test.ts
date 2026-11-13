import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ACTIONS_JWKS, JwksSource, JwksSourceLive } from "./jwks.ts";

const ACCESS_JWKS = "https://team.cloudflareaccess.com/cdn-cgi/access/certs";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** Every URL the live source fetches; each fetch answers the keys `rotated` names for it, or none. */
const stubFetch = (rotated: Map<string, string>) => {
  const fetched: string[] = [];
  vi.stubGlobal("fetch", async (input: Request | string | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    fetched.push(url);
    const kid = rotated.get(url);
    return Response.json({ keys: kid === undefined ? [] : [{ kid, kty: "RSA" }] });
  });
  return fetched;
};

const kids = (reads: Effect.Effect<readonly { readonly kid?: string }[], unknown, JwksSource>) =>
  Effect.map(reads, (keys) => keys.map((k) => k.kid));

describe("JwksSourceLive", () => {
  it("[FD-INT-035] a fresh read of the Access keys does not hold back a fresh read of GitHub's rotated Actions keys", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse("2026-01-01T00:00:00Z"));
    const rotated = new Map([
      [ACTIONS_JWKS, "actions-1"],
      [ACCESS_JWKS, "access-1"],
    ]);
    const fetched = stubFetch(rotated);
    const answers = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const source = yield* JwksSource;
          yield* source.keys(ACTIONS_JWKS, { fresh: false });
          yield* source.keys(ACCESS_JWKS, { fresh: false });
          // GitHub rotates in a key; a token with an unknown kid reaches the Access gate first.
          rotated.set(ACTIONS_JWKS, "actions-2");
          vi.setSystemTime(Date.parse("2026-01-01T00:01:00Z"));
          const access = yield* kids(source.keys(ACCESS_JWKS, { fresh: true }));
          vi.setSystemTime(Date.parse("2026-01-01T00:01:05Z"));
          const actions = yield* kids(source.keys(ACTIONS_JWKS, { fresh: true }));
          return { access, actions };
        }),
        JwksSourceLive,
      ),
    );
    expect(answers).toEqual({ access: ["access-1"], actions: ["actions-2"] });
    expect(fetched).toEqual([ACTIONS_JWKS, ACCESS_JWKS, ACCESS_JWKS, ACTIONS_JWKS]);
  });

  it("a second fresh read of the same URL within 30 s answers the keys the first one fetched", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse("2026-01-01T00:00:00Z"));
    const rotated = new Map([[ACTIONS_JWKS, "actions-1"]]);
    const fetched = stubFetch(rotated);
    const answers = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const source = yield* JwksSource;
          const first = yield* kids(source.keys(ACTIONS_JWKS, { fresh: true }));
          rotated.set(ACTIONS_JWKS, "actions-2");
          vi.setSystemTime(Date.parse("2026-01-01T00:00:20Z"));
          const within = yield* kids(source.keys(ACTIONS_JWKS, { fresh: true }));
          vi.setSystemTime(Date.parse("2026-01-01T00:00:31Z"));
          const after = yield* kids(source.keys(ACTIONS_JWKS, { fresh: true }));
          return [first, within, after];
        }),
        JwksSourceLive,
      ),
    );
    expect(answers).toEqual([["actions-1"], ["actions-1"], ["actions-2"]]);
    expect(fetched).toEqual([ACTIONS_JWKS, ACTIONS_JWKS]);
  });
});
