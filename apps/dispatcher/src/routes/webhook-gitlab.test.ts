// FlareDispatch Dispatcher — `POST /v1/webhooks/gitlab` acceptance tests.
//
// Drives `handleGitlabWebhook` via the router with a hand-built `Request` + fake
// `Env`. Mirrors the GitHub webhook test contract, adapted to GitLab:
//   no secret configured → 503;
//   bad X-Gitlab-Token → 401;
//   IDEMPOTENCY_KV unbound → 503 (fails closed, no dispatch);
//   non-MR event → 204 ignore;
//   gated (non-reviewable) action → 204 ignore;
//   a payload-shape problem → 202 ignored, never 4xx (GitLab auto-disables on repeated 4xx);
//   open action + valid token → 202, one Workflow.create;
//   duplicate delivery UUID → 202 deduped, no second create.
// Plus a unit test for the constant-time compare helper.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleRequest } from "../router";
import { constantTimeEqual, parseAllowedProjectIds } from "./webhook-gitlab";
import { makeFakeEnv, makeFakeKv, makeFakeR2, makeFakeWorkflow } from "../test-helpers";
import type { Env } from "../env";

const WEBHOOK_SECRET = "gitlab-webhook-secret-please-rotate";

const mrPayload = (action = "open") => ({
  object_kind: "merge_request",
  project: { id: 42, web_url: "https://gitlab.com/group/proj" },
  object_attributes: {
    iid: 7,
    action,
    source_branch: "feature",
    target_branch: "main",
    last_commit: { id: "commitsha1234567890" },
    diff_refs: { base_sha: "basesha", head_sha: "headsha1234567890" },
  },
});

const gitlabRequest = (
  payload: unknown,
  opts: { token?: string; event?: string; deliveryId?: string } = {},
): Request => {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "X-Gitlab-Event": opts.event ?? "Merge Request Hook",
  };
  if (opts.token !== undefined) headers["X-Gitlab-Token"] = opts.token;
  if (opts.deliveryId !== undefined) headers["X-Gitlab-Event-UUID"] = opts.deliveryId;
  return new Request("https://dispatcher.example/v1/webhooks/gitlab", {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
};

const fixture = (
  opts: {
    withSecret?: boolean;
    withWorkflow?: boolean;
    /**
     * IDEMPOTENCY_KV is required by the route (fails closed `503` without
     * it) — present by default here; pass `false` to test that fail-closed
     * path specifically.
     */
    withKv?: boolean;
    configKv?: ReturnType<typeof makeFakeKv>;
    /** Every `create` call throws this message — a genuine dispatch failure. */
    failCreateWith?: string;
    allowedProjectIds?: string;
  } = {},
) => {
  const reviewWorkflow = makeFakeWorkflow(
    opts.failCreateWith !== undefined ? { failAllCreatesWith: opts.failCreateWith } : {},
  );
  const withKv = opts.withKv !== false;
  const idempotencyKv = withKv ? makeFakeKv() : undefined;
  const env: Env = makeFakeEnv({
    hmacSecret: "unused",
    workflow: makeFakeWorkflow(),
    storage: makeFakeR2(),
    idempotencyKv: idempotencyKv?.binding,
    ...(opts.configKv !== undefined ? { configKv: opts.configKv.binding } : {}),
    ...(opts.withSecret === false ? {} : { gitlabWebhookSecret: WEBHOOK_SECRET }),
    ...(opts.withWorkflow === false ? {} : { gitlabReviewWorkflow: reviewWorkflow.binding }),
    ...(opts.allowedProjectIds !== undefined ? { gitlabAllowedProjectIds: opts.allowedProjectIds } : {}),
  });
  return { env, reviewWorkflow, idempotencyKv };
};

describe("POST /v1/webhooks/gitlab", () => {
  it("no webhook secret configured → 503", async () => {
    const { env, reviewWorkflow } = fixture({ withSecret: false });
    const res = await handleRequest(gitlabRequest(mrPayload(), { token: WEBHOOK_SECRET }), env);
    expect(res.status).toBe(503);
    expect(reviewWorkflow.calls).toHaveLength(0);
  });

  it("empty/whitespace webhook secret is treated as unconfigured → 503", async () => {
    const reviewWorkflow = makeFakeWorkflow();
    const env: Env = makeFakeEnv({
      hmacSecret: "unused",
      workflow: makeFakeWorkflow(),
      storage: makeFakeR2(),
      gitlabWebhookSecret: "   ",
      gitlabReviewWorkflow: reviewWorkflow.binding,
    });
    const res = await handleRequest(gitlabRequest(mrPayload(), { token: "   " }), env);
    expect(res.status).toBe(503);
    expect(reviewWorkflow.calls).toHaveLength(0);
  });

  it("forged non-integer iid → 202 ignored, no dispatch (never 4xx — GitLab auto-disables on repeated failures)", async () => {
    const { env, reviewWorkflow } = fixture();
    const forged = {
      object_kind: "merge_request",
      project: { id: 1, web_url: "https://gitlab.com/g/p" },
      object_attributes: {
        iid: "../../projects/2/merge_requests/1",
        action: "open",
        last_commit: { id: "sha" },
        diff_refs: { base_sha: "b", head_sha: "h" },
      },
    };
    const res = await handleRequest(gitlabRequest(forged, { token: WEBHOOK_SECRET }), env);
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ ignored: true });
    expect(reviewWorkflow.calls).toHaveLength(0);
  });

  it("non-positive project.id → 202 ignored, no dispatch", async () => {
    const { env, reviewWorkflow } = fixture();
    const bad = {
      object_kind: "merge_request",
      project: { id: 0, web_url: "https://gitlab.com/g/p" },
      object_attributes: { iid: 7, action: "open", last_commit: { id: "sha" }, diff_refs: { base_sha: "b", head_sha: "h" } },
    };
    const res = await handleRequest(gitlabRequest(bad, { token: WEBHOOK_SECRET }), env);
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ ignored: true });
    expect(reviewWorkflow.calls).toHaveLength(0);
  });

  it("IDEMPOTENCY_KV binding absent → 503 throttle_not_configured, no Workflow create", async () => {
    const { env, reviewWorkflow } = fixture({ withKv: false });
    const res = await handleRequest(gitlabRequest(mrPayload("open"), { token: WEBHOOK_SECRET }), env);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: "throttle_not_configured" });
    expect(reviewWorkflow.calls).toHaveLength(0);
  });

  it("bad X-Gitlab-Token → 401", async () => {
    const { env, reviewWorkflow } = fixture();
    const res = await handleRequest(gitlabRequest(mrPayload(), { token: "wrong" }), env);
    expect(res.status).toBe(401);
    expect(reviewWorkflow.calls).toHaveLength(0);
  });

  it("missing token → 401", async () => {
    const { env } = fixture();
    const res = await handleRequest(gitlabRequest(mrPayload()), env);
    expect(res.status).toBe(401);
  });

  it("non-merge_request event → 204 ignore", async () => {
    const { env, reviewWorkflow } = fixture();
    const res = await handleRequest(
      gitlabRequest(mrPayload(), { token: WEBHOOK_SECRET, event: "Note Hook" }),
      env,
    );
    expect(res.status).toBe(204);
    expect(reviewWorkflow.calls).toHaveLength(0);
  });

  it("non-reviewable action (close) → 204 ignore", async () => {
    const { env, reviewWorkflow } = fixture();
    const res = await handleRequest(
      gitlabRequest(mrPayload("close"), { token: WEBHOOK_SECRET }),
      env,
    );
    expect(res.status).toBe(204);
    expect(reviewWorkflow.calls).toHaveLength(0);
  });

  it("open action + valid token → 202, one Workflow.create with the extracted input", async () => {
    const { env, reviewWorkflow } = fixture();
    const res = await handleRequest(gitlabRequest(mrPayload("open"), { token: WEBHOOK_SECRET }), env);
    expect(res.status).toBe(202);
    expect(reviewWorkflow.calls).toHaveLength(1);
    const call = reviewWorkflow.calls[0]!;
    // The semantic key is sanitized by toInstanceId — CF Workflows rejects ":".
    expect(call.id).toBe("mr-review_42_7_headsha12345");
    const params = call.params as { executionId: string; input: Record<string, unknown> };
    expect(params.input).toMatchObject({
      projectId: "42",
      iid: 7,
      headSha: "headsha1234567890",
      baseSha: "basesha",
      projectWebUrl: "https://gitlab.com/group/proj",
      sourceBranch: "feature",
      targetBranch: "main",
    });
  });

  it("diff_refs null (real gitlab.com payload) → 202, headSha from last_commit.id, baseSha empty", async () => {
    const { env, reviewWorkflow } = fixture();
    const payload = {
      ...mrPayload("open"),
      object_attributes: {
        ...mrPayload("open").object_attributes,
        last_commit: { id: "1111111111111111111111111111111111111111" },
        diff_refs: null,
      },
    };
    const res = await handleRequest(gitlabRequest(payload, { token: WEBHOOK_SECRET }), env);
    expect(res.status).toBe(202);
    expect(reviewWorkflow.calls).toHaveLength(1);
    const params = reviewWorkflow.calls[0]!.params as { input: { headSha: string; baseSha: string } };
    const input = params.input;
    expect(input.headSha).toBe("1111111111111111111111111111111111111111");
    expect(input.baseSha).toBe("");
  });

  it("no diff_refs and no last_commit → 202 ignored (missing head sha)", async () => {
    const { env, reviewWorkflow } = fixture();
    const payload = {
      ...mrPayload("open"),
      object_attributes: { ...mrPayload("open").object_attributes, last_commit: undefined, diff_refs: undefined },
    };
    const res = await handleRequest(gitlabRequest(payload, { token: WEBHOOK_SECRET }), env);
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ ignored: true });
    expect(reviewWorkflow.calls).toHaveLength(0);
  });

  it("a head reviewed under a request-ai-review id is not reviewed again on a plain edit", async () => {
    const { env, reviewWorkflow } = fixture({ withKv: true });
    const labeled = { ...mrPayload("open"), object_attributes: { ...mrPayload("open").object_attributes, labels: [{ title: "request-ai-review" }] } };
    const first = await handleRequest(gitlabRequest(labeled, { token: WEBHOOK_SECRET, deliveryId: "h1" }), env);
    expect(first.status).toBe(202);
    expect(reviewWorkflow.calls).toHaveLength(1);
    // the label comes off: a plain update for the same head
    const second = await handleRequest(gitlabRequest(mrPayload("update"), { token: WEBHOOK_SECRET, deliveryId: "h2" }), env);
    expect(second.status).toBe(202);
    expect(await second.json()).toMatchObject({ deduped: true });
    expect(reviewWorkflow.calls).toHaveLength(1);
    // a new head reviews again
    const newHead = {
      ...mrPayload("update"),
      object_attributes: {
        ...mrPayload("update").object_attributes,
        last_commit: { id: "eeee555555555555" },
        diff_refs: { base_sha: "basesha", head_sha: "eeee555555555555" },
      },
    };
    const third = await handleRequest(gitlabRequest(newHead, { token: WEBHOOK_SECRET, deliveryId: "h3" }), env);
    expect(third.status).toBe(202);
    expect(reviewWorkflow.calls).toHaveLength(2);
  });

  it("workflow binding absent → 503", async () => {
    const { env, reviewWorkflow } = fixture({ withWorkflow: false });
    const res = await handleRequest(gitlabRequest(mrPayload("open"), { token: WEBHOOK_SECRET }), env);
    expect(res.status).toBe(503);
    expect(reviewWorkflow.calls).toHaveLength(0);
  });

  it("duplicate delivery UUID → 202 deduped, no second create", async () => {
    const { env, reviewWorkflow } = fixture({ withKv: true });
    const uuid = "delivery-uuid-1";
    const first = await handleRequest(
      gitlabRequest(mrPayload("open"), { token: WEBHOOK_SECRET, deliveryId: uuid }),
      env,
    );
    expect(first.status).toBe(202);
    expect(reviewWorkflow.calls).toHaveLength(1);
    const second = await handleRequest(
      gitlabRequest(mrPayload("open"), { token: WEBHOOK_SECRET, deliveryId: uuid }),
      env,
    );
    expect(second.status).toBe(202);
    // No SECOND dispatch — the redelivery short-circuited on the KV entry.
    expect(reviewWorkflow.calls).toHaveLength(1);
  });
});

describe("constantTimeEqual", () => {
  it("is true for equal strings, false otherwise (incl. different lengths)", async () => {
    expect(await constantTimeEqual("secret", "secret")).toBe(true);
    expect(await constantTimeEqual("secret", "secreT")).toBe(false);
    expect(await constantTimeEqual("secret", "secret-longer")).toBe(false);
    expect(await constantTimeEqual("", "")).toBe(true);
  });
});
describe("mr-review labels + throttle", () => {
  // The main throttle, the explicit-review cap and the head/dedup markers all
  // key off Date.now() — a fake, fixed clock keeps every assertion here
  // independent of wall time. None of the code under test uses a real timer
  // (setTimeout et al.), so advancing is never needed.
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-15T00:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const withHead = (head: string, labels?: Array<{ title: string }>) => ({
    object_kind: "merge_request",
    project: { id: 42, web_url: "https://gitlab.com/group/proj" },
    object_attributes: { iid: 7, action: "open", source_branch: "feature", target_branch: "main", last_commit: { id: head }, diff_refs: { base_sha: "basesha", head_sha: head }, ...(labels !== undefined ? { labels } : {}) },
  });
  const tok = (env: Env) => { (env as unknown as Record<string, unknown>).GITLAB_TOKEN = "tok"; };
  const stub = (notes: string[]) => {
    const prev = globalThis.fetch;
    globalThis.fetch = (async (u: unknown, init?: { body?: unknown }) => {
      if (String(u).includes("/notes")) { notes.push(String(init?.body ?? "")); return new Response("{}", { status: 201 }); }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    return prev;
  };
  it("4th throttles one note; 5th no second note", async () => {
    const { env, reviewWorkflow } = fixture({ withKv: true });
    tok(env);
    const notes: string[] = [];
    const prev = stub(notes);
    try {
      const shas = ["aaaa111111111111", "bbbb222222222222", "cccc333333333333", "dddd444444444444"];
      for (let i = 0; i < 3; i++) await handleRequest(gitlabRequest(withHead(shas[i]!), { token: WEBHOOK_SECRET, deliveryId: `a${i}` }), env);
      expect(reviewWorkflow.calls).toHaveLength(3);
      const f = await handleRequest(gitlabRequest(withHead(shas[3]!), { token: WEBHOOK_SECRET, deliveryId: "a3" }), env);
      expect(f.status).toBe(202);
      expect(await f.json()).toMatchObject({ status: "throttled" });
      expect(reviewWorkflow.calls).toHaveLength(3);
      expect(notes).toHaveLength(1);
      expect(notes[0]).toContain("<!-- flare-dispatch: mr-review-throttle -->");
      const g = await handleRequest(gitlabRequest(withHead("eeee555555555555"), { token: WEBHOOK_SECRET, deliveryId: "a4" }), env);
      expect(await g.json()).toMatchObject({ status: "throttled" });
      expect(notes).toHaveLength(1);
    } finally { globalThis.fetch = prev; }
  });
  it("throttle note reaches the configured GITLAB_BASE_URL, never gitlab.com, when one is set", async () => {
    const { env, reviewWorkflow } = fixture({ withKv: true });
    tok(env);
    (env as unknown as Record<string, unknown>).GITLAB_BASE_URL = "https://gitlab.example.com/api/v4";
    const urls: string[] = [];
    const prev = globalThis.fetch;
    globalThis.fetch = (async (u: unknown) => {
      urls.push(String(u));
      return new Response("{}", { status: 201 });
    }) as typeof fetch;
    try {
      const shas = ["baba111111111111", "bcbc222222222222", "bdbd333333333333", "bebe444444444444"];
      for (let i = 0; i < 3; i++) await handleRequest(gitlabRequest(withHead(shas[i]!), { token: WEBHOOK_SECRET, deliveryId: `bu${i}` }), env);
      expect(reviewWorkflow.calls).toHaveLength(3);
      await handleRequest(gitlabRequest(withHead(shas[3]!), { token: WEBHOOK_SECRET, deliveryId: "bu3" }), env);
      const noteUrl = urls.find((u) => u.includes("/notes"));
      expect(noteUrl).toBeDefined();
      expect(noteUrl).toMatch(/^https:\/\/gitlab\.example\.com\/api\/v4\//);
      expect(noteUrl).not.toContain("gitlab.com");
    } finally {
      globalThis.fetch = prev;
    }
  });
  it("throttle note falls back to gitlab.com when GITLAB_BASE_URL is unset", async () => {
    const { env, reviewWorkflow } = fixture({ withKv: true });
    tok(env);
    const urls: string[] = [];
    const prev = globalThis.fetch;
    globalThis.fetch = (async (u: unknown) => {
      urls.push(String(u));
      return new Response("{}", { status: 201 });
    }) as typeof fetch;
    try {
      const shas = ["caca111111111111", "cbcb222222222222", "cdcd333333333333", "cece444444444444"];
      for (let i = 0; i < 3; i++) await handleRequest(gitlabRequest(withHead(shas[i]!), { token: WEBHOOK_SECRET, deliveryId: `bd${i}` }), env);
      expect(reviewWorkflow.calls).toHaveLength(3);
      await handleRequest(gitlabRequest(withHead(shas[3]!), { token: WEBHOOK_SECRET, deliveryId: "bd3" }), env);
      const noteUrl = urls.find((u) => u.includes("/notes"));
      expect(noteUrl).toBeDefined();
      expect(noteUrl).toMatch(/^https:\/\/gitlab\.com\/api\/v4\//);
    } finally {
      globalThis.fetch = prev;
    }
  });
  it("request-ai-review bypasses", async () => {
    const { env, reviewWorkflow } = fixture({ withKv: true });
    tok(env);
    const prev = stub([]);
    try {
      for (const [i, s] of ["aaaa111111111111", "bbbb222222222222", "cccc333333333333"].entries()) await handleRequest(gitlabRequest(withHead(s), { token: WEBHOOK_SECRET, deliveryId: `b${i}` }), env);
      const r = await handleRequest(gitlabRequest(withHead("dddd444444444444", [{ title: "request-ai-review" }]), { token: WEBHOOK_SECRET, deliveryId: "b3" }), env);
      expect(await r.json()).toMatchObject({ accepted: true });
      expect(reviewWorkflow.calls).toHaveLength(4);
      // an explicit request gets its own instance id, so a head that already ran is reviewed again
      expect((reviewWorkflow.calls[3]!.params as { executionId: string }).executionId).toMatch(/_r\d+$/);
    } finally { globalThis.fetch = prev; }
  });

  describe("request-ai-review's own rolling cap", () => {
    it("6 explicit reviews succeed; the 7th within the window is throttled (scope: explicit), no note, no create", async () => {
      const { env, reviewWorkflow } = fixture({ withKv: true });
      tok(env);
      const prev = stub([]);
      try {
        for (let i = 0; i < 6; i++) {
          const res = await handleRequest(
            gitlabRequest(withHead(`head${i}00000000000`, [{ title: "request-ai-review" }]), {
              token: WEBHOOK_SECRET,
              deliveryId: `e${i}`,
            }),
            env,
          );
          expect(res.status).toBe(202);
        }
        expect(reviewWorkflow.calls).toHaveLength(6);
        const seventh = await handleRequest(
          gitlabRequest(withHead("head700000000000", [{ title: "request-ai-review" }]), {
            token: WEBHOOK_SECRET,
            deliveryId: "e6",
          }),
          env,
        );
        expect(seventh.status).toBe(202);
        expect(await seventh.json()).toEqual({ status: "throttled", scope: "explicit" });
        expect(reviewWorkflow.calls).toHaveLength(6);
      } finally {
        globalThis.fetch = prev;
      }
    });

    it("the explicit cap has its own ceiling, above the main throttle's 3-per-window (proves the counters are separate)", async () => {
      const { env, reviewWorkflow } = fixture({ withKv: true });
      tok(env);
      const prev = stub([]);
      try {
        // 5 explicit reviews on 5 distinct heads succeed in a row — past the
        // main throttle's cap of 3. If bypass requests were CHECKED against
        // that same counter (instead of their own `throttle-bypass:` key),
        // the 4th of these would already be throttled.
        for (let i = 0; i < 5; i++) {
          const res = await handleRequest(
            gitlabRequest(withHead(`ex${i}0000000000`, [{ title: "request-ai-review" }]), {
              token: WEBHOOK_SECRET,
              deliveryId: `m${i}`,
            }),
            env,
          );
          expect(res.status).toBe(202);
          expect(await res.json()).toMatchObject({ accepted: true });
        }
        expect(reviewWorkflow.calls).toHaveLength(5);
      } finally {
        globalThis.fetch = prev;
      }
    });

    it("the explicit instance id suffix is epoch SECONDS, not minutes", async () => {
      const { env, reviewWorkflow } = fixture({ withKv: true });
      tok(env);
      const prev = stub([]);
      try {
        const res = await handleRequest(
          gitlabRequest(withHead("aaaa111111111111", [{ title: "request-ai-review" }]), {
            token: WEBHOOK_SECRET,
            deliveryId: "sfx-1",
          }),
          env,
        );
        expect(res.status).toBe(202);
        const id = (reviewWorkflow.calls[0]!.params as { executionId: string }).executionId;
        // The frozen system time is 2026-09-15T00:00:00Z — epoch seconds, not
        // epoch minutes (which would be ~3 orders of magnitude smaller).
        const expectedSeconds = Math.floor(new Date("2026-09-15T00:00:00Z").getTime() / 1000);
        expect(id).toMatch(new RegExp(`_r${expectedSeconds}$`));
      } finally {
        globalThis.fetch = prev;
      }
    });

    it("a duplicate create (id already exists) does not consume an explicit-cap slot", async () => {
      // The instance id this bypass request mints already exists (e.g. a
      // redelivery of the same webhook landing on the same second) — `create`
      // reports `already_exists` and no review actually starts. That must
      // not also record a slot in the explicit-review cap.
      const expectedSeconds = Math.floor(new Date("2026-09-15T00:00:00Z").getTime() / 1000);
      const dupId = `mr-review_42_7_aaaa11111111_r${expectedSeconds}`;
      const dupWorkflow = makeFakeWorkflow({ throwAlreadyExistsFor: new Set([dupId]) });
      const idempotencyKv = makeFakeKv();
      const env: Env = makeFakeEnv({
        hmacSecret: "unused",
        workflow: makeFakeWorkflow(),
        storage: makeFakeR2(),
        idempotencyKv: idempotencyKv.binding,
        gitlabWebhookSecret: WEBHOOK_SECRET,
        gitlabReviewWorkflow: dupWorkflow.binding,
      });
      tok(env);
      const prev = stub([]);
      try {
        const labeled = withHead("aaaa111111111111", [{ title: "request-ai-review" }]);
        const res = await handleRequest(gitlabRequest(labeled, { token: WEBHOOK_SECRET, deliveryId: "dup-1" }), env);
        expect(res.status).toBe(202);
        expect(await res.json()).toMatchObject({ accepted: true, executionId: dupId });
        // No create call actually landed — it hit already_exists.
        expect(dupWorkflow.calls).toHaveLength(0);
        expect(await idempotencyKv.binding.get("throttle-bypass:42:7")).toBeNull();
      } finally {
        globalThis.fetch = prev;
      }
    });
  });

  it("skip-ai-review 204", async () => {
    const { env, reviewWorkflow } = fixture({ withKv: true });
    const r = await handleRequest(gitlabRequest(withHead("ffff666666666666", [{ title: "skip-ai-review" }]), { token: WEBHOOK_SECRET, deliveryId: "s1" }), env);
    expect(r.status).toBe(204);
    expect(reviewWorkflow.calls).toHaveLength(0);
  });
  it("no KV → fails closed (503), not a single one of 4 deliveries dispatches", async () => {
    const { env, reviewWorkflow } = fixture({ withKv: false });
    for (const [i, s] of ["aaaa111111111111", "bbbb222222222222", "cccc333333333333", "dddd444444444444"].entries()) {
      const res = await handleRequest(gitlabRequest(withHead(s), { token: WEBHOOK_SECRET, deliveryId: `n${i}` }), env);
      expect(res.status).toBe(503);
    }
    expect(reviewWorkflow.calls).toHaveLength(0);
  });
  it("null JSON body → 202 ignored, never 400", async () => {
    const { env, reviewWorkflow } = fixture({ withKv: true });
    const res = await handleRequest(gitlabRequest(null, { token: WEBHOOK_SECRET }), env);
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ ignored: true });
    expect(reviewWorkflow.calls).toHaveLength(0);
  });
  it("future starts do not throttle", async () => {
    const { env, reviewWorkflow } = fixture({ withKv: true });
    const future = Date.now() + 60 * 60 * 1000;
    await env.IDEMPOTENCY_KV!.put(`throttle:42:7`, JSON.stringify({ starts: [future] }), { expirationTtl: 900 });
    const res = await handleRequest(gitlabRequest(withHead("ffff666666666666"), { token: WEBHOOK_SECRET, deliveryId: "f1" }), env);
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ accepted: true });
    expect(reviewWorkflow.calls).toHaveLength(1);
  });
  it("create() throws → the delivery-UUID marker is NOT written, so the same delivery redispatches on retry", async () => {
    const { env, reviewWorkflow, idempotencyKv } = fixture({
      withKv: true,
      failCreateWith: "platform error: workerd crashed",
    });
    const uuid = "retry-uuid-1";
    const first = await handleRequest(gitlabRequest(withHead("aaaa111111111111"), { token: WEBHOOK_SECRET, deliveryId: uuid }), env);
    expect(first.status).toBe(500);
    expect(reviewWorkflow.calls).toHaveLength(0);
    // Redeliver the SAME UUID against a working Workflow binding but the SAME
    // IDEMPOTENCY_KV — the marker must be absent, so the retry actually dispatches.
    const working = makeFakeWorkflow();
    const retryEnv: Env = makeFakeEnv({
      hmacSecret: "unused",
      workflow: makeFakeWorkflow(),
      storage: makeFakeR2(),
      idempotencyKv: idempotencyKv!.binding,
      gitlabWebhookSecret: WEBHOOK_SECRET,
      gitlabReviewWorkflow: working.binding,
    });
    const second = await handleRequest(gitlabRequest(withHead("aaaa111111111111"), { token: WEBHOOK_SECRET, deliveryId: uuid }), retryEnv);
    expect(second.status).toBe(202);
    expect(await second.json()).toMatchObject({ accepted: true });
    expect(working.calls).toHaveLength(1);
  });
});

describe("mr-review project allowlist (GITLAB_ALLOWED_PROJECT_IDS)", () => {
  it("unset → every project is allowed (unaffected)", async () => {
    const { env, reviewWorkflow } = fixture();
    const res = await handleRequest(gitlabRequest(mrPayload("open"), { token: WEBHOOK_SECRET }), env);
    expect(res.status).toBe(202);
    expect(reviewWorkflow.calls).toHaveLength(1);
  });

  it("project.id not in the list → 202 ignored, no dispatch", async () => {
    const { env, reviewWorkflow } = fixture({ allowedProjectIds: "1,2,3" });
    const res = await handleRequest(gitlabRequest(mrPayload("open"), { token: WEBHOOK_SECRET }), env);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ignored: true, reason: "project not allowed" });
    expect(reviewWorkflow.calls).toHaveLength(0);
  });

  it("project.id in the list → dispatches normally", async () => {
    const { env, reviewWorkflow } = fixture({ allowedProjectIds: "1,42,3" });
    const res = await handleRequest(gitlabRequest(mrPayload("open"), { token: WEBHOOK_SECRET }), env);
    expect(res.status).toBe(202);
    expect(reviewWorkflow.calls).toHaveLength(1);
  });
});

describe("parseAllowedProjectIds", () => {
  it("undefined/blank → null (no allowlist)", () => {
    expect(parseAllowedProjectIds(undefined)).toBeNull();
    expect(parseAllowedProjectIds("")).toBeNull();
    expect(parseAllowedProjectIds("   ")).toBeNull();
  });

  it("parses a comma-separated list, trimming whitespace", () => {
    expect(parseAllowedProjectIds("42, 101,7")).toEqual(new Set([42, 101, 7]));
  });

  it("drops malformed entries (non-integer, non-positive) rather than failing the whole list", () => {
    expect(parseAllowedProjectIds("42,abc,-1,0,7")).toEqual(new Set([42, 7]));
  });

  it("rejects non-digit forms a looser numeric parse would accept (decimal, exponent, sign)", () => {
    // 1e2 / 1.5 / +5 all pass Number.isInteger(Math.trunc(Number(...))) but
    // none of them match ^\d+$ — the stricter rule this fix enforces.
    expect(parseAllowedProjectIds("1e2,1.5,+5,42")).toEqual(new Set([42]));
  });

  it("an all-invalid, non-blank list fails CLOSED (empty set) and logs console.error", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(parseAllowedProjectIds("abc,def,-1")).toEqual(new Set());
    expect(spy).toHaveBeenCalledOnce();
    expect(String(spy.mock.calls[0]![0])).toContain("GITLAB_ALLOWED_PROJECT_IDS");
    spy.mockRestore();
  });

  it("a partially-valid list logs nothing (one typo must not look like a config error)", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(parseAllowedProjectIds("42,abc")).toEqual(new Set([42]));
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("mr-review pause", () => {
  const pauseEnv = async (pauseValue: string | null, withConfigKv = true) => {
    const reviewWorkflow = makeFakeWorkflow();
    const idempotencyKv = makeFakeKv();
    const configKv = makeFakeKv();
    if (pauseValue !== null) {
      await configKv.binding.put("pr-review.paused", pauseValue);
    }
    const env: Env = makeFakeEnv({
      hmacSecret: "unused",
      workflow: makeFakeWorkflow(),
      storage: makeFakeR2(),
      idempotencyKv: idempotencyKv.binding,
      ...(withConfigKv ? { configKv: configKv.binding } : {}),
      gitlabWebhookSecret: WEBHOOK_SECRET,
      gitlabReviewWorkflow: reviewWorkflow.binding,
    });
    return { env, reviewWorkflow };
  };
  it("key present → 200 paused, no dispatch, no throttle or dedup writes", async () => {
    const { env, reviewWorkflow } = await pauseEnv("2026-09-13 cost spike, operator");
    const uuid = "pause-delivery-1";
    const res = await handleRequest(gitlabRequest(mrPayload("open"), { token: WEBHOOK_SECRET, deliveryId: uuid }), env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "paused", reason: "2026-09-13 cost spike, operator" });
    expect(reviewWorkflow.calls).toHaveLength(0);
    expect(await env.IDEMPOTENCY_KV!.get("throttle:42:7")).toBeNull();
    expect(await env.IDEMPOTENCY_KV!.get(`gl-delivery:${uuid}`)).toBeNull();
  });
  it("key present + request-ai-review label → still 200 paused, no dispatch", async () => {
    const { env, reviewWorkflow } = await pauseEnv("2026-09-13 cost spike, operator");
    const labeled = {
      object_kind: "merge_request",
      project: { id: 42, web_url: "https://gitlab.com/group/proj" },
      object_attributes: {
        iid: 7,
        action: "open",
        source_branch: "feature",
        target_branch: "main",
        last_commit: { id: "commitsha1234567890" },
        diff_refs: { base_sha: "basesha", head_sha: "headsha1234567890" },
        labels: [{ title: "request-ai-review" }],
      },
    };
    const res = await handleRequest(gitlabRequest(labeled, { token: WEBHOOK_SECRET, deliveryId: "pause-delivery-2" }), env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "paused", reason: "2026-09-13 cost spike, operator" });
    expect(reviewWorkflow.calls).toHaveLength(0);
  });
  it("key absent (CONFIG_KV bound but empty) → 202 accepted, one create", async () => {
    const { env, reviewWorkflow } = await pauseEnv(null);
    const res = await handleRequest(gitlabRequest(mrPayload("open"), { token: WEBHOOK_SECRET, deliveryId: "pause-delivery-3" }), env);
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ accepted: true });
    expect(reviewWorkflow.calls).toHaveLength(1);
  });
  it("CONFIG_KV undefined → 202 accepted, one create", async () => {
    const { env, reviewWorkflow } = await pauseEnv(null, false);
    const res = await handleRequest(gitlabRequest(mrPayload("open"), { token: WEBHOOK_SECRET, deliveryId: "pause-delivery-4" }), env);
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ accepted: true });
    expect(reviewWorkflow.calls).toHaveLength(1);
  });
});

describe("mr-review draft gate", () => {
  const draftPayload = (opts: { draft?: boolean; workInProgress?: boolean; labels?: Array<{ title: string }> } = {}) => ({
    object_kind: "merge_request",
    project: { id: 42, web_url: "https://gitlab.com/group/proj" },
    object_attributes: {
      iid: 7,
      action: "open",
      source_branch: "feature",
      target_branch: "main",
      last_commit: { id: "commitsha1234567890" },
      diff_refs: { base_sha: "basesha", head_sha: "headsha1234567890" },
      ...(opts.draft !== undefined ? { draft: opts.draft } : {}),
      ...(opts.workInProgress !== undefined ? { work_in_progress: opts.workInProgress } : {}),
      ...(opts.labels !== undefined ? { labels: opts.labels } : {}),
    },
  });

  it("draft MR → 204, no Workflow create", async () => {
    const { env, reviewWorkflow } = fixture();
    const res = await handleRequest(gitlabRequest(draftPayload({ draft: true }), { token: WEBHOOK_SECRET }), env);
    expect(res.status).toBe(204);
    expect(reviewWorkflow.calls).toHaveLength(0);
  });

  it("legacy work_in_progress flag → 204, no Workflow create", async () => {
    const { env, reviewWorkflow } = fixture();
    const res = await handleRequest(gitlabRequest(draftPayload({ workInProgress: true }), { token: WEBHOOK_SECRET }), env);
    expect(res.status).toBe(204);
    expect(reviewWorkflow.calls).toHaveLength(0);
  });

  it("draft MR + request-ai-review label → reviewed", async () => {
    const { env, reviewWorkflow } = fixture();
    const res = await handleRequest(
      gitlabRequest(draftPayload({ draft: true, labels: [{ title: "request-ai-review" }] }), { token: WEBHOOK_SECRET }),
      env,
    );
    expect(res.status).toBe(202);
    expect(reviewWorkflow.calls).toHaveLength(1);
  });

  it("draft MR + CONFIG_KV pr-review.reviewDrafts=true → reviewed", async () => {
    const configKv = makeFakeKv();
    await configKv.binding.put("pr-review.reviewDrafts", "true");
    const { env, reviewWorkflow } = fixture({ configKv });
    const res = await handleRequest(gitlabRequest(draftPayload({ draft: true }), { token: WEBHOOK_SECRET }), env);
    expect(res.status).toBe(202);
    expect(reviewWorkflow.calls).toHaveLength(1);
  });

  it("draft MR + CONFIG_KV pr-review.reviewDrafts set to a non-'true' value → still gated", async () => {
    const configKv = makeFakeKv();
    await configKv.binding.put("pr-review.reviewDrafts", "yes");
    const { env, reviewWorkflow } = fixture({ configKv });
    const res = await handleRequest(gitlabRequest(draftPayload({ draft: true }), { token: WEBHOOK_SECRET }), env);
    expect(res.status).toBe(204);
    expect(reviewWorkflow.calls).toHaveLength(0);
  });

  it("non-draft MR is unaffected by the gate", async () => {
    const { env, reviewWorkflow } = fixture();
    const res = await handleRequest(gitlabRequest(draftPayload({ draft: false }), { token: WEBHOOK_SECRET }), env);
    expect(res.status).toBe(202);
    expect(reviewWorkflow.calls).toHaveLength(1);
  });
});
