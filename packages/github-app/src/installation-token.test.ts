// Unit tests for the installation-token exchange + in-memory cache, and for the
// repo→installation lookup that lets a caller resolve its own installation.
//
// Mocks `api.github.com` with MSW and asserts: (a) a cold call exchanges the
// App JWT for an installation token; (b) a second call within TTL is served
// from the in-memory cache — no second HTTP request; (c) `forceRefresh`
// bypasses the cache; (d) a non-2xx response surfaces a GithubApiError; and for
// `resolveRepoInstallationId`, that a repo resolves to its installation, that
// the lookup is cached per repo, and that "the App is not installed here" (404)
// stays a distinguishable `GithubApiError` for the caller to classify.

import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TEST_APP_PRIVATE_KEY } from "./__fixtures__/test-key";
import { GithubApiError } from "./errors";
import {
  __clearRepoInstallationCache,
  __clearTokenCache,
  getInstallationToken,
  resolveRepoInstallationId,
} from "./installation-token";

/** Counts how many times the access_tokens endpoint was actually hit. */
let exchangeCount = 0;
/** Every repo the installation lookup was issued for, in order. */
let installationLookups: string[] = [];

const server = setupServer(
  http.post("https://api.github.com/app/installations/:id/access_tokens", () => {
    exchangeCount += 1;
    return HttpResponse.json({
      token: `ghs_token_${exchangeCount}`,
      // ~1h out — comfortably inside the cache's freshness margin.
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    });
  }),
  http.get("https://api.github.com/repos/:owner/:repo/installation", ({ params }) => {
    installationLookups.push(`${params.owner}/${params.repo}`);
    return HttpResponse.json({ id: 4242 });
  }),
);

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

beforeEach(() => {
  exchangeCount = 0;
  installationLookups = [];
  __clearTokenCache();
  __clearRepoInstallationCache();
});

const baseOpts = {
  appId: 42,
  privateKeyPem: TEST_APP_PRIVATE_KEY,
  installationId: 12345,
} as const;

describe("getInstallationToken", () => {
  it("exchanges the App JWT for an installation token on a cold call", async () => {
    const token = await getInstallationToken(baseOpts);
    expect(token).toBe("ghs_token_1");
    expect(exchangeCount).toBe(1);
  });

  it("serves a second call within TTL from the in-memory cache", async () => {
    const first = await getInstallationToken(baseOpts);
    const second = await getInstallationToken(baseOpts);
    // Same token, and the endpoint was hit exactly once — the cache absorbed
    // the second call.
    expect(second).toBe(first);
    expect(exchangeCount).toBe(1);
  });

  it("does a fresh exchange for a different installation id", async () => {
    await getInstallationToken(baseOpts);
    await getInstallationToken({ ...baseOpts, installationId: 99999 });
    // Cache is keyed per-installation — two ids, two exchanges.
    expect(exchangeCount).toBe(2);
  });

  it("bypasses the cache when forceRefresh is set", async () => {
    await getInstallationToken(baseOpts);
    const refreshed = await getInstallationToken({
      ...baseOpts,
      forceRefresh: true,
    });
    expect(refreshed).toBe("ghs_token_2");
    expect(exchangeCount).toBe(2);
  });

  it("surfaces a GithubApiError on a non-2xx response", async () => {
    server.use(
      http.post("https://api.github.com/app/installations/:id/access_tokens", () =>
        HttpResponse.json({ message: "Bad credentials" }, { status: 401 }),
      ),
    );
    await expect(getInstallationToken(baseOpts)).rejects.toBeInstanceOf(GithubApiError);
  });
});

const resolveOpts = {
  appId: 42,
  privateKeyPem: TEST_APP_PRIVATE_KEY,
  repo: "acme/widget",
} as const;

describe("resolveRepoInstallationId", () => {
  it("resolves a repo's installation from the App JWT", async () => {
    expect(await resolveRepoInstallationId(resolveOpts)).toBe(4242);
    expect(installationLookups).toEqual(["acme/widget"]);
  });

  it("serves a repeat lookup from the in-memory cache", async () => {
    await resolveRepoInstallationId(resolveOpts);
    await resolveRepoInstallationId(resolveOpts);
    // Installations are stable, so a sweep that touches one repo repeatedly
    // pays a single lookup per Worker isolate.
    expect(installationLookups).toEqual(["acme/widget"]);
  });

  it("looks up each repo separately — the cache is keyed per repo", async () => {
    await resolveRepoInstallationId(resolveOpts);
    await resolveRepoInstallationId({ ...resolveOpts, repo: "other-org/gadget" });
    expect(installationLookups).toEqual(["acme/widget", "other-org/gadget"]);
  });

  it("surfaces a 404 as a GithubApiError — the App is not installed on this repo", async () => {
    server.use(
      http.get("https://api.github.com/repos/:owner/:repo/installation", () =>
        HttpResponse.json({ message: "Not Found" }, { status: 404 }),
      ),
    );
    // The status is what lets a caller say "no installation for <repo>" instead
    // of reporting a generic API failure.
    await expect(resolveRepoInstallationId(resolveOpts)).rejects.toMatchObject({
      name: "GithubApiError",
      status: 404,
    });
  });

  it("does not cache a failed lookup", async () => {
    server.use(
      http.get("https://api.github.com/repos/:owner/:repo/installation", () =>
        HttpResponse.json({ message: "Server Error" }, { status: 500 }),
      ),
    );
    await expect(resolveRepoInstallationId(resolveOpts)).rejects.toBeInstanceOf(GithubApiError);

    // A transient failure must not poison the repo for the isolate's lifetime.
    server.resetHandlers();
    expect(await resolveRepoInstallationId(resolveOpts)).toBe(4242);
  });
});
