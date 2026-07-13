// Unit tests for the draft pull-request create (Git Data API).
//
// Mocks the whole Git Data flow on `api.github.com` with MSW and asserts:
// `openDraftPullRequest` resolves the default branch, creates a blob per file,
// a tree, a commit, the head ref, and a DRAFT PR — and that a re-run with the
// same head branch updates the ref (422 → PATCH) and reuses the open PR
// (`created: false`).

import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  commitFilesAndOpenPr,
  deletionEntry,
  openDraftPullRequest,
  treeEntry,
} from "./index";

let calls: string[] = [];
let createdRef = false;
let openPrs: Array<{ number: number; html_url: string }> = [];
let headRefExists = false;
let lastTreeBody: { tree: unknown[]; base_tree: string } | undefined;
let lastPrBody: Record<string, unknown> | undefined;

const base = "https://api.github.com/repos/:owner/:repo";

const server = setupServer(
  http.get("https://api.github.com/repos/:owner/:repo", () => {
    calls.push("GET repo");
    return HttpResponse.json({ default_branch: "main" });
  }),
  http.get(`${base}/git/ref/heads/:branch`, ({ params }) => {
    // The head-ref existence probe (updateExisting: false) hits this too; a
    // 404 means "fresh branch". The base-branch lookup always resolves.
    if (params.branch === "exists" && !headRefExists) {
      return HttpResponse.text("not found", { status: 404 });
    }
    calls.push("GET ref");
    return HttpResponse.json({ object: { sha: "basecommitsha" } });
  }),
  http.get(`${base}/git/commits/:sha`, () => {
    calls.push("GET commit");
    return HttpResponse.json({ tree: { sha: "basetreesha" } });
  }),
  http.post(`${base}/git/blobs`, () => {
    calls.push("POST blob");
    return HttpResponse.json({ sha: "blobsha" });
  }),
  http.post(`${base}/git/trees`, async ({ request }) => {
    calls.push("POST tree");
    lastTreeBody = (await request.json()) as {
      tree: unknown[];
      base_tree: string;
    };
    return HttpResponse.json({ sha: "newtreesha" });
  }),
  http.post(`${base}/git/commits`, () => {
    calls.push("POST commit");
    return HttpResponse.json({ sha: "newcommitsha" });
  }),
  http.post(`${base}/git/refs`, () => {
    calls.push("POST ref");
    return createdRef
      ? HttpResponse.text("ref exists", { status: 422 })
      : HttpResponse.json({ ref: "refs/heads/x" }, { status: 201 });
  }),
  http.patch(`${base}/git/refs/heads/:branch`, () => {
    calls.push("PATCH ref");
    return HttpResponse.json({ ref: "refs/heads/x" });
  }),
  http.get(`${base}/pulls`, () => {
    calls.push("GET pulls");
    return HttpResponse.json(openPrs);
  }),
  http.post(`${base}/pulls`, async ({ request }) => {
    calls.push("POST pull");
    lastPrBody = (await request.json()) as Record<string, unknown>;
    return HttpResponse.json(
      { number: 7, html_url: "https://github.com/owner/name/pull/7" },
      { status: 201 },
    );
  }),
  http.patch(`${base}/pulls/:number`, () => {
    calls.push("PATCH pull");
    return HttpResponse.json({});
  }),
);

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  server.resetHandlers();
  calls = [];
  createdRef = false;
  openPrs = [];
  headRefExists = false;
  lastTreeBody = undefined;
  lastPrBody = undefined;
});
afterAll(() => server.close());

describe("treeEntry (pure)", () => {
  it("builds a non-executable blob tree entry", () => {
    expect(treeEntry("specs/a.md", "abc")).toEqual({
      path: "specs/a.md",
      mode: "100644",
      type: "blob",
      sha: "abc",
    });
  });
});

describe("openDraftPullRequest", () => {
  it("commits files and opens a new draft PR (created: true)", async () => {
    const result = await openDraftPullRequest({
      token: "t",
      repo: "owner/name",
      headBranch: "flare-dispatch/spec-drift-2026-06-03",
      title: "spec drift",
      body: "proposed edits",
      commitMessage: "docs: reconcile specs",
      files: [
        { path: "specs/a.md", content: "new a" },
        { path: "specs/b.md", content: "new b" },
      ],
    });

    expect(result).toEqual({
      number: 7,
      url: "https://github.com/owner/name/pull/7",
      created: true,
    });
    // Default branch resolved, a blob per file, tree, commit, ref, PR opened.
    expect(calls.filter((c) => c === "POST blob")).toHaveLength(2);
    expect(calls).toContain("GET repo");
    expect(calls).toContain("POST tree");
    expect(calls).toContain("POST commit");
    expect(calls).toContain("POST ref");
    expect(calls).toContain("POST pull");
    expect(lastPrBody?.draft).toBe(true);
  });

  it("updates the ref (422 → PATCH) and reuses an open PR (created: false)", async () => {
    createdRef = true; // POST /git/refs returns 422 → force-update path
    openPrs = [{ number: 7, html_url: "https://github.com/owner/name/pull/7" }];

    const result = await openDraftPullRequest({
      token: "t",
      repo: "owner/name",
      baseBranch: "main",
      headBranch: "flare-dispatch/spec-drift-2026-06-03",
      title: "spec drift",
      body: "updated edits",
      commitMessage: "docs: reconcile specs",
      files: [{ path: "specs/a.md", content: "newer a" }],
    });

    expect(result.created).toBe(false);
    expect(result.number).toBe(7);
    expect(calls).toContain("PATCH ref");
    expect(calls).toContain("PATCH pull");
    expect(calls).not.toContain("POST pull");
    // baseBranch supplied → no default-branch lookup.
    expect(calls).not.toContain("GET repo");
  });
});

describe("deletionEntry (pure)", () => {
  it("builds a sha:null deletion tree entry", () => {
    expect(deletionEntry("stale.json")).toEqual({
      path: "stale.json",
      mode: "100644",
      type: "blob",
      sha: null,
    });
  });
});

describe("commitFilesAndOpenPr — writeback contract", () => {
  it("carries deletions (sha:null) + an executable mode into the tree", async () => {
    const result = await commitFilesAndOpenPr({
      token: "t",
      repo: "owner/name",
      baseBranch: "main",
      headBranch: "fd/wb",
      commitMessage: "writeback",
      files: [{ path: "scripts/run.sh", content: "#!/bin/sh", mode: "100755" }],
      deletions: [{ path: "old/gone.txt" }],
      pr: { title: "wb", body: "body" },
    });
    expect(result.created).toBe(true);
    expect(result.skipped).toBe(false);
    expect(result.commitSha).toBe("newcommitsha");

    const tree = lastTreeBody?.tree as Array<Record<string, unknown>>;
    const exe = tree.find((e) => e.path === "scripts/run.sh");
    expect(exe?.mode).toBe("100755");
    expect(exe?.sha).toBe("blobsha");
    const del = tree.find((e) => e.path === "old/gone.txt");
    expect(del?.sha).toBeNull();
  });

  it("opens a non-draft PR when draft:false", async () => {
    await commitFilesAndOpenPr({
      token: "t",
      repo: "owner/name",
      baseBranch: "main",
      headBranch: "fd/wb",
      commitMessage: "wb",
      files: [{ path: "a.txt", content: "x" }],
      pr: { title: "t", body: "b", draft: false },
    });
    expect(lastPrBody?.draft).toBe(false);
  });

  it("pr:false pushes the branch only — no PR opened", async () => {
    const result = await commitFilesAndOpenPr({
      token: "t",
      repo: "owner/name",
      baseBranch: "main",
      headBranch: "fd/wb",
      commitMessage: "wb",
      files: [{ path: "a.txt", content: "x" }],
      pr: false,
    });
    expect(result.created).toBe(false);
    expect(result.number).toBeUndefined();
    expect(result.commitSha).toBe("newcommitsha");
    expect(calls).not.toContain("POST pull");
    expect(calls).not.toContain("GET pulls");
  });

  it("updateExisting:false on an existing branch is a no-op skip", async () => {
    headRefExists = true;
    const result = await commitFilesAndOpenPr({
      token: "t",
      repo: "owner/name",
      baseBranch: "main",
      headBranch: "exists",
      commitMessage: "wb",
      files: [{ path: "a.txt", content: "x" }],
      updateExisting: false,
      pr: { title: "t", body: "b" },
    });
    expect(result.skipped).toBe(true);
    expect(result.created).toBe(false);
    expect(calls).not.toContain("POST commit");
    expect(calls).not.toContain("POST tree");
  });

  it("updateExisting:false on a fresh branch proceeds to commit", async () => {
    headRefExists = false; // GET head ref → 404 → fresh
    const result = await commitFilesAndOpenPr({
      token: "t",
      repo: "owner/name",
      baseBranch: "main",
      headBranch: "exists",
      commitMessage: "wb",
      files: [{ path: "a.txt", content: "x" }],
      updateExisting: false,
      pr: { title: "t", body: "b" },
    });
    expect(result.skipped).toBe(false);
    expect(result.created).toBe(true);
    expect(calls).toContain("POST commit");
  });
});
