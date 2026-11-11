// The App's authority over an in-memory GitHub reached through `fetch`: the JWT, both PEM encodings, the token cache,
// eviction, the per-lease token and the reads.
import { generateKeyPairSync, createPublicKey, verify } from "node:crypto";
import { AlarmPort, CredentialMinter } from "@fractalboxdev/mameko-ports";
import { Effect, Exit, Layer, Logger } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";
import {
  APP_LIST_MAX_PAGES,
  GithubApp,
  githubAppLayer,
  LEASE_READ_PERMISSIONS,
  listAppDeliveries,
  listAppInstallations,
  nextPagePath,
  readAppInstallation,
} from "./app.ts";
import { fakeConcludeFacts, fakeGithub } from "./fake.test-support.ts";
import { githubLiveLayer } from "./layer.ts";
import { leaseReadToken } from "./lease-token.ts";
import { GithubRead, refPatternMatches } from "./read.ts";
import { SideOutputConfig } from "./side-ports.ts";

const NOW = 1_800_000_000_000;
const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PKCS1 = pair.privateKey.export({ type: "pkcs1", format: "pem" }).toString();
const PKCS8 = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const PUBLIC = createPublicKey(pair.privateKey);

interface Call {
  readonly method: string;
  readonly path: string;
  readonly authorization: string;
  readonly body: unknown;
}

/** A GitHub that answers the App and read endpoints from fixed tables and records every call. */
const fakeApi = (
  routes: Record<
    string,
    (call: Call) => { status: number; body: unknown; headers?: Record<string, string> }
  >,
  calls: Call[],
): typeof fetch =>
  (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const path = url.pathname + url.search;
    const call: Call = {
      method,
      path,
      authorization: new Headers(init?.headers).get("authorization") ?? "",
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    };
    calls.push(call);
    const route = routes[`${method} ${url.pathname}`];
    const { status, body, headers } =
      route === undefined
        ? { status: 404, body: { message: "Not Found" }, headers: undefined }
        : route(call);
    const responseInit = headers === undefined ? { status } : { status, headers };
    return status === 204 ? new Response(null, responseInit) : Response.json(body, responseInit);
  }) as typeof fetch;

let minted = 0;
const tokenRoute = (expiresInMs: number) => () => {
  minted++;
  return {
    status: 201,
    body: { token: `ghs_${minted}`, expires_at: new Date(NOW + expiresInMs).toISOString() },
  };
};

const decodeSegment = (s: string) =>
  JSON.parse(
    Buffer.from(s.replaceAll("-", "+").replaceAll("_", "/"), "base64").toString(),
  ) as Record<string, unknown>;

const run = <A, E>(
  effect: Effect.Effect<A, E, GithubApp>,
  fetch: typeof globalThis.fetch,
  pem = PKCS8,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      return yield* effect;
    }).pipe(
      Effect.provide(githubAppLayer({ appId: "123", privateKeyPem: pem, fetch })),
      Effect.provide(TestClock.layer()),
    ),
  );

describe("the App JWT", () => {
  for (const [encoding, pem] of [
    ["PKCS#1", PKCS1],
    ["PKCS#8", PKCS8],
  ] as const)
    it(`[FD-GH-067] [FD-GH-068] a ${encoding} key signs an RS256 JWT with iat 60 s back and exp 600 s after iat`, async () => {
      const jwt = await run(
        GithubApp.use((a) => a.jwt),
        fakeApi({}, []),
        pem,
      );
      const [header, payload, signature] = jwt.split(".");
      expect(decodeSegment(header!)).toEqual({ alg: "RS256", typ: "JWT" });
      const claims = decodeSegment(payload!);
      expect(claims.iat).toBe(NOW / 1000 - 60);
      expect(Number(claims.exp) - Number(claims.iat)).toBe(600);
      expect(claims.iss).toBe("123");
      const ok = verify(
        "RSA-SHA256",
        Buffer.from(`${header}.${payload}`),
        PUBLIC,
        Buffer.from(signature!.replaceAll("-", "+").replaceAll("_", "/"), "base64"),
      );
      expect(ok).toBe(true);
    });

  it("[FD-GH-068] a PEM of another type fails AppKeyInvalid", async () => {
    const pem = "-----BEGIN EC PRIVATE KEY-----\nAAAA\n-----END EC PRIVATE KEY-----";
    const exit = await Effect.runPromise(
      Effect.exit(GithubApp.use((a) => a.jwt)).pipe(
        Effect.provide(githubAppLayer({ appId: "1", privateKeyPem: pem, fetch: fakeApi({}, []) })),
      ),
    );
    expect(JSON.stringify(exit)).toContain("AppKeyInvalid");
  });
});

describe("installation tokens", () => {
  it("[FD-GH-065] caches a token and mints anew within 60 s of its expires_at", async () => {
    const calls: Call[] = [];
    const fetch = fakeApi(
      { "POST /app/installations/7/access_tokens": tokenRoute(3_600_000) },
      calls,
    );
    const tokens = await run(
      Effect.gen(function* () {
        const app = yield* GithubApp;
        const first = yield* app.token(7);
        const cached = yield* app.token(7);
        yield* TestClock.adjust("3539 seconds");
        const stillCached = yield* app.token(7);
        yield* TestClock.adjust("2 seconds");
        const renewed = yield* app.token(7);
        const forced = yield* app.token(7, { fresh: true });
        return [first, cached, stillCached, renewed, forced].map((t) => t.token);
      }),
      fetch,
    );
    expect(tokens[0]).toBe(tokens[1]);
    expect(tokens[2]).toBe(tokens[0]);
    expect(tokens[3]).not.toBe(tokens[0]);
    expect(tokens[4]).not.toBe(tokens[3]);
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(3);
    expect(calls[0]!.authorization).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
  });

  it("[FD-GH-066] evicting an installation drops its token and its repository mappings", async () => {
    const calls: Call[] = [];
    const fetch = fakeApi(
      {
        "POST /app/installations/7/access_tokens": tokenRoute(3_600_000),
        "GET /repos/acme/app/installation": () => ({ status: 200, body: { id: 7 } }),
        "GET /repos/acme/lib/installation": () => ({ status: 200, body: { id: 7 } }),
      },
      calls,
    );
    await run(
      Effect.gen(function* () {
        const app = yield* GithubApp;
        yield* app.token(7);
        yield* app.installationFor("acme/app");
        yield* app.installationFor("Acme/App");
        yield* app.installationFor("acme/lib");
        yield* app.evictRepositories(["acme/lib"]);
        yield* app.installationFor("acme/app");
        yield* app.installationFor("acme/lib");
        yield* app.evictInstallation(7);
        yield* app.token(7);
        yield* app.installationFor("acme/app");
      }),
      fetch,
    );
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "POST /app/installations/7/access_tokens",
      "GET /repos/acme/app/installation",
      "GET /repos/acme/lib/installation",
      "GET /repos/acme/lib/installation",
      "POST /app/installations/7/access_tokens",
      "GET /repos/acme/app/installation",
    ]);
  });

  it("[FD-INT-043] a repository the App does not cover maps to no installation", async () => {
    const id = await run(
      GithubApp.use((a) => a.installationFor("acme/none")),
      fakeApi({}, []),
    );
    expect(id).toBeNull();
  });
});

const alarms = Layer.mergeAll(
  Layer.succeed(AlarmPort, { deliver: () => Effect.void }),
  fakeConcludeFacts(fakeGithub()),
  Layer.succeed(SideOutputConfig, {
    appBot: { login: "flare-dispatch[bot]", name: "flare-dispatch[bot]", email: "bot@example.com" },
    slack: undefined,
    fetch: globalThis.fetch,
  }),
);

const live = <A, E>(
  effect: Effect.Effect<A, E, GithubApp | GithubRead | CredentialMinter>,
  routes: Parameters<typeof fakeApi>[0],
  calls: Call[] = [],
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      return yield* effect;
    }).pipe(
      Effect.provide(
        githubLiveLayer({ appId: "123", privateKeyPem: PKCS1, fetch: fakeApi(routes, calls) }).pipe(
          Layer.provide(alarms),
        ),
      ),
      Effect.provide(TestClock.layer()),
    ),
  );

const covered = {
  "GET /repos/acme/app/installation": () => ({ status: 200, body: { id: 7 } }),
  "POST /app/installations/7/access_tokens": tokenRoute(3_600_000),
};

describe("the per-lease token", () => {
  it("[FD-GH-002] scopes the token to the one repository and to read permissions, expiring by the deadline", async () => {
    const calls: Call[] = [];
    const credential = await live(
      leaseReadToken({
        executionId: "e1",
        epoch: 1,
        scopeId: "acme/app",
        deadlineAt: NOW + 600_000,
      }),
      covered,
      calls,
    );
    const mint = calls.find((c) => c.method === "POST")!;
    expect(mint.body).toEqual({ repositories: ["app"], permissions: LEASE_READ_PERMISSIONS });
    expect(Object.values(LEASE_READ_PERMISSIONS).every((p) => p === "read")).toBe(true);
    expect(credential.expiresAt).toBe(NOW + 600_000);
  });

  const lease = (executionId: string, deadlineAt = NOW + 600_000) => ({
    executionId,
    epoch: 2,
    scopeId: "acme/app",
    deadlineAt,
  });

  it("[FD-GH-002] the credential minter port mints the per-lease read token for the lease's one repository", async () => {
    const calls: Call[] = [];
    const credential = await live(
      CredentialMinter.use((m) => m.mint("source-read", lease("e1", NOW + 7_200_000))),
      covered,
      calls,
    );
    const mints = calls.filter((c) => c.method === "POST");
    expect(mints.map((c) => c.path)).toEqual(["/app/installations/7/access_tokens"]);
    expect(mints[0]!.body).toEqual({
      repositories: ["app"],
      permissions: {
        metadata: "read",
        contents: "read",
        pull_requests: "read",
        issues: "read",
        checks: "read",
        actions: "read",
      },
    });
    expect(credential.credential).toMatch(/^ghs_/);
    // GitHub's own expiry comes first here: the token lives an hour, the lease two.
    expect(credential.expiresAt).toBe(NOW + 3_600_000);
  });

  it("revokes every token the port minted for the lease, and no other lease's (MAMEKO-HOST-050)", async () => {
    const calls: Call[] = [];
    const [first, second, other] = await live(
      Effect.gen(function* () {
        const minter = yield* CredentialMinter;
        const first = yield* minter.mint("source-read", lease("e1"));
        const second = yield* minter.mint("source-read", lease("e1"));
        const other = yield* minter.mint("source-read", lease("e2"));
        yield* minter.revoke(lease("e1"));
        // A second revoke has nothing left to revoke.
        yield* minter.revoke(lease("e1"));
        return [first, second, other];
      }),
      { ...covered, "DELETE /installation/token": () => ({ status: 204, body: null }) },
      calls,
    );
    const revoked = calls.filter((c) => c.method === "DELETE");
    expect(revoked.map((c) => c.path)).toEqual(["/installation/token", "/installation/token"]);
    expect(revoked.map((c) => c.authorization)).toEqual([
      `Bearer ${first.credential}`,
      `Bearer ${second.credential}`,
    ]);
    expect(revoked.map((c) => c.authorization)).not.toContain(`Bearer ${other.credential}`);
  });

  it("a mint for a grant other than the source grant fails and asks GitHub for no token", async () => {
    const calls: Call[] = [];
    const exit = await live(
      CredentialMinter.use((m) => m.mint("model-gateway", lease("e1"))).pipe(Effect.exit),
      covered,
      calls,
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(String(Exit.isFailure(exit) && exit.cause)).toContain("model-gateway");
    expect(calls.filter((c) => c.method === "POST")).toEqual([]);
  });

  it("the profile's git-remote grant is the source grant and gets the per-lease read token", async () => {
    const calls: Call[] = [];
    const credential = await live(
      CredentialMinter.use((m) => m.mint("git-remote", lease("e1"))),
      covered,
      calls,
    );
    expect(credential.credential).toMatch(/^ghs_/);
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });

  /** Runs `effect` with every log entry's message parts recorded in `logs`. */
  const logged = <A, E, R>(effect: Effect.Effect<A, E, R>, logs: unknown[][]) =>
    effect.pipe(
      Effect.provide(
        Layer.succeed(
          Logger.CurrentLoggers,
          new Set([
            Logger.make((o) => void logs.push(Array.isArray(o.message) ? o.message : [o.message])),
          ]),
        ),
      ),
    );

  it("a revoke GitHub refuses is logged with its status and does not fail", async () => {
    const calls: Call[] = [];
    const logs: unknown[][] = [];
    await live(
      logged(
        Effect.gen(function* () {
          const minter = yield* CredentialMinter;
          yield* minter.mint("source-read", lease("e1"));
          yield* minter.revoke(lease("e1"));
        }),
        logs,
      ),
      {
        ...covered,
        "DELETE /installation/token": () => ({ status: 502, body: { message: "Bad Gateway" } }),
      },
      calls,
    );
    expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(1);
    expect(logs).toContainEqual([
      "per-lease token not revoked",
      { executionId: "e1", status: 502 },
    ]);
  });

  it("a revoke for a lease this isolate holds no token for is logged, since the token outlives it", async () => {
    const calls: Call[] = [];
    const logs: unknown[][] = [];
    await live(
      logged(
        CredentialMinter.use((m) => m.revoke(lease("e9"))),
        logs,
      ),
      covered,
      calls,
    );
    expect(calls.filter((c) => c.method === "DELETE")).toEqual([]);
    expect(logs).toContainEqual([
      "per-lease token not held by this isolate; valid until GitHub expires_at",
      { executionId: "e9", epoch: 2 },
    ]);
  });

  it("a mint drops the held tokens of leases past their deadline", async () => {
    const calls: Call[] = [];
    const logs: unknown[][] = [];
    await live(
      logged(
        Effect.gen(function* () {
          const minter = yield* CredentialMinter;
          // e1's deadline is already past when e2 mints, so e2's mint drops e1's token.
          yield* minter.mint("source-read", lease("e1", NOW - 1));
          yield* minter.mint("source-read", lease("e2"));
          yield* minter.revoke(lease("e1"));
        }),
        logs,
      ),
      { ...covered, "DELETE /installation/token": () => ({ status: 204, body: null }) },
      calls,
    );
    expect(calls.filter((c) => c.method === "DELETE")).toEqual([]);
    expect(logs.map((l) => l[0])).toContain(
      "per-lease token not held by this isolate; valid until GitHub expires_at",
    );
  });

  it("a mint for a repository no installation covers fails the grant rather than answer no credential", async () => {
    const calls: Call[] = [];
    const exit = await live(
      CredentialMinter.use((m) =>
        m.mint("source-read", { ...lease("e1"), scopeId: "acme/none" }),
      ).pipe(Effect.exit),
      covered,
      calls,
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET /repos/acme/none/installation",
    ]);
  });
});

describe("GithubRead", () => {
  it("[FD-GH-003] a read for a repository with no installation fails GithubUncredentialed, never empty", async () => {
    const result = await live(
      GithubRead.use((r) => r.openPulls("acme/none")).pipe(
        Effect.match({ onFailure: (e) => e._tag, onSuccess: (v) => v }),
      ),
      covered,
    );
    expect(result).toBe("GithubUncredentialed");
  });

  it("[FD-INT-016] reads a file at a ref as text, and a missing path as null", async () => {
    const content = Buffer.from('{"version":1}').toString("base64");
    const calls: Call[] = [];
    const [found, missing] = await live(
      Effect.gen(function* () {
        const read = yield* GithubRead;
        return [
          yield* read.file("acme/app", ".github/flare-dispatch.json", "abc"),
          yield* read.file("acme/app", ".github/other.json", "abc"),
        ];
      }),
      {
        ...covered,
        "GET /repos/acme/app/contents/.github/flare-dispatch.json": () => ({
          status: 200,
          body: { type: "file", size: 13, encoding: "base64", content },
        }),
      },
      calls,
    );
    expect(found).toEqual({ size: 13, text: '{"version":1}' });
    expect(missing).toBeNull();
    expect(
      calls.some((c) => c.path === "/repos/acme/app/contents/.github/flare-dispatch.json?ref=abc"),
    ).toBe(true);
  });

  it("[FD-INT-032] the required set is the union of ruleset and branch-protection checks", async () => {
    const checks = await live(
      GithubRead.use((r) => r.requiredChecks("acme/app", "main")),
      {
        ...covered,
        "GET /repos/acme/app/rules/branches/main": () => ({
          status: 200,
          body: [
            { type: "pull_request" },
            {
              type: "required_status_checks",
              parameters: { required_status_checks: [{ context: "flare-dispatch/check:ci" }] },
            },
          ],
        }),
        "GET /repos/acme/app/branches/main/protection/required_status_checks": () => ({
          status: 200,
          body: { contexts: ["lint"], checks: [{ context: "flare-dispatch/check:ci" }] },
        }),
      },
    );
    expect(checks).toEqual(["flare-dispatch/check:ci", "lint"]);
  });

  it("[FD-CACHE-017] a branch is protected by any rule that targets it or by branch protection", async () => {
    const protectedRef = (routes: Parameters<typeof fakeApi>[0], ref: string) =>
      live(
        GithubRead.use((r) => r.refProtected("acme/app", ref)),
        { ...covered, ...routes },
      );
    const ruled = await protectedRef(
      {
        "GET /repos/acme/app/rules/branches/release/2": () => ({
          status: 200,
          body: [{ type: "non_fast_forward" }],
        }),
      },
      "refs/heads/release/2",
    );
    const classic = await protectedRef(
      {
        "GET /repos/acme/app/rules/branches/main": () => ({ status: 200, body: [] }),
        "GET /repos/acme/app/branches/main": () => ({
          status: 200,
          body: { protected: true, commit: { sha: "a".repeat(40) } },
        }),
      },
      "refs/heads/main",
    );
    const open = await protectedRef(
      {
        "GET /repos/acme/app/rules/branches/feature": () => ({ status: 200, body: [] }),
        "GET /repos/acme/app/branches/feature": () => ({
          status: 200,
          body: { protected: false, commit: { sha: "a".repeat(40) } },
        }),
      },
      "refs/heads/feature",
    );
    const deleted = await protectedRef(
      { "GET /repos/acme/app/rules/branches/gone": () => ({ status: 200, body: [] }) },
      "refs/heads/gone",
    );
    expect([ruled, classic, open, deleted]).toEqual([true, true, false, false]);
  });

  it("[FD-PROF-012] a tag is protected only by an active tag ruleset with a rule whose conditions name it", async () => {
    const rulesets = {
      "GET /repos/acme/app/rulesets": () => ({
        status: 200,
        body: [
          { id: 1, target: "tag", enforcement: "active" },
          { id: 2, target: "tag", enforcement: "evaluate" },
        ],
      }),
      "GET /repos/acme/app/rulesets/1": () => ({
        status: 200,
        body: {
          enforcement: "active",
          conditions: { ref_name: { include: ["refs/tags/v*"], exclude: ["refs/tags/v0*"] } },
          rules: [{ type: "deletion" }, { type: "update" }],
        },
      }),
      "GET /repos/acme/app/rulesets/2": () => ({
        status: 200,
        body: {
          enforcement: "evaluate",
          conditions: { ref_name: { include: ["~ALL"], exclude: [] } },
          rules: [{ type: "deletion" }],
        },
      }),
    };
    const calls: Call[] = [];
    const answers = await Promise.all(
      ["refs/tags/v1.2.0", "refs/tags/v0.9.0", "refs/tags/nightly"].map((ref) =>
        live(
          GithubRead.use((r) => r.refProtected("acme/app", ref)),
          { ...covered, ...rulesets },
          calls,
        ),
      ),
    );
    expect(answers).toEqual([true, false, false]);
    expect(calls.some((c) => c.path.includes("/rulesets/2"))).toBe(false);
    expect(
      calls.some(
        (c) => c.path === "/repos/acme/app/rulesets?targets=tag&includes_parents=true&per_page=100",
      ),
    ).toBe(true);
  });

  it("[FD-PROF-012] a ruleset ref pattern spans / only with **, and ~ALL names every ref", () => {
    expect(refPatternMatches("refs/tags/v*", "refs/tags/v1.2.0")).toBe(true);
    expect(refPatternMatches("refs/tags/v*", "refs/tags/v1/rc")).toBe(false);
    expect(refPatternMatches("refs/tags/**", "refs/tags/v1/rc")).toBe(true);
    expect(refPatternMatches("v?", "refs/tags/v1")).toBe(true);
    expect(refPatternMatches("~ALL", "refs/tags/anything")).toBe(true);
    expect(refPatternMatches("~DEFAULT_BRANCH", "refs/tags/main")).toBe(false);
    expect(refPatternMatches("refs/tags/v1.0", "refs/tags/v1x0")).toBe(false);
  });

  it("[FD-OPS-029] every ruleset and branch-protection request is a GET", async () => {
    const calls: Call[] = [];
    const routes = {
      ...covered,
      "GET /repos/acme/app/rules/branches/main": () => ({
        status: 200,
        body: [
          {
            type: "required_status_checks",
            parameters: { required_status_checks: [{ context: "flare-dispatch/check:ci" }] },
          },
        ],
      }),
      "GET /repos/acme/app/branches/main/protection/required_status_checks": () => ({
        status: 200,
        body: { contexts: ["lint"] },
      }),
      "GET /repos/acme/app/rules/branches/feature": () => ({ status: 200, body: [] }),
      "GET /repos/acme/app/branches/feature": () => ({
        status: 200,
        body: { protected: false, commit: { sha: "a".repeat(40) } },
      }),
      "GET /repos/acme/app/rulesets": () => ({
        status: 200,
        body: [{ id: 1, target: "tag", enforcement: "active" }],
      }),
      "GET /repos/acme/app/rulesets/1": () => ({
        status: 200,
        body: {
          enforcement: "active",
          conditions: { ref_name: { include: ["refs/tags/v*"], exclude: [] } },
          rules: [{ type: "deletion" }],
        },
      }),
    };
    await live(
      Effect.gen(function* () {
        const read = yield* GithubRead;
        yield* read.requiredChecks("acme/app", "main");
        yield* read.refProtected("acme/app", "refs/heads/main");
        yield* read.refProtected("acme/app", "refs/heads/feature");
        yield* read.refProtected("acme/app", "refs/tags/v1.0.0");
      }),
      routes,
      calls,
    );
    const ruleCalls = calls.filter((c) => /\/(rules|rulesets|protection)(\/|\?|$)/.test(c.path));
    expect(ruleCalls.map((c) => c.path.split("?")[0])).toEqual(
      expect.arrayContaining([
        "/repos/acme/app/rules/branches/main",
        "/repos/acme/app/branches/main/protection/required_status_checks",
        "/repos/acme/app/rulesets",
        "/repos/acme/app/rulesets/1",
      ]),
    );
    expect(ruleCalls.every((c) => c.method === "GET" && c.body === undefined)).toBe(true);
  });
});

describe("the probes' App-JWT reads", () => {
  const installationRoute = () => ({
    "GET /app/installations/1": () => ({
      status: 200,
      body: { id: 1, account: { login: "acme" }, suspended_at: null },
    }),
    "GET /app/installations/2": () => ({
      status: 200,
      body: { id: 2, account: { login: "globex" }, suspended_at: "2026-11-01T00:00:00Z" },
    }),
    "GET /app/installations/5": () => ({ status: 500, body: { message: "boom" } }),
  });

  it("[FD-OPS-041] [FD-OPS-042] reads an installation through GET /app/installations/{id} under the App JWT: active, suspended or a 404", async () => {
    const calls: Call[] = [];
    const reads = await run(
      Effect.gen(function* () {
        const app = yield* GithubApp;
        return [
          yield* readAppInstallation(app, "1"),
          yield* readAppInstallation(app, "2"),
          yield* readAppInstallation(app, "3"),
        ];
      }),
      fakeApi(installationRoute(), calls),
    );
    expect(reads).toEqual([
      { status: "active", accountLogin: "acme" },
      { status: "suspended", accountLogin: "globex" },
      { status: "not-found" },
    ]);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET /app/installations/1",
      "GET /app/installations/2",
      "GET /app/installations/3",
    ]);
    // The App JWT, not an installation token: three dot-separated segments with the App as issuer.
    for (const c of calls) {
      const [, payload] = c.authorization.replace(/^Bearer /, "").split(".");
      expect(decodeSegment(payload!).iss).toBe("123");
    }
  });

  it("[FD-OPS-042] an installation read that answers neither 2xx nor 404 fails instead of reading lost", async () => {
    const exit = await run(
      Effect.exit(GithubApp.use((app) => readAppInstallation(app, "5"))),
      fakeApi(installationRoute(), []),
    );
    expect(JSON.stringify(exit)).toContain("GithubHttpError");
  });

  it("[FD-OPS-041] lists the App's installations with their account logins", async () => {
    const listed = await run(
      GithubApp.use((app) => listAppInstallations(app)),
      fakeApi(
        {
          "GET /app/installations": () => ({
            status: 200,
            body: [
              { id: 1, account: { login: "acme" }, suspended_at: null },
              { id: 2, account: null },
            ],
          }),
        },
        [],
      ),
    );
    expect(listed).toEqual([
      { installationId: "1", accountLogin: "acme" },
      { installationId: "2", accountLogin: "" },
    ]);
  });

  const delivery = (id: number, at: number, status_code: number, guid = `g${id}`) => ({
    id,
    guid,
    delivered_at: new Date(at).toISOString(),
    redelivery: false,
    status_code,
    status: status_code === 200 ? "OK" : "failed",
    event: "push",
  });

  it("[FD-OPS-044] lists the deliveries since a time through GET /app/hook/deliveries, following the cursor until a page reaches back past it", async () => {
    const calls: Call[] = [];
    const since = NOW - 900_000;
    const fetch = fakeApi(
      {
        "GET /app/hook/deliveries": (call) =>
          call.path.includes("cursor=p2")
            ? {
                status: 200,
                body: [delivery(3, NOW - 600_000, 200), delivery(2, NOW - 1_200_000, 200)],
                headers: {
                  link: '<https://api.github.com/app/hook/deliveries?per_page=100&cursor=p3>; rel="next"',
                },
              }
            : {
                status: 200,
                body: [delivery(5, NOW - 60_000, 502), delivery(4, NOW - 120_000, 200)],
                headers: {
                  link: '<https://api.github.com/app/hook/deliveries?per_page=100&cursor=p2>; rel="next"',
                },
              },
      },
      calls,
    );
    const listed = await run(
      GithubApp.use((app) => listAppDeliveries(app, since)),
      fetch,
    );
    expect(listed).toEqual([
      { id: 5, guid: "g5", statusCode: 502, deliveredAt: NOW - 60_000, redelivery: false },
      { id: 4, guid: "g4", statusCode: 200, deliveredAt: NOW - 120_000, redelivery: false },
      { id: 3, guid: "g3", statusCode: 200, deliveredAt: NOW - 600_000, redelivery: false },
    ]);
    // The second page reached back past `since`, so its next page is never read.
    expect(calls.map((c) => c.path)).toEqual([
      "/app/hook/deliveries?per_page=100",
      "/app/hook/deliveries?per_page=100&cursor=p2",
    ]);
  });

  it("[FD-OPS-044] a listing reads at most its page bound", async () => {
    const calls: Call[] = [];
    let n = 0;
    const fetch = fakeApi(
      {
        "GET /app/hook/deliveries": () => ({
          status: 200,
          body: [delivery(++n, NOW, 200)],
          headers: {
            link: `<https://api.github.com/app/hook/deliveries?per_page=100&cursor=p${n + 1}>; rel="next"`,
          },
        }),
      },
      calls,
    );
    await run(
      GithubApp.use((app) => listAppDeliveries(app, NOW - 900_000)),
      fetch,
    );
    expect(calls).toHaveLength(APP_LIST_MAX_PAGES);
  });

  it("names the next page of a Link header, and none on the last page", () => {
    expect(
      nextPagePath(
        '<https://api.github.com/app/hook/deliveries?cursor=a>; rel="prev", <https://api.github.com/app/hook/deliveries?cursor=b>; rel="next"',
      ),
    ).toBe("/app/hook/deliveries?cursor=b");
    expect(nextPagePath(null)).toBeNull();
  });
});
