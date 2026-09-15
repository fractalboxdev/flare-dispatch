// Unit tests for merge-request diff fetch + note post/update.
//
// Mocks `gitlab.com/api/v4` with MSW and asserts: `fetchMergeRequestDiff`
// paginates the `/diffs` endpoint (following `x-next-page`), sends the
// `PRIVATE-TOKEN` header, and assembles a standard unified diff (new / deleted /
// renamed / modified file shapes); `postMergeRequestNote` POSTs the body to
// `/notes` and returns the created note's id; `updateMergeRequestNote` PUTs a
// new body onto `/notes/:note_id`; a non-2xx surfaces a `GitlabApiError`.

import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  assembleUnifiedDiff,
  fetchMergeRequestDiff,
  GitlabApiError,
  postMergeRequestNote,
  updateMergeRequestNote,
  type GitlabMrDiffFile,
} from "./index";

const BASE = "https://gitlab.com/api/v4";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const file = (over: Partial<GitlabMrDiffFile>): GitlabMrDiffFile => ({
  old_path: "src/x.ts",
  new_path: "src/x.ts",
  new_file: false,
  renamed_file: false,
  deleted_file: false,
  diff: "@@ -1 +1 @@\n-const x = 1;\n+const x = 2;\n",
  ...over,
});

describe("assembleUnifiedDiff (pure)", () => {
  it("emits a/old + b/new headers for a modified file", () => {
    const out = assembleUnifiedDiff([file({})]);
    expect(out).toContain("diff --git a/src/x.ts b/src/x.ts");
    expect(out).toContain("--- a/src/x.ts");
    expect(out).toContain("+++ b/src/x.ts");
    expect(out).toContain("+const x = 2;");
  });

  it("a new file uses /dev/null on the minus side", () => {
    const out = assembleUnifiedDiff([
      file({ new_file: true, old_path: "src/new.ts", new_path: "src/new.ts", diff: "@@ -0,0 +1 @@\n+new\n" }),
    ]);
    expect(out).toContain("diff --git a/src/new.ts b/src/new.ts");
    expect(out).toContain("--- /dev/null");
    expect(out).toContain("+++ b/src/new.ts");
  });

  it("a deleted file uses /dev/null on the plus side", () => {
    const out = assembleUnifiedDiff([
      file({ deleted_file: true, old_path: "gone.ts", new_path: "gone.ts", diff: "@@ -1 +0,0 @@\n-gone\n" }),
    ]);
    expect(out).toContain("--- a/gone.ts");
    expect(out).toContain("+++ /dev/null");
  });

  it("a renamed file keeps distinct a/old + b/new paths", () => {
    const out = assembleUnifiedDiff([
      file({ renamed_file: true, old_path: "old/name.ts", new_path: "new/name.ts", diff: "" }),
    ]);
    expect(out).toContain("diff --git a/old/name.ts b/new/name.ts");
    expect(out).toContain("--- a/old/name.ts");
    expect(out).toContain("+++ b/new/name.ts");
  });

  it("concatenates multiple file sections", () => {
    const out = assembleUnifiedDiff([
      file({ new_path: "a.ts", old_path: "a.ts" }),
      file({ new_path: "b.ts", old_path: "b.ts" }),
    ]);
    expect(out.match(/diff --git/g)).toHaveLength(2);
  });
});

describe("fetchMergeRequestDiff", () => {
  it("sends PRIVATE-TOKEN, assembles the diff, hits the /diffs endpoint", async () => {
    let authHeader: string | null = null;
    server.use(
      http.get(`${BASE}/projects/:project/merge_requests/:iid/diffs`, ({ request, params }) => {
        authHeader = request.headers.get("PRIVATE-TOKEN");
        expect(params.project).toBe("42");
        expect(params.iid).toBe("7");
        return HttpResponse.json([file({})], {
          headers: { "x-next-page": "" },
        });
      }),
    );

    const result = await fetchMergeRequestDiff({
      token: "glpat-abc",
      projectId: 42,
      iid: 7,
    });
    expect(authHeader).toBe("glpat-abc");
    expect(result.diff).toContain("diff --git a/src/x.ts b/src/x.ts");
    expect(result.diff).toContain("+const x = 2;");
    expect(result.truncated).toBe(false);
    expect(result.pages).toBe(1);
  });

  it("follows x-next-page across pages", async () => {
    server.use(
      http.get(`${BASE}/projects/:project/merge_requests/:iid/diffs`, ({ request }) => {
        const page = new URL(request.url).searchParams.get("page");
        if (page === "1") {
          return HttpResponse.json(
            [file({ old_path: "p1.ts", new_path: "p1.ts" })],
            { headers: { "x-next-page": "2" } },
          );
        }
        return HttpResponse.json(
          [file({ old_path: "p2.ts", new_path: "p2.ts" })],
          { headers: { "x-next-page": "" } },
        );
      }),
    );

    const result = await fetchMergeRequestDiff({ token: "t", projectId: 1, iid: 2 });
    expect(result.diff).toContain("a/p1.ts");
    expect(result.diff).toContain("a/p2.ts");
    expect(result.diff.match(/diff --git/g)).toHaveLength(2);
    expect(result.truncated).toBe(false);
    expect(result.pages).toBe(2);
  });

  it("URL-encodes a non-numeric iid so it cannot inject path segments", async () => {
    let seenUrl = "";
    server.use(
      http.get(`${BASE}/projects/:project/merge_requests/:iid/diffs`, ({ request }) => {
        seenUrl = request.url;
        return HttpResponse.json([], { headers: { "x-next-page": "" } });
      }),
    );
    // A forged iid carrying a path-traversal payload.
    await fetchMergeRequestDiff({
      token: "t",
      projectId: 1,
      iid: "../../projects/2/merge_requests/1" as unknown as number,
    });
    // The slashes are percent-encoded — no extra `/projects/2/...` segments leak.
    expect(seenUrl).toContain("%2F");
    expect(seenUrl).not.toContain("/projects/2/merge_requests/1/diffs");
  });

  it("surfaces a 401 as a normalized GitlabApiError", async () => {
    server.use(
      http.get(`${BASE}/projects/:project/merge_requests/:iid/diffs`, () =>
        HttpResponse.json({ message: "401 Unauthorized" }, { status: 401 }),
      ),
    );
    await expect(
      fetchMergeRequestDiff({ token: "bad", projectId: 1, iid: 2 }),
    ).rejects.toBeInstanceOf(GitlabApiError);
  });

  it("an MR with zero diff entries resolves to an empty string, not a throw", async () => {
    server.use(
      http.get(`${BASE}/projects/:project/merge_requests/:iid/diffs`, () =>
        HttpResponse.json([], { headers: { "x-next-page": "" } }),
      ),
    );
    const result = await fetchMergeRequestDiff({ token: "t", projectId: 1, iid: 2 });
    expect(result).toEqual({ diff: "", truncated: false, pages: 1 });
  });

  it("stops early and marks truncated when the assembled diff exceeds 1 MiB", async () => {
    // Each file's hunk body alone is ~600 KiB — two of them exceed the 1 MiB
    // cap, so the second is dropped and `truncated` is set.
    const big = "+".repeat(600 * 1024) + "\n";
    server.use(
      http.get(`${BASE}/projects/:project/merge_requests/:iid/diffs`, () =>
        HttpResponse.json(
          [
            file({ old_path: "a.ts", new_path: "a.ts", diff: big }),
            file({ old_path: "b.ts", new_path: "b.ts", diff: big }),
          ],
          { headers: { "x-next-page": "" } },
        ),
      ),
    );
    const result = await fetchMergeRequestDiff({ token: "t", projectId: 1, iid: 2 });
    expect(result.truncated).toBe(true);
    expect(result.diff).toContain("a/a.ts");
    expect(result.diff).not.toContain("a/b.ts");
  });

  it("truncates the first file in place (never drops it) when it alone exceeds the 1 MiB cap", async () => {
    const huge = "+".repeat(2 * 1024 * 1024) + "\n";
    server.use(
      http.get(`${BASE}/projects/:project/merge_requests/:iid/diffs`, () =>
        HttpResponse.json(
          [file({ old_path: "huge.ts", new_path: "huge.ts", diff: huge })],
          { headers: { "x-next-page": "" } },
        ),
      ),
    );
    const result = await fetchMergeRequestDiff({ token: "t", projectId: 1, iid: 2 });
    expect(result.diff).toContain("a/huge.ts");
    // A single oversized file no longer rides through the cap untouched —
    // the assembled diff still fits under the 1 MiB budget, and the result
    // is honestly marked truncated.
    expect(result.diff.length).toBeLessThanOrEqual(1024 * 1024);
    expect(result.diff.length).toBeGreaterThan(1000 * 1024);
    expect(result.truncated).toBe(true);
  });

  it("truncates the first file at a line boundary, never mid-line", async () => {
    // ~200,000 lines of ~10 bytes each is comfortably over the 1 MiB cap.
    const lines = Array.from({ length: 200_000 }, (_, i) => `+line ${i}`).join("\n") + "\n";
    server.use(
      http.get(`${BASE}/projects/:project/merge_requests/:iid/diffs`, () =>
        HttpResponse.json(
          [file({ old_path: "big.ts", new_path: "big.ts", diff: lines })],
          { headers: { "x-next-page": "" } },
        ),
      ),
    );
    const result = await fetchMergeRequestDiff({ token: "t", projectId: 1, iid: 2 });
    expect(result.truncated).toBe(true);
    expect(result.diff.length).toBeLessThanOrEqual(1024 * 1024);
    // Ends with a full line (a trailing newline), never a "+line NNN" chopped
    // mid-way through its digits.
    expect(result.diff.endsWith("\n")).toBe(true);
    const lastLine = result.diff.trimEnd().split("\n").pop()!;
    expect(lastLine).toMatch(/^\+line \d+$/);
  });

  it("marks truncated when the page cap is hit with more pages still reported", async () => {
    server.use(
      http.get(`${BASE}/projects/:project/merge_requests/:iid/diffs`, ({ request }) => {
        const page = new URL(request.url).searchParams.get("page");
        const n = Number(page ?? "1");
        return HttpResponse.json(
          [file({ old_path: `p${n}.ts`, new_path: `p${n}.ts` })],
          { headers: { "x-next-page": String(n + 1) } },
        );
      }),
    );
    const result = await fetchMergeRequestDiff({ token: "t", projectId: 1, iid: 2 });
    expect(result.truncated).toBe(true);
    expect(result.pages).toBe(50);
  });
});

describe("postMergeRequestNote", () => {
  it("POSTs the body to /notes with the PRIVATE-TOKEN header, returns the note id", async () => {
    let captured: { auth: string | null; body: Record<string, unknown> } | undefined;
    server.use(
      http.post(`${BASE}/projects/:project/merge_requests/:iid/notes`, async ({ request }) => {
        captured = {
          auth: request.headers.get("PRIVATE-TOKEN"),
          body: (await request.json()) as Record<string, unknown>,
        };
        return HttpResponse.json({ id: 999 }, { status: 201 });
      }),
    );

    const noteId = await postMergeRequestNote({
      token: "glpat-xyz",
      projectId: 42,
      iid: 7,
      body: "AI review summary",
    });
    expect(captured?.auth).toBe("glpat-xyz");
    expect(captured?.body.body).toBe("AI review summary");
    expect(noteId).toBe("999");
  });

  it("a response body with no id resolves to null (never throws)", async () => {
    server.use(
      http.post(`${BASE}/projects/:project/merge_requests/:iid/notes`, () =>
        HttpResponse.json({}, { status: 201 }),
      ),
    );
    const noteId = await postMergeRequestNote({ token: "t", projectId: 1, iid: 2, body: "x" });
    expect(noteId).toBeNull();
  });

  it("an empty-string id resolves to null, never a blank string", async () => {
    server.use(
      http.post(`${BASE}/projects/:project/merge_requests/:iid/notes`, () =>
        HttpResponse.json({ id: "" }, { status: 201 }),
      ),
    );
    const noteId = await postMergeRequestNote({ token: "t", projectId: 1, iid: 2, body: "x" });
    expect(noteId).toBeNull();
  });

  it("a non-scalar id (object/array/boolean) resolves to null, never a stringified nonsense value", async () => {
    for (const badId of [{ nested: true }, [1, 2], true, Number.NaN]) {
      server.use(
        http.post(`${BASE}/projects/:project/merge_requests/:iid/notes`, () =>
          HttpResponse.json({ id: badId }, { status: 201 }),
        ),
      );
      const noteId = await postMergeRequestNote({ token: "t", projectId: 1, iid: 2, body: "x" });
      expect(noteId).toBeNull();
    }
  });

  it("a whitespace-padded numeric id (a string) is kept and trimmed, not rejected as blank", async () => {
    server.use(
      http.post(`${BASE}/projects/:project/merge_requests/:iid/notes`, () =>
        HttpResponse.json({ id: "  42  " }, { status: 201 }),
      ),
    );
    const noteId = await postMergeRequestNote({ token: "t", projectId: 1, iid: 2, body: "x" });
    // Trimmed: `updateReview` PUTs against this id, and a padded id is not a note id.
    expect(noteId).toBe("42");
  });

  it("surfaces a non-2xx as a GitlabApiError", async () => {
    server.use(
      http.post(`${BASE}/projects/:project/merge_requests/:iid/notes`, () =>
        HttpResponse.json({ message: "404 Not found" }, { status: 404 }),
      ),
    );
    await expect(
      postMergeRequestNote({ token: "t", projectId: 1, iid: 2, body: "x" }),
    ).rejects.toBeInstanceOf(GitlabApiError);
  });
});

describe("updateMergeRequestNote", () => {
  it("PUTs the body to /notes/:note_id with the PRIVATE-TOKEN header", async () => {
    let captured: { auth: string | null; body: Record<string, unknown>; url: string } | undefined;
    server.use(
      http.put(`${BASE}/projects/:project/merge_requests/:iid/notes/:noteId`, async ({ request, params }) => {
        captured = {
          auth: request.headers.get("PRIVATE-TOKEN"),
          body: (await request.json()) as Record<string, unknown>,
          url: request.url,
        };
        expect(params.noteId).toBe("999");
        return HttpResponse.json({ id: 999 }, { status: 200 });
      }),
    );

    await updateMergeRequestNote({
      token: "glpat-xyz",
      projectId: 42,
      iid: 7,
      noteId: "999",
      body: "updated review",
    });
    expect(captured?.auth).toBe("glpat-xyz");
    expect(captured?.body.body).toBe("updated review");
  });

  it("surfaces a 404 (deleted note) as a GitlabApiError", async () => {
    server.use(
      http.put(`${BASE}/projects/:project/merge_requests/:iid/notes/:noteId`, () =>
        HttpResponse.json({ message: "404 Not found" }, { status: 404 }),
      ),
    );
    await expect(
      updateMergeRequestNote({ token: "t", projectId: 1, iid: 2, noteId: "gone", body: "x" }),
    ).rejects.toMatchObject({ status: 404 });
  });
});
