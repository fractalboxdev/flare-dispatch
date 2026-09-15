// FlareDispatch Dispatcher — `POST /v1/webhooks/gitlab` supersede acceptance tests.
//
// A new MR head must terminate and supersede a still-running execution for the
// same MR. No GitLab token is configured, so the route attempts no note PUT and
// no HTTP mock is needed.

import { describe, expect, it } from "vitest";
import { handleRequest } from "../router";
import { makeFakeD1, makeFakeEnv, makeFakeKv, makeFakeR2, makeFakeWorkflow } from "../test-helpers";
import type { Env } from "../env";

const WEBHOOK_SECRET = "gitlab-webhook-secret-please-rotate";

const NEW_HEAD = "bbbbbbbbbbbb0000000000000000000000000000";
const SAME_HEAD = "aaaaaaaaaaaa0000000000000000000000000000";

const mrPayload = (action: string, headSha: string) => ({
  object_kind: "merge_request",
  project: { id: 42, web_url: "https://gitlab.example/g/p" },
  object_attributes: {
    iid: 7,
    action,
    source_branch: "feat/x",
    target_branch: "main",
    last_commit: { id: headSha },
    diff_refs: { base_sha: "basesha", head_sha: headSha },
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

const runningRow = () => ({
  id: "mr-review_42_7_aaaaaaaaaaaa",
  run: "mr-review",
  repo: "https://gitlab.example/g/p",
  ref: "feat/x",
  sha: SAME_HEAD,
  status: "running",
  started_at: Date.now() - 60_000,
  summary_json: JSON.stringify({ placeholderNoteId: "501" }),
});

const fixture = (opts: { instanceStatus?: (id: string) => string } = {}) => {
  const reviewWorkflow = makeFakeWorkflow(
    opts.instanceStatus !== undefined ? { instanceStatus: opts.instanceStatus } : {},
  );
  const metadata = makeFakeD1({ executions: [runningRow()] });
  const idempotencyKv = makeFakeKv();
  const env: Env = makeFakeEnv({
    hmacSecret: "unused",
    workflow: makeFakeWorkflow(),
    storage: makeFakeR2(),
    idempotencyKv: idempotencyKv.binding,
    gitlabWebhookSecret: WEBHOOK_SECRET,
    gitlabReviewWorkflow: reviewWorkflow.binding,
    metadata,
  });
  return { env, reviewWorkflow, metadata, idempotencyKv };
};

const supersededStatements = (metadata: ReturnType<typeof makeFakeD1>) =>
  metadata.statements.filter((s) => s.sql.includes("'superseded'"));

describe("POST /v1/webhooks/gitlab supersede", () => {
  it("terminates and supersedes a running execution for a new head", async () => {
    const { env, reviewWorkflow, metadata } = fixture();
    const res = await handleRequest(
      gitlabRequest(mrPayload("update", NEW_HEAD), {
        token: WEBHOOK_SECRET,
        deliveryId: "s0",
      }),
      env,
    );
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ accepted: true });
    expect(reviewWorkflow.terminated).toEqual(["mr-review_42_7_aaaaaaaaaaaa"]);
    const superseded = supersededStatements(metadata);
    expect(superseded).toHaveLength(1);
    expect(superseded[0]!.binds).toContain("bbbbbbbbbbbb");
    expect(superseded[0]!.binds).toContain("mr-review_42_7_aaaaaaaaaaaa");
  });

  it("leaves the row untouched when the head is unchanged", async () => {
    const { env, reviewWorkflow, metadata } = fixture();
    const res = await handleRequest(
      gitlabRequest(mrPayload("update", SAME_HEAD), {
        token: WEBHOOK_SECRET,
        deliveryId: "s1",
      }),
      env,
    );
    expect(res.status).toBe(202);
    expect(reviewWorkflow.terminated).toEqual([]);
    expect(supersededStatements(metadata)).toHaveLength(0);
  });

  it("leaves a complete instance untouched", async () => {
    const { env, reviewWorkflow, metadata } = fixture({ instanceStatus: () => "complete" });
    const res = await handleRequest(
      gitlabRequest(mrPayload("update", NEW_HEAD), {
        token: WEBHOOK_SECRET,
        deliveryId: "s2",
      }),
      env,
    );
    expect(res.status).toBe(202);
    expect(reviewWorkflow.terminated).toEqual([]);
    expect(supersededStatements(metadata)).toHaveLength(0);
  });
});
