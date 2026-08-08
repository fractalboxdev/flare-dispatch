// Unit tests for the closed-PR read.
//
// Mocks `api.github.com` with MSW and asserts: the query names `state=all` and
// sorts by `updated` descending (the property that makes `updatedSince` a sound
// stopping rule); `closed_at` / `merged_at` survive as epoch ms and stay absent
// when null; the head-branch prefix filters client-side; pagination follows
// full pages, stops on a short one, honours `maxPages`, and stops early once a
// page runs past the cutoff; a non-2xx surfaces a GithubApiError.

import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { GithubApiError, listPullRequests, normalizePullRequest, pullRequestsUrl } from "./index";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 7, 8);
const iso = (ms: number): string => new Date(ms).toISOString();

const rawPr = (over: Record<string, unknown> = {}) => ({
  number: 12,
  title: "docs(maintenance): open questions",
  body: "maintenance-key: org-spec-audit/spend-caps",
  head: { ref: "flare-dispatch/spec-audit-questions-2026-07-01" },
  state: "closed",
  draft: true,
  html_url: "https://github.com/owner/name/pull/12",
  created_at: iso(NOW - 40 * DAY),
  updated_at: iso(NOW - 5 * DAY),
  closed_at: iso(NOW - 5 * DAY),
  merged_at: null,
  ...over,
});

let requests: URL[] = [];
let pages: Record<string, unknown[]> = {};
let status = 200;

const server = setupServer(
  http.get("https://api.github.com/repos/:owner/:repo/pulls", ({ request }) => {
    const url = new URL(request.url);
    requests.push(url);
    if (status >= 400) return HttpResponse.json({ message: "nope" }, { status });
    return HttpResponse.json(pages[url.searchParams.get("page") ?? "1"] ?? []);
  }),
);

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  server.resetHandlers();
  requests = [];
  pages = {};
  status = 200;
});
afterAll(() => server.close());

describe("pullRequestsUrl (pure)", () => {
  it("asks for every state, newest-touched first", () => {
    const url = new URL(pullRequestsUrl({ repo: "owner/name" }));
    expect(url.pathname).toBe("/repos/owner/name/pulls");
    expect(url.searchParams.get("state")).toBe("all");
    expect(url.searchParams.get("sort")).toBe("updated");
    expect(url.searchParams.get("direction")).toBe("desc");
    expect(url.searchParams.get("per_page")).toBe("100");
  });
});

describe("normalizePullRequest (pure)", () => {
  it("keeps closed_at and merged_at as epoch ms", () => {
    const pr = normalizePullRequest("owner/name", rawPr({ merged_at: iso(NOW - 5 * DAY) }));
    expect(pr.closedAt).toBe(NOW - 5 * DAY);
    expect(pr.mergedAt).toBe(NOW - 5 * DAY);
    expect(pr.headBranch).toBe("flare-dispatch/spec-audit-questions-2026-07-01");
  });

  it("leaves both absent on an open PR rather than inventing a zero", () => {
    const pr = normalizePullRequest(
      "owner/name",
      rawPr({ state: "open", closed_at: null, merged_at: null }),
    );
    expect(pr.state).toBe("open");
    expect(pr.closedAt).toBeUndefined();
    expect(pr.mergedAt).toBeUndefined();
  });

  it("tolerates a null body — a PR with no description is not a parse failure", () => {
    expect(normalizePullRequest("owner/name", rawPr({ body: null })).body).toBe("");
  });
});

describe("listPullRequests", () => {
  it("returns closed PRs with the fields a cooldown needs", async () => {
    pages["1"] = [rawPr()];
    const prs = await listPullRequests({ token: "t", repo: "owner/name" });
    expect(prs).toHaveLength(1);
    expect(prs[0]).toMatchObject({ number: 12, state: "closed", closedAt: NOW - 5 * DAY });
    expect(requests[0]?.searchParams.get("state")).toBe("all");
  });

  it("filters on the head-branch prefix client-side", async () => {
    pages["1"] = [rawPr(), rawPr({ number: 13, head: { ref: "feat/unrelated" } })];
    const prs = await listPullRequests({
      token: "t",
      repo: "owner/name",
      headBranchPrefix: "flare-dispatch/spec-audit-questions-",
    });
    expect(prs.map((p) => p.number)).toEqual([12]);
    // The prefix is not a GitHub query parameter — `head=` matches exactly.
    expect(requests[0]?.searchParams.get("head")).toBeNull();
  });

  it("stops at the first short page", async () => {
    pages["1"] = [rawPr(), rawPr({ number: 13 })];
    const prs = await listPullRequests({ token: "t", repo: "owner/name", perPage: 3 });
    expect(prs).toHaveLength(2);
    expect(requests).toHaveLength(1);
  });

  it("follows full pages up to maxPages", async () => {
    pages["1"] = [rawPr({ number: 1 }), rawPr({ number: 2 })];
    pages["2"] = [rawPr({ number: 3 }), rawPr({ number: 4 })];
    pages["3"] = [rawPr({ number: 5 }), rawPr({ number: 6 })];
    const prs = await listPullRequests({
      token: "t",
      repo: "owner/name",
      perPage: 2,
      maxPages: 2,
    });
    expect(prs.map((p) => p.number)).toEqual([1, 2, 3, 4]);
    expect(requests.map((r) => r.searchParams.get("page"))).toEqual(["1", "2"]);
  });

  it("stops paginating once a page runs past the cutoff", async () => {
    pages["1"] = [rawPr({ number: 1 }), rawPr({ number: 2, updated_at: iso(NOW - 90 * DAY) })];
    pages["2"] = [rawPr({ number: 3 })];
    const prs = await listPullRequests({
      token: "t",
      repo: "owner/name",
      perPage: 2,
      updatedSince: NOW - 30 * DAY,
    });
    // Page 1 is returned whole — the cutoff bounds PAGINATION, and the caller
    // dates its own decisions from `closedAt`.
    expect(prs.map((p) => p.number)).toEqual([1, 2]);
    expect(requests).toHaveLength(1);
  });

  it("surfaces a non-2xx as a GithubApiError", async () => {
    status = 403;
    await expect(listPullRequests({ token: "t", repo: "owner/name" })).rejects.toBeInstanceOf(
      GithubApiError,
    );
  });
});
