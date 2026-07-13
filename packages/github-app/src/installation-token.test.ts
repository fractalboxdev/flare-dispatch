// Unit tests for the installation-token exchange + in-memory cache.
//
// Mocks `api.github.com` with MSW and asserts: (a) a cold call exchanges the
// App JWT for an installation token; (b) a second call within TTL is served
// from the in-memory cache — no second HTTP request; (c) `forceRefresh`
// bypasses the cache; (d) a non-2xx response surfaces a GithubApiError.

import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TEST_APP_PRIVATE_KEY } from "./__fixtures__/test-key";
import { GithubApiError } from "./errors";
import { __clearTokenCache, getInstallationToken } from "./installation-token";

/** Counts how many times the access_tokens endpoint was actually hit. */
let exchangeCount = 0;

const server = setupServer(
  http.post(
    "https://api.github.com/app/installations/:id/access_tokens",
    () => {
      exchangeCount += 1;
      return HttpResponse.json({
        token: `ghs_token_${exchangeCount}`,
        // ~1h out — comfortably inside the cache's freshness margin.
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      });
    },
  ),
);

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

beforeEach(() => {
  exchangeCount = 0;
  __clearTokenCache();
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
      http.post(
        "https://api.github.com/app/installations/:id/access_tokens",
        () => HttpResponse.json({ message: "Bad credentials" }, { status: 401 }),
      ),
    );
    await expect(getInstallationToken(baseOpts)).rejects.toBeInstanceOf(
      GithubApiError,
    );
  });
});
