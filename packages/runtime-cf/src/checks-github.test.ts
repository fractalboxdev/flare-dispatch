// Integration tests for ChecksGithubLive — the live `checks` capability.
//
// Mocks `api.github.com` with MSW (plain Node, no Workers pool — same reason
// the D1/R2 suites use Miniflare directly) and asserts the GitHub half of the
// `finalize` boundary against the real `Checks` Effect Layer:
//
//   * green run  — exactly one POST /check-runs (status:in_progress) followed
//                  by exactly one PATCH (status:completed, conclusion:success);
//   * red run    — same, but conclusion:failure;
//   * degraded   — with no App config the no-op Layer makes zero HTTP calls and
//                  the execution still completes.
//
// Spec: specs/04-gha-integration.md § Check-runs callback, specs/pm/plan.md
// § PR6 acceptance.

import { __clearTokenCache } from "@fractalbox/flare-dispatch-github-app";
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
import { checks } from "@fractalbox/flare-dispatch-core";
import { TEST_APP_PRIVATE_KEY } from "@fractalbox/flare-dispatch-github-app/testing";
import {
  type ChecksGithubConfig,
  makeChecksGithubLive,
  NOOP_CHECK_RUN_ID,
} from "./checks-github";

/** Records the GitHub API calls MSW intercepted, for per-test assertions. */
type Recorded = {
  posts: { status: unknown }[];
  patches: { id: string; status: unknown; conclusion: unknown }[];
  tokenExchanges: number;
};
let recorded: Recorded;

const GH_CHECK_RUN_ID = 909_001;

const server = setupServer(
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
    "https://api.github.com/repos/:owner/:repo/check-runs",
    async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      recorded.posts.push({ status: body.status });
      return HttpResponse.json({ id: GH_CHECK_RUN_ID }, { status: 201 });
    },
  ),
  http.patch(
    "https://api.github.com/repos/:owner/:repo/check-runs/:id",
    async ({ request, params }) => {
      const body = (await request.json()) as Record<string, unknown>;
      recorded.patches.push({
        id: String(params.id),
        status: body.status,
        conclusion: body.conclusion,
      });
      return HttpResponse.json({ id: Number(params.id) });
    },
  ),
);

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

beforeEach(() => {
  recorded = { posts: [], patches: [], tokenExchanges: 0 };
  __clearTokenCache();
});

const CONFIG: ChecksGithubConfig = {
  appId: "42",
  privateKeyPem: TEST_APP_PRIVATE_KEY,
  installationId: 12345,
};

/**
 * Drive the create → update check-run lifecycle exactly as `RunWorkflow` will:
 * open the check-run on start, complete it with the run's conclusion.
 */
const driveLifecycle = (
  layer: ReturnType<typeof makeChecksGithubLive>,
  conclusion: "success" | "failure",
): Promise<void> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const checkRunId = yield* checks.create({
        repo: "owner/name",
        sha: "abc123",
        name: "flare-dispatch/offload-test",
        output: { title: "offload-test", summary: "running" },
      });
      yield* checks.update({
        repo: "owner/name",
        checkRunId,
        conclusion,
        output: { title: "offload-test", summary: "done" },
      });
    }).pipe(Effect.provide(layer)),
  );

describe("ChecksGithubLive — live GitHub App binding", () => {
  it("green run — one in_progress POST then one completed/success PATCH", async () => {
    await driveLifecycle(makeChecksGithubLive(CONFIG), "success");

    expect(recorded.posts).toHaveLength(1);
    expect(recorded.posts[0]!.status).toBe("in_progress");

    expect(recorded.patches).toHaveLength(1);
    expect(recorded.patches[0]).toMatchObject({
      id: String(GH_CHECK_RUN_ID),
      status: "completed",
      conclusion: "success",
    });
  });

  it("red run — the closing PATCH carries conclusion:failure", async () => {
    await driveLifecycle(makeChecksGithubLive(CONFIG), "failure");

    expect(recorded.posts).toHaveLength(1);
    expect(recorded.posts[0]!.status).toBe("in_progress");

    expect(recorded.patches).toHaveLength(1);
    expect(recorded.patches[0]).toMatchObject({
      status: "completed",
      conclusion: "failure",
    });
  });

  it("reuses the cached installation token across create + update", async () => {
    await driveLifecycle(makeChecksGithubLive(CONFIG), "success");
    // create + update are two GitHub calls but share one installation token —
    // the in-memory cache means exactly one access_tokens exchange.
    expect(recorded.tokenExchanges).toBe(1);
  });

  it("degraded — no App config makes zero GitHub calls and returns the sentinel id", async () => {
    const layer = makeChecksGithubLive(undefined);

    const checkRunId = await Effect.runPromise(
      checks
        .create({
          repo: "owner/name",
          sha: "abc123",
          name: "flare-dispatch/offload-test",
        })
        .pipe(Effect.provide(layer)),
    );
    expect(checkRunId).toBe(NOOP_CHECK_RUN_ID);

    await Effect.runPromise(
      checks
        .update({
          repo: "owner/name",
          checkRunId,
          conclusion: "success",
        })
        .pipe(Effect.provide(layer)),
    );

    // The no-op Layer never touches the network.
    expect(recorded.posts).toHaveLength(0);
    expect(recorded.patches).toHaveLength(0);
    expect(recorded.tokenExchanges).toBe(0);
  });
});
