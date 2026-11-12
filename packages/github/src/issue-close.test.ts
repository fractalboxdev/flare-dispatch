// The REST contract of a duplicate close: resolve the repository-local original number to its global issue ID,
// carry that ID into GitHub's supported duplicate_issue_id field, and fail a read without credentials.
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { GithubHttpError } from "./client.ts";
import { installationQuotaLayer } from "./rate-limit.ts";
import { GithubWrites, githubWritesLayer } from "./writes.ts";

describe("duplicate issue HTTP calls", () => {
  it("[FD-AGT-075] closes as a duplicate using the original's global ID", async () => {
    const calls: { method: string; path: string; body: unknown }[] = [];
    const fetch = (async (input, init) => {
      const path = new URL(String(input)).pathname;
      calls.push({
        method: init?.method ?? "GET",
        path,
        body: init?.body === undefined ? null : JSON.parse(String(init.body)),
      });
      return Response.json({
        id: 303,
        number: 3,
        body: "original report",
        state: "open",
        state_reason: null,
      });
    }) as typeof globalThis.fetch;
    await Effect.runPromise(
      GithubWrites.use((w) =>
        Effect.gen(function* () {
          const original = yield* w.issue({ installation: 7, repo: "acme/app", issue: 3 });
          yield* w.closeIssue({
            installation: 7,
            repo: "acme/app",
            issue: 9,
            duplicateIssueId: original.id,
          });
        }),
      ).pipe(
        Effect.provide(
          githubWritesLayer({ fetch, token: () => Effect.succeed("token") }).pipe(
            Layer.provide(installationQuotaLayer()),
          ),
        ),
      ),
    );
    expect(calls).toEqual([
      { method: "GET", path: "/repos/acme/app/issues/3", body: null },
      {
        method: "PATCH",
        path: "/repos/acme/app/issues/9",
        body: { state: "closed", state_reason: "duplicate", duplicate_issue_id: 303 },
      },
    ]);
  });

  it("[FD-AGT-042] an uncredentialed issue read fails before any HTTP call", async () => {
    let calls = 0;
    const layer = githubWritesLayer({
      fetch: async () => {
        calls++;
        return Response.json({});
      },
      token: () =>
        Effect.fail(
          new GithubHttpError({
            status: 401,
            message: "no installation credential",
            rateLimited: false,
          }),
        ),
    });
    const result = await Effect.runPromise(
      GithubWrites.use((w) => w.issue({ installation: 7, repo: "acme/app", issue: 9 })).pipe(
        Effect.result,
        Effect.provide(layer),
        Effect.provide(installationQuotaLayer()),
      ),
    );
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "GithubHttpError", status: 401 },
    });
    expect(calls).toBe(0);
  });
});
