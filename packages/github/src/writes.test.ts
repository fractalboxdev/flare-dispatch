// The REST adapter must finish reading a comment thread before a marker lookup can prove absence. These tests use
// the live adapter, including its HTTP pagination, rather than the in-memory writer's complete comment collection.
import { Effect, Layer } from "effect";
import { AlarmPort, type IntentRow } from "@fractalboxdev/mameko-ports";
import { describe, expect, it } from "vitest";
import { githubAppLayer } from "./app.ts";
import { InstallationDirectory } from "./directory.ts";
import { BOT } from "./fake-writes.test-support.ts";
import { installationQuotaLayer } from "./rate-limit.ts";
import { intentMarker, makeSideOutputApplier } from "./side-applier.ts";
import { SideOutputConfig } from "./side-ports.ts";
import { COMMENT_PAGES, GithubWrites, githubWritesLayer, type Commented } from "./writes.ts";

const REPO = "acme/app";
const MARKER = "<!-- flare-dispatch: pr-review -->";
const OLDER = "01K97WGW010000000000000000";
const NEWER = "01K97WGW020000000000000000";
const target = { installation: 7, repo: REPO, issue: 7 };
const row = (id = NEWER): IntentRow => ({
  executionId: id,
  scopeId: REPO,
  intentKey: "run:comment:0",
  kind: "comment",
  payload: { issue_number: 7, body: `review ${id}`, marker: MARKER },
  payloadDigest: id,
  effectClass: "adoptable",
  attempts: 0,
});

const thread = (count: number): Commented[] =>
  Array.from({ length: count }, (_, i) => ({
    id: i + 1,
    body: "discussion",
    user: { login: "dev" },
  }));

/** A paginated issue-comment endpoint; every response is a JSON snapshot, like an HTTP response from GitHub. */
const api = (initial: readonly Commented[], incomplete?: "failed-page" | "bound") => {
  const comments = [...initial];
  const calls: string[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    calls.push(`${method} ${url.pathname}${url.search}`);
    if (method === "GET") {
      const page = Number(url.searchParams.get("page") ?? 1);
      if (incomplete === "failed-page" && page === 2)
        return Response.json({ message: "bad gateway" }, { status: 502 });
      return Response.json(
        incomplete === "bound" ? thread(100) : comments.slice((page - 1) * 100, page * 100),
      );
    }
    const body = (JSON.parse(String(init?.body)) as { body: string }).body;
    if (method === "PATCH") {
      const index = comments.findIndex((c) => c.id === Number(url.pathname.split("/").pop()));
      comments[index] = { ...comments[index]!, body };
      return Response.json(comments[index]);
    }
    const created = { id: comments.length + 1, body, user: { login: BOT.login } };
    comments.push(created);
    return Response.json(created, { status: 201 });
  }) as typeof globalThis.fetch;
  return { comments, calls, fetch };
};

const ports = (fetch: typeof globalThis.fetch) =>
  Layer.mergeAll(
    githubWritesLayer({ fetch, token: () => Effect.succeed("installation-token") }).pipe(
      Layer.provide(installationQuotaLayer()),
    ),
    // A comment needs no App JWT; the real App layer leaves its signing key lazy.
    githubAppLayer({ appId: "1", privateKeyPem: "unused", fetch }),
    Layer.succeed(InstallationDirectory, { installationFor: () => Effect.succeed(7) }),
    Layer.succeed(AlarmPort, { deliver: () => Effect.void }),
    Layer.succeed(SideOutputConfig, { appBot: BOT, slack: undefined, fetch }),
  );

const applier = async (fetch: typeof globalThis.fetch) => {
  const a = await Effect.runPromise(makeSideOutputApplier.pipe(Effect.provide(ports(fetch))));
  return {
    apply: (r: IntentRow) => Effect.runPromise(a.apply(r)),
    lookup: (r: IntentRow) => Effect.runPromise(a.lookup(r)),
  };
};

describe("issue-comment HTTP pagination", () => {
  it("[FD-GH-092] returns the complete thread in creation order, including a short final page", async () => {
    const w = api(thread(205));
    const comments = await Effect.runPromise(
      GithubWrites.use((writes) => writes.listComments(target)).pipe(
        Effect.provide(ports(w.fetch)),
      ),
    );
    expect(comments).toEqual(w.comments);
    expect(w.calls).toHaveLength(3);
    expect(w.calls[1]).toContain("page=2");
    expect(w.calls[2]).toContain("page=3");
  });

  it("[FD-AGT-053] updates a review beyond the first 100 comments and adopts it on replay", async () => {
    const initial = thread(100);
    initial.push({
      id: 101,
      body: `old review\n\n${MARKER}\n\n${intentMarker(row(OLDER))}`,
      user: { login: BOT.login },
    });
    const w = api(initial);
    const a = await applier(w.fetch);
    expect(await a.apply(row())).toEqual({ _tag: "applied", externalRef: "101" });
    expect(await a.lookup(row())).toEqual({ _tag: "found", externalRef: "101" });
    expect(await a.apply(row())).toEqual({ _tag: "applied", externalRef: "101" });
    expect(w.comments).toHaveLength(101);
    expect(w.comments[100]!.body).toContain(`review ${NEWER}`);
    expect(w.calls.filter((c) => !c.startsWith("GET"))).toEqual([
      `PATCH /repos/${REPO}/issues/comments/101`,
    ]);
  });

  it.each(["failed-page", "bound"] as const)(
    "[FD-GH-092] an incomplete %s read is undetermined and retries without a write",
    async (incomplete) => {
      const w = api(thread(100), incomplete);
      const a = await applier(w.fetch);
      expect(await a.lookup(row())).toMatchObject({ _tag: "undetermined" });
      expect(await a.apply(row())).toMatchObject({ _tag: "retryable" });
      expect(w.calls.filter((c) => !c.startsWith("GET"))).toEqual([]);
      expect(w.comments).toHaveLength(100);
      // The search bound protects the installation's budget; it never turns a truncated list into absence.
      expect(w.calls).toHaveLength(incomplete === "bound" ? COMMENT_PAGES * 2 : 4);
    },
  );
});
