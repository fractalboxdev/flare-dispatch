// Unit tests for PR review (comment) create.
//
// Mocks `api.github.com` with MSW and asserts: `createPullReview` POSTs to
// `/pulls/{n}/reviews` with `event: "COMMENT"`, the head sha as `commit_id`,
// the body, and the installation token as a Bearer credential; a non-2xx
// surfaces a GithubApiError.

import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createPullReview, GithubApiError } from "./index";

type Captured = {
  authorization: string | null;
  pr: string;
  body: Record<string, unknown>;
};

let posts: Captured[] = [];

const server = setupServer(
  http.post(
    "https://api.github.com/repos/:owner/:repo/pulls/:pr/reviews",
    async ({ request, params }) => {
      posts.push({
        authorization: request.headers.get("authorization"),
        pr: String(params.pr),
        body: (await request.json()) as Record<string, unknown>,
      });
      return HttpResponse.json({ id: 999_001 }, { status: 200 });
    },
  ),
);

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  server.resetHandlers();
  posts = [];
});
afterAll(() => server.close());

describe("createPullReview", () => {
  it("POSTs a COMMENT review anchored to the head sha with a Bearer token", async () => {
    await createPullReview({
      token: "inst-token-abc",
      repo: "owner/name",
      pr: 42,
      sha: "headsha123",
      body: "AI review summary",
    });

    expect(posts).toHaveLength(1);
    const p = posts[0]!;
    expect(p.pr).toBe("42");
    expect(p.authorization).toBe("Bearer inst-token-abc");
    expect(p.body.event).toBe("COMMENT");
    expect(p.body.commit_id).toBe("headsha123");
    expect(p.body.body).toBe("AI review summary");
  });

  it("honours an explicit event override", async () => {
    await createPullReview({
      token: "t",
      repo: "o/r",
      pr: 1,
      sha: "s",
      body: "b",
      event: "REQUEST_CHANGES",
    });
    expect(posts[0]!.body.event).toBe("REQUEST_CHANGES");
  });

  it("surfaces a non-2xx as a GithubApiError", async () => {
    server.use(
      http.post(
        "https://api.github.com/repos/:owner/:repo/pulls/:pr/reviews",
        () => HttpResponse.json({ message: "not found" }, { status: 404 }),
      ),
    );
    await expect(
      createPullReview({ token: "t", repo: "o/r", pr: 1, sha: "s", body: "b" }),
    ).rejects.toBeInstanceOf(GithubApiError);
  });

  it("rejects a malformed repo slug", async () => {
    await expect(
      createPullReview({ token: "t", repo: "no-slash", pr: 1, sha: "s", body: "b" }),
    ).rejects.toBeInstanceOf(GithubApiError);
  });
});
