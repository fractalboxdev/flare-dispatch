// Unit tests for the branch-head read.
//
// Mocks `api.github.com` with MSW and asserts: the ref path keeps a branch's
// slashes as structure, the head SHA comes back from `object.sha`, and every
// shape that names no single commit — 404, a prefix-match array, a malformed
// SHA — throws rather than returning something a caller could compare against.

import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { branchRefUrl, GithubApiError, readBranchHead } from "./index";

const HEAD = "0123456789abcdef0123456789abcdef01234567";

let requests: Array<{ url: URL; authorization: string | null }> = [];
let respond: () => Response = () => HttpResponse.json({ object: { sha: HEAD, type: "commit" } });

const server = setupServer(
  http.get("https://api.github.com/repos/:owner/:repo/git/ref/*", ({ request }) => {
    requests.push({
      url: new URL(request.url),
      authorization: request.headers.get("authorization"),
    });
    return respond();
  }),
);

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  server.resetHandlers();
  requests = [];
  respond = () => HttpResponse.json({ object: { sha: HEAD, type: "commit" } });
});
afterAll(() => server.close());

describe("branchRefUrl (pure)", () => {
  it("keeps a branch's slashes as ref structure and encodes each segment", () => {
    expect(branchRefUrl({ repo: "owner/name", branch: "release/2026 09" })).toBe(
      "https://api.github.com/repos/owner/name/git/ref/heads/release/2026%2009",
    );
  });

  it("refuses dot and empty segments", () => {
    for (const branch of ["..", "a/../b", "./a", "a//b", ""]) {
      expect(() => branchRefUrl({ repo: "owner/name", branch })).toThrow(GithubApiError);
    }
  });
});

describe("readBranchHead", () => {
  it("returns the ref's commit SHA, authenticated with the installation token", async () => {
    await expect(
      readBranchHead({ token: "inst-token", repo: "owner/name", branch: "main" }),
    ).resolves.toBe(HEAD);
    expect(requests[0]?.url.pathname).toBe("/repos/owner/name/git/ref/heads/main");
    expect(requests[0]?.authorization).toBe("Bearer inst-token");
  });

  it("throws on a missing branch", async () => {
    respond = () => HttpResponse.json({ message: "Not Found" }, { status: 404 });
    await expect(
      readBranchHead({ token: "t", repo: "owner/name", branch: "gone" }),
    ).rejects.toBeInstanceOf(GithubApiError);
  });

  it("throws on a prefix-match array — it names no single head", async () => {
    respond = () => HttpResponse.json([{ object: { sha: HEAD } }]);
    await expect(
      readBranchHead({ token: "t", repo: "owner/name", branch: "rel" }),
    ).rejects.toBeInstanceOf(GithubApiError);
  });

  it("throws on a body without a 40-hex SHA", async () => {
    respond = () => HttpResponse.json({ object: { sha: "main" } });
    await expect(
      readBranchHead({ token: "t", repo: "owner/name", branch: "main" }),
    ).rejects.toBeInstanceOf(GithubApiError);
  });
});
