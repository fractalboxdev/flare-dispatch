// Unit tests for the issue surface — one read and four writes.
//
// Mocks `api.github.com` with MSW and pins the WIRE SHAPE of each call. This is
// the module that puts labels on issues and closes them, so what matters here
// is not that the functions run but that they send exactly what they claim to:
// the run tests above this layer drive a hand-written fake, and a fake can only
// prove the run's wiring, never that the fake and the HTTP agree.
//
// Four properties the triage desk's safety argument actually rests on:
//
//   * pull requests never come back from the issue list (`GET /issues` returns
//     them, and a triage pass that labelled PRs as bugs would be the first
//     thing anyone noticed);
//   * a label removal that 404s is success, because "already absent" is the
//     requested end state;
//   * the close PATCHes `state_reason: "duplicate"` and nothing else;
//   * every call carries the installation token as a Bearer credential.

import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  addIssueLabels,
  closeIssueAsDuplicate,
  createIssueComment,
  listIssues,
  removeIssueLabel,
} from "./index";

type Captured = {
  method: string;
  path: string;
  /** The pathname exactly as sent — MSW decodes `:params`, this does not. */
  rawPath: string;
  authorization: string | null;
  query: Record<string, string>;
  body: Record<string, unknown> | undefined;
};

let calls: Captured[] = [];
/** Pages the list handler serves, in order; each call shifts one off. */
let pages: unknown[][] = [];
/** Status the label-DELETE handler answers with. */
let removeStatus = 204;

const capture = async (request: Request, path: string): Promise<void> => {
  const url = new URL(request.url);
  let body: Record<string, unknown> | undefined;
  if (request.method !== "GET" && request.method !== "DELETE") {
    body = (await request.json()) as Record<string, unknown>;
  }
  calls.push({
    method: request.method,
    path,
    rawPath: url.pathname,
    authorization: request.headers.get("authorization"),
    query: Object.fromEntries(url.searchParams.entries()),
    body,
  });
};

const server = setupServer(
  http.get("https://api.github.com/repos/:owner/:repo/issues", async ({ request }) => {
    await capture(request, "list");
    return HttpResponse.json(pages.shift() ?? []);
  }),
  http.post(
    "https://api.github.com/repos/:owner/:repo/issues/:n/labels",
    async ({ request, params }) => {
      await capture(request, `labels:${String(params.n)}`);
      return HttpResponse.json([], { status: 200 });
    },
  ),
  http.delete(
    "https://api.github.com/repos/:owner/:repo/issues/:n/labels/:label",
    async ({ request, params }) => {
      await capture(request, `unlabel:${String(params.n)}:${String(params.label)}`);
      return removeStatus === 204
        ? new HttpResponse(null, { status: 204 })
        : HttpResponse.json({ message: "Label does not exist" }, { status: removeStatus });
    },
  ),
  http.post(
    "https://api.github.com/repos/:owner/:repo/issues/:n/comments",
    async ({ request, params }) => {
      await capture(request, `comment:${String(params.n)}`);
      return HttpResponse.json({ id: 1 }, { status: 201 });
    },
  ),
  http.patch("https://api.github.com/repos/:owner/:repo/issues/:n", async ({ request, params }) => {
    await capture(request, `patch:${String(params.n)}`);
    return HttpResponse.json({ number: Number(params.n) }, { status: 200 });
  }),
);

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  server.resetHandlers();
  calls = [];
  pages = [];
  removeStatus = 204;
});
afterAll(() => server.close());

const base = { token: "inst-token-abc", repo: "owner/name" } as const;

/** A GitHub issue JSON blob, in the shape the normalizer reads. */
const rawIssue = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  number: 7,
  title: "It broke",
  body: "here is how",
  state: "open",
  labels: [{ name: "bug" }, { name: "triage:needs-repro" }],
  user: { login: "stranger" },
  author_association: "NONE",
  created_at: "2026-08-01T00:00:00Z",
  updated_at: "2026-08-02T00:00:00Z",
  html_url: "https://github.com/owner/name/issues/7",
  comments: 3,
  ...over,
});

describe("listIssues", () => {
  it("normalizes an issue and carries the author's standing", async () => {
    pages = [[rawIssue()]];
    const out = await listIssues({ ...base });

    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      number: 7,
      title: "It broke",
      body: "here is how",
      state: "open",
      labels: ["bug", "triage:needs-repro"],
      author: "stranger",
      authorAssociation: "NONE",
      commentCount: 3,
    });
    expect(calls[0]?.authorization).toBe("Bearer inst-token-abc");
  });

  it("filters out pull requests — GET /issues returns them too", async () => {
    pages = [
      [
        rawIssue({ number: 7 }),
        // A PR wearing an issue's clothes: the `pull_request` key is the tell.
        rawIssue({ number: 8, pull_request: { url: "https://api.github.com/…/pulls/8" } }),
      ],
    ];
    const out = await listIssues({ ...base });
    expect(out.map((i) => i.number)).toEqual([7]);
  });

  it("asks for open issues newest-updated first, and passes `since` and labels", async () => {
    pages = [[]];
    await listIssues({
      ...base,
      labels: ["triage:needs-repro", "bug"],
      updatedSince: Date.UTC(2026, 7, 1),
    });
    expect(calls[0]?.query).toMatchObject({
      state: "open",
      sort: "updated",
      direction: "desc",
      per_page: "100",
      page: "1",
      labels: "triage:needs-repro,bug",
      since: "2026-08-01T00:00:00.000Z",
    });
  });

  it("stops on a short page rather than paging to the ceiling", async () => {
    pages = [[rawIssue()]]; // 1 < per_page → one request only
    await listIssues({ ...base, maxPages: 5 });
    expect(calls.filter((c) => c.path === "list")).toHaveLength(1);
  });

  it("honours maxPages on a backlog that keeps filling pages", async () => {
    const full = Array.from({ length: 100 }, (_, i) => rawIssue({ number: i + 1 }));
    pages = [full, full, full];
    const out = await listIssues({ ...base, maxPages: 2 });
    expect(calls.filter((c) => c.path === "list")).toHaveLength(2);
    expect(out).toHaveLength(200);
  });

  it("defaults an unrecognized author_association to NONE", async () => {
    pages = [[rawIssue({ author_association: "SOVEREIGN" })]];
    const out = await listIssues({ ...base });
    expect(out[0]?.authorAssociation).toBe("NONE");
  });

  it("surfaces a non-2xx rather than reporting an empty backlog", async () => {
    server.use(
      http.get("https://api.github.com/repos/:owner/:repo/issues", () =>
        HttpResponse.json({ message: "Bad credentials" }, { status: 401 }),
      ),
    );
    await expect(listIssues({ ...base })).rejects.toThrow();
  });
});

describe("addIssueLabels", () => {
  it("POSTs the labels to /labels", async () => {
    await addIssueLabels({ ...base, issue: 7, labels: ["triage:needs-repro"] });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: "POST", path: "labels:7" });
    expect(calls[0]?.body).toEqual({ labels: ["triage:needs-repro"] });
    expect(calls[0]?.authorization).toBe("Bearer inst-token-abc");
  });

  it("sends nothing at all for an empty label list", async () => {
    await addIssueLabels({ ...base, issue: 7, labels: [] });
    expect(calls).toHaveLength(0);
  });
});

describe("removeIssueLabel", () => {
  it("DELETEs the label url-encoded, so a `:` in the name cannot alter the path", async () => {
    await removeIssueLabel({ ...base, issue: 7, label: "triage:needs-repro" });
    expect(calls[0]?.method).toBe("DELETE");
    // Asserted on the raw pathname: MSW decodes `:label` before handing it over,
    // so the decoded form would pass whether or not the code encoded anything.
    expect(calls[0]?.rawPath).toBe("/repos/owner/name/issues/7/labels/triage%3Aneeds-repro");
  });

  it("encodes a label containing a slash rather than growing a path segment", async () => {
    server.use(
      http.delete(
        "https://api.github.com/repos/:owner/:repo/issues/:n/labels/*",
        async ({ request }) => {
          await capture(request, "unlabel-wild");
          return new HttpResponse(null, { status: 204 });
        },
      ),
    );
    await removeIssueLabel({ ...base, issue: 7, label: "area/api" });
    expect(calls[0]?.rawPath).toBe("/repos/owner/name/issues/7/labels/area%2Fapi");
  });

  it("treats 404 as the requested end state, not a failure", async () => {
    removeStatus = 404;
    await expect(
      removeIssueLabel({ ...base, issue: 7, label: "never-was-there" }),
    ).resolves.toBeUndefined();
  });

  it("still surfaces a real failure", async () => {
    removeStatus = 500;
    await expect(removeIssueLabel({ ...base, issue: 7, label: "bug" })).rejects.toThrow();
  });
});

describe("createIssueComment", () => {
  it("POSTs the caller's body verbatim — this module renders nothing", async () => {
    await createIssueComment({ ...base, issue: 7, body: "Thanks for the report." });
    expect(calls[0]).toMatchObject({ method: "POST", path: "comment:7" });
    expect(calls[0]?.body).toEqual({ body: "Thanks for the report." });
  });
});

describe("closeIssueAsDuplicate", () => {
  it("PATCHes state closed with state_reason duplicate, and nothing else", async () => {
    await closeIssueAsDuplicate({ ...base, issue: 7, duplicateOf: 3 });
    expect(calls[0]).toMatchObject({ method: "PATCH", path: "patch:7" });
    // Pinned deliberately: `state_reason` is the claim that survives in the
    // timeline, and this is the only close the service has. A change to this
    // body is a change to what the loop records about a stranger's issue.
    expect(calls[0]?.body).toEqual({ state: "closed", state_reason: "duplicate" });
  });

  it("names the duplicate target when the close fails", async () => {
    server.use(
      http.patch("https://api.github.com/repos/:owner/:repo/issues/:n", () =>
        HttpResponse.json({ message: "Validation failed" }, { status: 422 }),
      ),
    );
    await expect(closeIssueAsDuplicate({ ...base, issue: 7, duplicateOf: 3 })).rejects.toThrow(
      /duplicate of #3/,
    );
  });
});
