// FlareDispatch Dispatcher — `POST /v1/admin/events/:wf_id` acceptance tests.
//
// Covers spec 03-dsl § Human-in-the-loop signalling endpoint:
//   no ADMIN_TOKEN → 503;
//   missing/wrong bearer → 401;
//   non-JSON body → 400;
//   body without `type` → 400;
//   valid → 202, `sendEvent` was called with the right payload;
//   workflow not found → 404.

import { describe, expect, it } from "vitest";
import { handleRequest } from "../router";
import {
  makeFakeEnv,
  makeFakeR2,
  makeFakeWorkflow,
} from "../test-helpers";

const ADMIN_TOKEN = "admin-bearer-please-rotate";
const HMAC_SECRET = "unused-but-required";

const adminRequest = (
  wfId: string,
  body: unknown,
  opts: { token?: string } = {},
): Request => {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (opts.token !== undefined) {
    headers["Authorization"] = `Bearer ${opts.token}`;
  }
  return new Request(
    `https://dispatcher.example/v1/admin/events/${encodeURIComponent(wfId)}`,
    {
      method: "POST",
      headers,
      body: typeof body === "string" ? body : JSON.stringify(body),
    },
  );
};

const fixture = (
  opts: { withAdminToken?: boolean; rejectIds?: ReadonlySet<string> } = {},
) => {
  const workflow = makeFakeWorkflow({ rejectSendEventFor: opts.rejectIds });
  const storage = makeFakeR2();
  const env = makeFakeEnv({
    hmacSecret: HMAC_SECRET,
    workflow,
    storage,
    adminToken: opts.withAdminToken === false ? undefined : ADMIN_TOKEN,
  });
  return { workflow, env };
};

describe("POST /v1/admin/events/:wf_id — auth", () => {
  it("ADMIN_TOKEN not configured → 503", async () => {
    const { env, workflow } = fixture({ withAdminToken: false });
    const req = adminRequest("wf-1", {
      type: "release-approval",
      payload: { decision: "approve" },
    });
    const res = await handleRequest(req, env);
    expect(res.status).toBe(503);
    expect(workflow.events).toHaveLength(0);
  });

  it("missing bearer token → 401", async () => {
    const { env, workflow } = fixture();
    const req = adminRequest("wf-1", { type: "x" });
    const res = await handleRequest(req, env);
    expect(res.status).toBe(401);
    expect(workflow.events).toHaveLength(0);
  });

  it("wrong bearer token → 401", async () => {
    const { env, workflow } = fixture();
    const req = adminRequest("wf-1", { type: "x" }, { token: "wrong-token" });
    const res = await handleRequest(req, env);
    expect(res.status).toBe(401);
    expect(workflow.events).toHaveLength(0);
  });
});

describe("POST /v1/admin/events/:wf_id — body validation", () => {
  it("invalid JSON → 400", async () => {
    const { env } = fixture();
    const req = adminRequest("wf-1", "this is not json", { token: ADMIN_TOKEN });
    const res = await handleRequest(req, env);
    expect(res.status).toBe(400);
  });

  it("body without `type` → 400", async () => {
    const { env } = fixture();
    const req = adminRequest("wf-1", { payload: {} }, { token: ADMIN_TOKEN });
    const res = await handleRequest(req, env);
    expect(res.status).toBe(400);
  });
});

describe("POST /v1/admin/events/:wf_id — delivery", () => {
  it("valid → 202 and sendEvent was called with the right payload", async () => {
    const { env, workflow } = fixture();
    const req = adminRequest(
      "release-notes:owner/repo:2026-W21",
      {
        type: "release-approval",
        payload: { decision: "approve", deciderEmail: "alice@example.com" },
      },
      { token: ADMIN_TOKEN },
    );
    const res = await handleRequest(req, env);
    expect(res.status).toBe(202);

    expect(workflow.events).toHaveLength(1);
    expect(workflow.events[0]).toEqual({
      wfId: "release-notes:owner/repo:2026-W21",
      type: "release-approval",
      payload: { decision: "approve", deciderEmail: "alice@example.com" },
    });
  });

  it("workflow not found (sendEvent rejects with 'unknown_instance') → 404", async () => {
    const { env } = fixture({ rejectIds: new Set(["missing-wf"]) });
    const req = adminRequest(
      "missing-wf",
      { type: "x", payload: {} },
      { token: ADMIN_TOKEN },
    );
    const res = await handleRequest(req, env);
    expect(res.status).toBe(404);
  });
});
