// Unit tests for the live GitLab `Scm` Layer.
//
// The provider-error → `ScmError.reason` mapping is a pure function tested
// directly; the Layer's fetch/post/update + degrade behaviour runs against MSW
// (this suite is plain Node — gitlab-app is provider-neutral fetch code, no
// Workers pool needed).

import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Cause, Effect, Exit, Option } from "effect";
import { GitlabApiError } from "@fractalboxdev/flare-dispatch-gitlab-app";
import { scm, type ChangeRef } from "@fractalboxdev/flare-dispatch-core";
import { makeGitlabScmLive, scmReasonFor } from "./scm-gitlab";

const BASE = "https://gitlab.com/api/v4";

const ref: ChangeRef = {
  project: "42",
  number: 7,
  headSha: "head123",
  baseSha: "base456",
};

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("scmReasonFor (pure)", () => {
  it("maps GitLab statuses onto the ScmError reason union", () => {
    expect(scmReasonFor(new GitlabApiError("x", 401, ""))).toBe("auth-failed");
    expect(scmReasonFor(new GitlabApiError("x", 403, ""))).toBe("auth-failed");
    expect(scmReasonFor(new GitlabApiError("x", 404, ""))).toBe("not-found");
    expect(scmReasonFor(new GitlabApiError("x", 429, ""))).toBe("rate-limited");
    expect(scmReasonFor(new GitlabApiError("x", 500, ""))).toBe("bad-response");
    expect(scmReasonFor(new Error("network"))).toBe("unknown");
  });
});

describe("makeGitlabScmLive — with token", () => {
  it("fetchDiff assembles the MR diff", async () => {
    server.use(
      http.get(`${BASE}/projects/:project/merge_requests/:iid/diffs`, () =>
        HttpResponse.json(
          [
            {
              old_path: "src/x.ts",
              new_path: "src/x.ts",
              new_file: false,
              renamed_file: false,
              deleted_file: false,
              diff: "@@ -1 +1 @@\n-a\n+b\n",
            },
          ],
          { headers: { "x-next-page": "" } },
        ),
      ),
    );
    const layer = makeGitlabScmLive({ token: "glpat-abc" });
    const result = await Effect.runPromise(
      scm.fetchDiff(ref).pipe(Effect.provide(layer)),
    );
    expect(result.diff).toContain("diff --git a/src/x.ts b/src/x.ts");
    expect(result.diff).toContain("+b");
    expect(result.truncated).toBe(false);
    expect(result.pages).toBe(1);
  });

  it("fetchDiff maps a 401 onto ScmError(auth-failed)", async () => {
    server.use(
      http.get(`${BASE}/projects/:project/merge_requests/:iid/diffs`, () =>
        HttpResponse.json({ message: "401" }, { status: 401 }),
      ),
    );
    const layer = makeGitlabScmLive({ token: "bad" });
    const exit = await Effect.runPromiseExit(
      scm.fetchDiff(ref).pipe(Effect.provide(layer)),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = Cause.failureOption(exit.cause);
      // The failure is a typed ScmError with a provider-agnostic reason.
      expect(Option.isSome(failure)).toBe(true);
      if (Option.isSome(failure)) {
        expect(failure.value._tag).toBe("ScmError");
        expect(failure.value.reason).toBe("auth-failed");
        expect(failure.value.provider).toBe("gitlab");
      }
    }
  });

  it("postReview posts a note and returns its id", async () => {
    let posted: unknown;
    server.use(
      http.post(`${BASE}/projects/:project/merge_requests/:iid/notes`, async ({ request }) => {
        posted = await request.json();
        return HttpResponse.json({ id: 1 }, { status: 201 });
      }),
    );
    const layer = makeGitlabScmLive({ token: "glpat-abc" });
    const result = await Effect.runPromise(
      scm.postReview({ ref, body: "hi" }).pipe(Effect.provide(layer)),
    );
    expect(posted).toEqual({ body: "hi" });
    expect(result).toEqual({ noteId: "1" });
  });

  it("updateReview PUTs a new body onto the note", async () => {
    let captured: { url: string; body: unknown } | undefined;
    server.use(
      http.put(`${BASE}/projects/:project/merge_requests/:iid/notes/:noteId`, async ({ request, params }) => {
        captured = { url: request.url, body: await request.json() };
        expect(params.noteId).toBe("1");
        return HttpResponse.json({ id: 1 }, { status: 200 });
      }),
    );
    const layer = makeGitlabScmLive({ token: "glpat-abc" });
    await Effect.runPromise(
      scm.updateReview({ ref, noteId: "1", body: "updated" }).pipe(Effect.provide(layer)),
    );
    expect(captured?.body).toEqual({ body: "updated" });
  });

  it("updateReview maps a 404 (deleted note) onto ScmError(not-found)", async () => {
    server.use(
      http.put(`${BASE}/projects/:project/merge_requests/:iid/notes/:noteId`, () =>
        HttpResponse.json({ message: "404" }, { status: 404 }),
      ),
    );
    const layer = makeGitlabScmLive({ token: "glpat-abc" });
    const exit = await Effect.runPromiseExit(
      scm.updateReview({ ref, noteId: "gone", body: "x" }).pipe(Effect.provide(layer)),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = Cause.failureOption(exit.cause);
      expect(Option.isSome(failure)).toBe(true);
      if (Option.isSome(failure)) {
        expect(failure.value.reason).toBe("not-found");
      }
    }
  });
});

describe("makeGitlabScmLive — degraded (no token)", () => {
  it("fetchDiff fails auth-failed", async () => {
    const layer = makeGitlabScmLive({});
    const exit = await Effect.runPromiseExit(
      scm.fetchDiff(ref).pipe(Effect.provide(layer)),
    );
    expect(Exit.isFailure(exit)).toBe(true);
  });

  it("postReview is a logged no-op (never fails) and returns a null noteId", async () => {
    const layer = makeGitlabScmLive({});
    // No MSW handler registered — a real POST would error the suite, proving
    // the degraded path makes no network call.
    await expect(
      Effect.runPromise(scm.postReview({ ref, body: "x" }).pipe(Effect.provide(layer))),
    ).resolves.toEqual({ noteId: null });
  });

  it("updateReview is a logged no-op (never fails)", async () => {
    const layer = makeGitlabScmLive({});
    await expect(
      Effect.runPromise(
        scm.updateReview({ ref, noteId: "1", body: "x" }).pipe(Effect.provide(layer)),
      ),
    ).resolves.toBeUndefined();
  });
});

describe("makeGitlabScmLive — with token — trimming", () => {
  it("trims surrounding whitespace from the token before sending it", async () => {
    let authHeader: string | null = null;
    server.use(
      http.get(`${BASE}/projects/:project/merge_requests/:iid/diffs`, ({ request }) => {
        authHeader = request.headers.get("PRIVATE-TOKEN");
        return HttpResponse.json([], { headers: { "x-next-page": "" } });
      }),
    );
    const layer = makeGitlabScmLive({ token: "  glpat-abc  " });
    await Effect.runPromise(scm.fetchDiff(ref).pipe(Effect.provide(layer)));
    expect(authHeader).toBe("glpat-abc");
  });

  it("a blank baseUrl degrades to the default API base, not a literal empty apiBase", async () => {
    let seenUrl = "";
    server.use(
      http.get(`${BASE}/projects/:project/merge_requests/:iid/diffs`, ({ request }) => {
        seenUrl = request.url;
        return HttpResponse.json([], { headers: { "x-next-page": "" } });
      }),
    );
    const layer = makeGitlabScmLive({ token: "glpat-abc", baseUrl: "   " });
    await Effect.runPromise(scm.fetchDiff(ref).pipe(Effect.provide(layer)));
    expect(seenUrl.startsWith(BASE)).toBe(true);
  });
});

describe("makeGitlabScmLive — degraded (blank token)", () => {
  it.each([["empty string", ""], ["whitespace-only", "   \n\t"]])(
    "a %s token degrades exactly like an absent one — fetchDiff fails auth-failed with NO fetch call",
    async (_label, blank) => {
      const layer = makeGitlabScmLive({ token: blank });
      // No MSW handler registered for this suite's server — a real request
      // would error under `onUnhandledRequest: "error"`, proving the
      // degraded path makes no network call at all.
      const exit = await Effect.runPromiseExit(
        scm.fetchDiff(ref).pipe(Effect.provide(layer)),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.failureOption(exit.cause);
        expect(Option.isSome(failure)).toBe(true);
        if (Option.isSome(failure)) {
          expect(failure.value.reason).toBe("auth-failed");
        }
      }
    },
  );

  it("a blank token's postReview is also a logged no-op (never fails)", async () => {
    const layer = makeGitlabScmLive({ token: "   " });
    await expect(
      Effect.runPromise(scm.postReview({ ref, body: "x" }).pipe(Effect.provide(layer))),
    ).resolves.toEqual({ noteId: null });
  });
});

describe("makeGitlabScmLive — with token — diff truncation", () => {
  it("carries a truncated/pages result through to the port", async () => {
    const big = "+".repeat(600 * 1024) + "\n";
    server.use(
      http.get(`${BASE}/projects/:project/merge_requests/:iid/diffs`, () =>
        HttpResponse.json(
          [
            { old_path: "a.ts", new_path: "a.ts", new_file: false, renamed_file: false, deleted_file: false, diff: big },
            { old_path: "b.ts", new_path: "b.ts", new_file: false, renamed_file: false, deleted_file: false, diff: big },
          ],
          { headers: { "x-next-page": "" } },
        ),
      ),
    );
    const layer = makeGitlabScmLive({ token: "glpat-abc" });
    const result = await Effect.runPromise(
      scm.fetchDiff(ref).pipe(Effect.provide(layer)),
    );
    expect(result.truncated).toBe(true);
    expect(result.diff).toContain("a/a.ts");
    expect(result.diff).not.toContain("a/b.ts");
  });
});
