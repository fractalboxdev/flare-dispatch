// Unit tests for GitHub Actions workflow-run read.
//
// Mocks `api.github.com` with MSW and asserts: `listActionRuns` GETs
// `/actions/runs` with the status filter + Bearer token, and normalizes the
// payload into `ActionRun`s; a non-2xx surfaces a GithubApiError. The pure URL
// + normalize helpers are tested directly.

import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  actionRunsUrl,
  GithubApiError,
  listActionRuns,
  normalizeRun,
} from "./index";

type Captured = { authorization: string | null; url: string };
let gets: Captured[] = [];

const sampleRun = (over: Record<string, unknown> = {}) => ({
  id: 12345,
  name: "CI/CD",
  head_branch: "main",
  head_sha: "deadbeef",
  status: "completed",
  conclusion: "failure",
  html_url: "https://github.com/owner/name/actions/runs/12345",
  created_at: "2026-06-01T00:00:00Z",
  ...over,
});

const server = setupServer(
  http.get(
    "https://api.github.com/repos/:owner/:repo/actions/runs",
    ({ request }) => {
      gets.push({
        authorization: request.headers.get("authorization"),
        url: request.url,
      });
      return HttpResponse.json(
        { workflow_runs: [sampleRun(), sampleRun({ id: 22, conclusion: "success" })] },
        { status: 200 },
      );
    },
  ),
);

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  server.resetHandlers();
  gets = [];
});
afterAll(() => server.close());

describe("actionRunsUrl (pure)", () => {
  it("encodes the status + per_page query", () => {
    const url = actionRunsUrl({ repo: "owner/name", status: "completed", perPage: 50 });
    expect(url).toContain("/repos/owner/name/actions/runs?");
    expect(url).toContain("status=completed");
    expect(url).toContain("per_page=50");
  });
});

describe("normalizeRun (pure)", () => {
  it("maps snake_case fields and parses the created date", () => {
    const r = normalizeRun("owner/name", sampleRun());
    expect(r).toMatchObject({
      id: 12345,
      name: "CI/CD",
      headBranch: "main",
      headSha: "deadbeef",
      conclusion: "failure",
    });
    expect(r.createdAt).toBe(Date.parse("2026-06-01T00:00:00Z"));
  });
});

describe("listActionRuns", () => {
  it("GETs with a Bearer token and returns normalized runs", async () => {
    const runs = await listActionRuns({
      token: "inst-token-xyz",
      repo: "owner/name",
      status: "completed",
    });
    expect(gets).toHaveLength(1);
    expect(gets[0]!.authorization).toBe("Bearer inst-token-xyz");
    expect(runs).toHaveLength(2);
    expect(runs[0]!.id).toBe(12345);
  });

  it("surfaces a GithubApiError on non-2xx", async () => {
    server.use(
      http.get(
        "https://api.github.com/repos/:owner/:repo/actions/runs",
        () => HttpResponse.text("forbidden", { status: 403 }),
      ),
    );
    await expect(
      listActionRuns({ token: "t", repo: "owner/name" }),
    ).rejects.toBeInstanceOf(GithubApiError);
  });
});
