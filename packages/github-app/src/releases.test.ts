// Unit tests for GitHub Release create.
//
// Mocks `api.github.com` with MSW and asserts: `createRelease` POSTs to
// `/releases` with the tag, the target sha as `target_commitish`, the body, and
// the installation token as a Bearer credential; it never asks GitHub to
// auto-generate notes; the result maps `id` / `html_url` / `tag_name`; a non-2xx
// surfaces a GithubApiError.

import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createRelease, GithubApiError } from "./index";

type Captured = {
  authorization: string | null;
  owner: string;
  repo: string;
  body: Record<string, unknown>;
};

let posts: Captured[] = [];
let status = 201;

const server = setupServer(
  http.post(
    "https://api.github.com/repos/:owner/:repo/releases",
    async ({ request, params }) => {
      posts.push({
        authorization: request.headers.get("authorization"),
        owner: String(params.owner),
        repo: String(params.repo),
        body: (await request.json()) as Record<string, unknown>,
      });
      if (status >= 400) {
        return HttpResponse.json({ message: "nope" }, { status });
      }
      return HttpResponse.json(
        {
          id: 555_001,
          html_url: "https://github.com/owner/name/releases/tag/v0.1.0",
          tag_name: "v0.1.0",
        },
        { status },
      );
    },
  ),
);

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  server.resetHandlers();
  posts = [];
  status = 201;
});
afterAll(() => server.close());

describe("createRelease", () => {
  it("POSTs the release with the tag, target sha, and a Bearer token", async () => {
    const result = await createRelease({
      token: "inst-token-abc",
      repo: "owner/name",
      tag: "v0.1.0",
      target: "deadbeefcafe",
      name: "v0.1.0",
      body: "## v0.1.0\n\n### 🚀 Features\n- thing",
    });

    expect(posts).toHaveLength(1);
    const p = posts[0]!;
    expect(p.owner).toBe("owner");
    expect(p.repo).toBe("name");
    expect(p.authorization).toBe("Bearer inst-token-abc");
    expect(p.body.tag_name).toBe("v0.1.0");
    expect(p.body.target_commitish).toBe("deadbeefcafe");
    expect(p.body.name).toBe("v0.1.0");
    expect(p.body.body).toContain("### 🚀 Features");
    // We render our own notes — never let GitHub overwrite the body.
    expect(p.body.generate_release_notes).toBe(false);
    expect(p.body.draft).toBe(false);

    expect(result).toEqual({
      id: 555_001,
      htmlUrl: "https://github.com/owner/name/releases/tag/v0.1.0",
      tagName: "v0.1.0",
    });
  });

  it("omits target_commitish when no target is given", async () => {
    await createRelease({ token: "t", repo: "o/r", tag: "v1.0.0", body: "b" });
    expect(posts[0]!.body).not.toHaveProperty("target_commitish");
    expect(posts[0]!.body.name).toBe("v1.0.0"); // defaults to the tag
  });

  it("surfaces a GithubApiError on a non-2xx (e.g. 422 release exists)", async () => {
    status = 422;
    await expect(
      createRelease({ token: "t", repo: "o/r", tag: "v1.0.0", body: "b" }),
    ).rejects.toBeInstanceOf(GithubApiError);
  });
});
