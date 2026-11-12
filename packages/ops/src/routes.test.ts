import { Effect, Layer } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { accessTeam, AUD, requestWith, TEAM } from "./access.test-support.ts";
import { sqliteDb, type TestDb } from "./d1.test-support.ts";
import {
  APP_PERMISSIONS,
  appManifest,
  OPERATIONS,
  OPERATOR_ROUTES,
  OperationRefused,
  OperatorOperations,
  opsFetch,
  requesterAttribution,
  type OperatorCall,
  type OpsRouteDeps,
} from "./index.ts";

let t: TestDb;
beforeEach(async () => {
  t = await sqliteDb();
});
afterEach(() => t.dispose());

const CLASSES = ["release", "required", "interactive", "batch"];

const setup = async (over: Partial<OpsRouteDeps> = {}, now = Date.now()) => {
  const team = await accessTeam();
  const calls: OperatorCall[] = [];
  const env = {
    DB: t.db,
    ACCESS_TEAM_DOMAIN: TEAM,
    ACCESS_AUD: AUD,
    OPERATORS: '["ops@acme.com"]',
    LINK_KEY: "link-key",
  };
  const deps: OpsRouteDeps = {
    classes: CLASSES,
    fetch: team.fetcher,
    now: () => now,
    operations: Layer.succeed(OperatorOperations, {
      perform: (call) =>
        call.operation === "drain" &&
        call.body !== undefined &&
        (call.body as { executor: string }).executor === "missing"
          ? Effect.fail(
              new OperationRefused({ status: 404, code: "not_found", message: "no such executor" }),
            )
          : Effect.sync(() => (calls.push(call), { audit: call.requestId })),
    }),
    ...over,
  };
  const exp = Math.floor(now / 1000) + 300;
  const operator = await team.token({ exp });
  const viewer = await team.token({ email: "dev@acme.com", sub: "sub-dev", exp });
  const call = (jwt: string | null, path: string, init: RequestInit = {}) =>
    opsFetch(requestWith(jwt, path, init), env, deps).then((r) => r!);
  return { team, env, deps, calls, operator, viewer, call };
};

const post = (body: unknown): RequestInit => ({
  method: "POST",
  body: JSON.stringify(body),
  headers: { "content-type": "application/json" },
});

describe("operability routes", () => {
  it("[FD-OPS-064] every dashboard page passes the Access gate before any page logic", async () => {
    const s = await setup();
    for (const path of ["/", "/executions/e1"]) {
      expect((await s.call(null, path)).status).toBe(401);
      expect((await s.call("x.y.z", path)).status).toBe(403);
    }
    expect((await s.call(s.viewer, "/")).status).toBe(200);
    const unconfigured = await opsFetch(requestWith(s.operator, "/"), { DB: t.db }, s.deps);
    expect(unconfigured!.status).toBe(503);
    for (const path of [
      "/v1/webhooks/github",
      "/v1/executions",
      "/v1/ops/health",
      "/v1/ops/fleet",
      "/v1/ops/phase-gate?gate=0",
      "/v1/spend",
      "/v1/github/install/new",
    ])
      expect(await opsFetch(requestWith(s.operator, path), s.env, s.deps), path).toBeNull();
  });

  it("[FD-AGT-018] GET /executions/:id serves the execution page with every reason of its refused pr.propose row", async () => {
    const s = await setup();
    await t.db
      .prepare(
        "insert into executions (id, scope_id, run, class, status, enqueued_at) values ('e 1', 'acme/app', 'spec-drift-pr', 'required', 'success', 0)",
      )
      .run();
    await t.db
      .prepare(
        `insert into outbox (id, execution_id, scope_id, intent_key, kind, limit_key, tier, priority, class_rank,
           draws_reserve, payload_json, payload_digest, intent_attempts, effect_class, state, attempts, sends,
           next_attempt_at, last_error, inserted_at, undetermined)
         values ('1', 'e 1', 'acme/app', 'cp:pr:propose', 'pr.propose', '7', 'effect', 0, 1, 0, '{}', 'd', 0,
           'adoptable', 'refused', 1, 1, 0, ?, 0, 0)`,
      )
      .bind("writeback: outside-allowlist; outside-allowlist src/a.ts; too-many-files")
      .run();
    const res = await s.call(s.viewer, "/executions/e%201");
    expect(res.status).toBe(200);
    const page = await res.text();
    expect(page).toContain("<tr><th>Verdict</th><td>success</td></tr>");
    expect(page).toContain(
      '<li class="mono">outside-allowlist src/a.ts</li><li class="mono">too-many-files</li>',
    );
    expect(page).toContain("/v1/executions/e%201/logs?t=");
    expect((await s.call(s.viewer, "/executions/nope")).status).toBe(404);
    expect((await s.call(s.viewer, "/executions/%E0")).status).toBe(404);
  });
});

describe("operator routes", () => {
  it("[FD-OPS-077] each route of the table surfaces its one mameko operation, and no other route exists", async () => {
    expect(OPERATOR_ROUTES.map((r) => r.operation).sort()).toEqual(Object.keys(OPERATIONS).sort());
    expect(OPERATOR_ROUTES.map((r) => r.path)).toEqual([
      "/v1/ops/halt",
      "/v1/ops/drain",
      "/v1/ops/quarantine",
      "/v1/ops/release",
      "/v1/executions/:id/cancel",
      "/v1/ops/force-admit",
      "/v1/ops/top-up",
      "/v1/ops/revoke",
      "/v1/ops/pause-key",
      "/v1/ops/resume-key",
    ]);
    // No `resolve`: no intent kind is reconcile-only.
    expect(OPERATOR_ROUTES.some((r) => r.path.includes("resolve"))).toBe(false);
    const s = await setup();
    const res = await s.call(
      s.operator,
      "/v1/ops/drain",
      post({ executor: "dev-1", reason: "OS update" }),
    );
    expect(res.status).toBe(200);
    expect(s.calls).toEqual([
      expect.objectContaining({
        operation: "drain",
        operator: "ops@acme.com",
        body: { executor: "dev-1", reason: "OS update" },
      }),
    ]);
    const cancel = await s.call(
      s.operator,
      "/v1/executions/e-42/cancel",
      post({ reason: "wrong commit" }),
    );
    expect(cancel.status).toBe(200);
    expect(s.calls[1]).toMatchObject({ operation: "cancel", executionId: "e-42" });
    expect(
      (await s.call(s.operator, "/v1/ops/drain", post({ executor: "missing", reason: "x" })))
        .status,
    ).toBe(404);
    expect((await s.call(s.operator, "/v1/ops/drain")).status).toBe(405);
    expect(
      await opsFetch(requestWith(s.operator, "/v1/ops/budget", post({})), s.env, s.deps),
    ).toBeNull();
  });

  it("[FD-OPS-078] the operator routes answer 403 to an identity the overlay does not list", async () => {
    const s = await setup();
    const res = await s.call(
      s.viewer,
      "/v1/ops/halt",
      post({ state: "halt-cloud", reason: "spend" }),
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("forbidden");
    expect(s.calls).toEqual([]);
  });

  it("[FD-OPS-077] a missing or over-long reason answers reason_required; a grant expiry beyond 7 days is refused", async () => {
    const s = await setup();
    const noReason = await s.call(s.operator, "/v1/ops/revoke", post({ executor: "dev-1" }));
    expect(((await noReason.json()) as { error: string }).error).toBe("reason_required");
    const long = await s.call(
      s.operator,
      "/v1/ops/revoke",
      post({ executor: "dev-1", reason: "x".repeat(501) }),
    );
    expect(long.status).toBe(400);
    const now = (s.deps.now as () => number)();
    const far = await s.call(
      s.operator,
      "/v1/ops/top-up",
      post({ amount_usd: 10, expires_at: now + 8 * 86_400_000, reason: "release week" }),
    );
    expect(far.status).toBe(400);
    const ok = await s.call(
      s.operator,
      "/v1/ops/top-up",
      post({ amount_usd: 10, expires_at: now + 86_400_000, reason: "release week" }),
    );
    expect(ok.status).toBe(200);
    expect(s.calls).toHaveLength(1);
  });

  it("[FD-OPS-083] no operator route changes the overlay or the budget; a top-up is a grant with an expiry", () => {
    for (const r of OPERATOR_ROUTES) expect(r.path).not.toMatch(/budget|overlay|config/);
    expect(Object.keys(OPERATIONS["top-up"].fields).sort()).toEqual([
      "amount_usd",
      "expires_at",
      "reason",
    ]);
  });

  it("an operator route is not served when the composition supplies no operations", async () => {
    const s = await setup({ operations: undefined });
    expect(
      await opsFetch(requestWith(s.operator, "/v1/ops/halt", post({})), s.env, s.deps),
    ).toBeNull();
  });
});

describe("GitHub App install", () => {
  it("[FD-OPS-076] the manifest subscribes to installation events and requests only the listed permissions", () => {
    const m = appManifest("https://dispatch.example.com");
    expect(m.default_events).toEqual(
      expect.arrayContaining(["installation", "installation_repositories"]),
    );
    expect(m.default_permissions).toEqual({
      checks: "write",
      contents: "write",
      pull_requests: "write",
      issues: "write",
      metadata: "read",
      actions: "read",
      administration: "read",
      deployments: "read",
      merge_queues: "read",
    });
    expect(m.hook_attributes.url).toBe("https://dispatch.example.com/v1/webhooks/github");
    expect(APP_PERMISSIONS.default_events).toHaveLength(10);
  });
});

describe("spend", () => {
  it("[FD-SPD-060] the requester attribution is the repository's owner as team and the triggering login as member", () => {
    expect(requesterAttribution({ repository: "acme/app", sender: "octocat" })).toEqual({
      team: "acme",
      member: "octocat",
    });
    expect(requesterAttribution({ repository: "acme/app", actor: "ci-bot" })).toEqual({
      team: "acme",
      member: "ci-bot",
    });
    expect(requesterAttribution({ repository: "acme/app" })).toEqual({
      team: "acme",
      member: null,
    });
  });
});
