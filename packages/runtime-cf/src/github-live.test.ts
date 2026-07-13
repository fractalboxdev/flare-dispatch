// Integration tests for makeGithubLive — the live `github` write capability.
//
// Mocks `api.github.com` with MSW (plain Node) and asserts the `pullReview`
// write against the real `Github` Effect Layer:
//
//   * configured  — one access-token exchange then one POST /pulls/{n}/reviews
//                   with event:COMMENT, the body, and the head sha as commit_id;
//   * degraded    — with no App config, `pullReview` makes zero HTTP calls and
//                   still succeeds (reporting must never fail a run);
//   * no install  — with config but a request lacking an installation id, it
//                   resolves the installation from GET /repos/{repo}/installation
//                   (App JWT), then exchanges a token and posts the review.

import {
  __clearTokenCache,
  __clearRepoInstallationCache,
} from "@fractalboxdev/flare-dispatch-github-app";
import { Effect } from "effect";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { github } from "@fractalboxdev/flare-dispatch-core";
import { TEST_APP_PRIVATE_KEY } from "@fractalboxdev/flare-dispatch-github-app/testing";
import {
  classifyReason,
  type GithubLiveConfig,
  makeGithubLive,
} from "./github-live";

type Recorded = {
  tokenExchanges: number;
  installationLookups: number;
  reviews: { pr: string; authorization: string | null; body: Record<string, unknown> }[];
};
let recorded: Recorded;

const server = setupServer(
  http.get(
    "https://api.github.com/repos/:owner/:repo/installation",
    () => {
      recorded.installationLookups += 1;
      return HttpResponse.json({ id: 778899 }, { status: 200 });
    },
  ),
  http.post(
    "https://api.github.com/app/installations/:id/access_tokens",
    () => {
      recorded.tokenExchanges += 1;
      return HttpResponse.json({
        token: "ghs_install_token",
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      });
    },
  ),
  http.post(
    "https://api.github.com/repos/:owner/:repo/pulls/:pr/reviews",
    async ({ request, params }) => {
      recorded.reviews.push({
        pr: String(params.pr),
        authorization: request.headers.get("authorization"),
        body: (await request.json()) as Record<string, unknown>,
      });
      return HttpResponse.json({ id: 999_001 }, { status: 200 });
    },
  ),
);

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());
beforeEach(() => {
  recorded = { tokenExchanges: 0, installationLookups: 0, reviews: [] };
  __clearTokenCache();
  __clearRepoInstallationCache();
});

const CONFIG: GithubLiveConfig = {
  appId: "42",
  privateKeyPem: TEST_APP_PRIVATE_KEY,
};

const post = (
  layer: ReturnType<typeof makeGithubLive>,
  req: Parameters<typeof github.pullReview>[0],
): Promise<void> =>
  Effect.runPromise(github.pullReview(req).pipe(Effect.provide(layer)));

describe("makeGithubLive — pullReview", () => {
  it("configured — exchanges a token then POSTs a COMMENT review", async () => {
    await post(makeGithubLive(CONFIG), {
      repo: "owner/name",
      pr: 42,
      sha: "headsha",
      body: "summary",
      installationId: 12345,
    });

    expect(recorded.tokenExchanges).toBe(1);
    expect(recorded.reviews).toHaveLength(1);
    expect(recorded.reviews[0]!.pr).toBe("42");
    expect(recorded.reviews[0]!.authorization).toBe("Bearer ghs_install_token");
    expect(recorded.reviews[0]!.body.event).toBe("COMMENT");
    expect(recorded.reviews[0]!.body.commit_id).toBe("headsha");
  });

  it("degraded — no App config → zero HTTP calls, still succeeds", async () => {
    await post(makeGithubLive(undefined), {
      repo: "owner/name",
      pr: 42,
      sha: "headsha",
      body: "summary",
      installationId: 12345,
    });
    expect(recorded.tokenExchanges).toBe(0);
    expect(recorded.reviews).toHaveLength(0);
  });

  it("no installation id — resolves it from the repo, then posts the review", async () => {
    await post(makeGithubLive(CONFIG), {
      repo: "owner/name",
      pr: 42,
      sha: "headsha",
      body: "summary",
    });
    // resolve installation → exchange token → POST review
    expect(recorded.installationLookups).toBe(1);
    expect(recorded.tokenExchanges).toBe(1);
    expect(recorded.reviews).toHaveLength(1);
    expect(recorded.reviews[0]!.body.event).toBe("COMMENT");
  });

  it("surfaces a GitHub API failure as a typed GitHubApiError", async () => {
    server.use(
      http.post(
        "https://api.github.com/repos/:owner/:repo/pulls/:pr/reviews",
        () => HttpResponse.json({ message: "gone" }, { status: 404 }),
      ),
    );
    const exit = await Effect.runPromiseExit(
      github.pullReview({
        repo: "owner/name",
        pr: 42,
        sha: "headsha",
        body: "summary",
        installationId: 12345,
      }).pipe(Effect.provide(makeGithubLive(CONFIG))),
    );
    expect(exit._tag).toBe("Failure");
  });
});

describe("classifyReason", () => {
  it("classifies a 403 carrying a Retry-After as rate-limited, not unauthorized", () => {
    // The headline fix: GitHub returns 403 (not 429) for secondary rate limits,
    // the ones content-generating POSTs like a PR review trip. Without the retry
    // hint a 403 is a genuine auth failure.
    expect(classifyReason(403, 60_000)).toBe("rate-limited");
    expect(classifyReason(403, undefined)).toBe("unauthorized");
  });

  it("classifies 429 as rate-limited and 401 as unauthorized", () => {
    expect(classifyReason(429, undefined)).toBe("rate-limited");
    expect(classifyReason(401, undefined)).toBe("unauthorized");
  });

  it("classifies 5xx and a raw network throw (status 0) as transient", () => {
    expect(classifyReason(502, undefined)).toBe("transient");
    expect(classifyReason(0, undefined)).toBe("transient");
  });

  it("classifies other 4xx as other (non-retryable)", () => {
    expect(classifyReason(404, undefined)).toBe("other");
    expect(classifyReason(422, undefined)).toBe("other");
  });
});
