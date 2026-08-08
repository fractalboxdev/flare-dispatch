// Unit tests for the narrow repo text-file read.
//
// Mocks `api.github.com` with MSW and asserts: the raw media type is requested
// (so no base64 round-trip and no 1 MB ceiling), the ref rides as a query
// parameter, path segments are encoded individually, a 404 is `{ found: false }`
// rather than a throw, a directory listing is also `found: false`, and every
// other non-2xx still throws a GithubApiError.

import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { GithubApiError, readRepoTextFile, repoContentsUrl } from "./index";

type Captured = { url: URL; accept: string | null; authorization: string | null };

let requests: Captured[] = [];
let respond: () => Response = () => HttpResponse.text("line one\nline two");

const server = setupServer(
  http.get("https://api.github.com/repos/:owner/:repo/contents/*", ({ request }) => {
    requests.push({
      url: new URL(request.url),
      accept: request.headers.get("accept"),
      authorization: request.headers.get("authorization"),
    });
    return respond();
  }),
);

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  server.resetHandlers();
  requests = [];
  respond = () => HttpResponse.text("line one\nline two");
});
afterAll(() => server.close());

describe("repoContentsUrl (pure)", () => {
  it("encodes path segments individually and carries the ref", () => {
    expect(
      repoContentsUrl({
        repo: "owner/name",
        path: "infra/maintenance loop/declined.jsonl",
        ref: "feat/x",
      }),
    ).toBe(
      "https://api.github.com/repos/owner/name/contents/infra/maintenance%20loop/declined.jsonl?ref=feat%2Fx",
    );
  });

  it("omits the ref entirely when unset — GitHub uses the default branch", () => {
    expect(repoContentsUrl({ repo: "owner/name", path: "a.md" })).toBe(
      "https://api.github.com/repos/owner/name/contents/a.md",
    );
  });
});

describe("readRepoTextFile", () => {
  it("returns the file's text, asking for the raw media type", async () => {
    const result = await readRepoTextFile({
      token: "inst-token-abc",
      repo: "owner/name",
      path: "infra/maintenance-loop/declined.jsonl",
    });
    expect(result).toEqual({ found: true, content: "line one\nline two" });
    expect(requests[0]?.accept).toBe("application/vnd.github.raw");
    expect(requests[0]?.authorization).toBe("Bearer inst-token-abc");
  });

  it("reports an absent file as a value, not a failure", async () => {
    respond = () => HttpResponse.text("Not Found", { status: 404 });
    await expect(
      readRepoTextFile({ token: "t", repo: "owner/name", path: "nope.jsonl" }),
    ).resolves.toEqual({ found: false });
  });

  it("treats a directory the same as absent — it is not the text file asked for", async () => {
    respond = () => HttpResponse.json([{ name: "a.md", type: "file" }]);
    await expect(
      readRepoTextFile({ token: "t", repo: "owner/name", path: "infra" }),
    ).resolves.toEqual({ found: false });
  });

  it("still throws on any other non-2xx", async () => {
    respond = () => HttpResponse.json({ message: "bad credentials" }, { status: 401 });
    await expect(
      readRepoTextFile({ token: "t", repo: "owner/name", path: "a.jsonl" }),
    ).rejects.toBeInstanceOf(GithubApiError);
  });
});
