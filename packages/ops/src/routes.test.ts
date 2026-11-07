import { Effect, Layer } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { accessTeam, AUD, requestWith, TEAM } from "./access.test-support.ts";
import { sqliteDb, type TestDb } from "./d1.test-support.ts";
import {
  APP_PERMISSIONS,
  appManifest,
  ManifestConversion,
  OPERATIONS,
  OPERATOR_ROUTES,
  OperationRefused,
  OperatorOperations,
  opsFetch,
  requesterAttribution,
  SpendUnreadable,
  SpendView,
  STATE_TTL_MS,
  utcMonth,
  type OperatorCall,
  type OpsRouteDeps,
  type SpendViewBody,
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
  const conversions: string[] = [];
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
    manifestConversion: Layer.succeed(ManifestConversion, {
      convert: (code) =>
        Effect.sync(() => {
          conversions.push(code);
          return {
            id: 7,
            slug: "fd",
            pem: "-----BEGIN KEY-----",
            webhookSecret: "whsec",
            clientId: "cid",
            clientSecret: "cs",
          };
        }),
    }),
    ...over,
  };
  const exp = Math.floor(now / 1000) + 300;
  const operator = await team.token({ exp });
  const viewer = await team.token({ email: "dev@acme.com", sub: "sub-dev", exp });
  const call = (jwt: string | null, path: string, init: RequestInit = {}) =>
    opsFetch(requestWith(jwt, path, init), env, deps).then((r) => r!);
  return { team, env, deps, calls, conversions, operator, viewer, call };
};

const post = (body: unknown): RequestInit => ({
  method: "POST",
  body: JSON.stringify(body),
  headers: { "content-type": "application/json" },
});

describe("operability routes", () => {
  it("[FD-OPS-064] every dashboard page and route passes the Access gate before any route logic", async () => {
    const s = await setup();
    for (const path of [
      "/",
      "/v1/executions",
      "/v1/ops/health",
      "/v1/ops/fleet",
      "/v1/github/install/new",
    ]) {
      expect((await s.call(null, path)).status).toBe(401);
      expect((await s.call("x.y.z", path)).status).toBe(403);
    }
    expect((await s.call(s.viewer, "/")).status).toBe(200);
    expect(await (await s.call(s.viewer, "/v1/executions")).json()).toEqual({
      rows: [],
      limit: 50,
      next: null,
    });
    const unconfigured = await opsFetch(requestWith(s.operator, "/"), { DB: t.db }, s.deps);
    expect(unconfigured!.status).toBe(503);
    expect(
      await opsFetch(requestWith(s.operator, "/v1/webhooks/github"), s.env, s.deps),
    ).toBeNull();
  });

  it("[FD-OPS-036] GET /v1/ops/health returns the liveness report with each installation's status and delivery age", async () => {
    const s = await setup();
    const body = (await (await s.call(s.operator, "/v1/ops/health")).json()) as Record<
      string,
      unknown
    >;
    expect(Object.keys(body).sort()).toEqual(
      [
        "control_state",
        "executors",
        "installations",
        "oldest_open_execution_age_ms",
        "outbox_depth",
        "probes",
        "tick_age_ms",
      ].sort(),
    );
    expect((await s.call(s.viewer, "/v1/ops/health")).status).toBe(403);
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

  it("a route whose port the composition does not supply is not served", async () => {
    const s = await setup({
      operations: undefined,
      spend: undefined,
      manifestConversion: undefined,
    });
    expect(
      await opsFetch(requestWith(s.operator, "/v1/ops/halt", post({})), s.env, s.deps),
    ).toBeNull();
    expect(await opsFetch(requestWith(s.operator, "/v1/spend"), s.env, s.deps)).toBeNull();
  });
});

describe("GitHub App install", () => {
  it("[FD-OPS-072] the install routes serve only an operator", async () => {
    const s = await setup();
    expect((await s.call(s.viewer, "/v1/github/install/new")).status).toBe(403);
    expect((await s.call(s.viewer, "/v1/github/install/callback?state=x&code=y")).status).toBe(403);
    const start = await s.call(s.operator, "/v1/github/install/new");
    expect(start.status).toBe(200);
    expect(await start.text()).toContain("https://github.com/settings/apps/new?state=");
  });

  it("[FD-OPS-073] [FD-OPS-074] a state binds to the operator's session and is accepted once within 600 s", async () => {
    const now = 1_800_000_000_000;
    const s = await setup({}, now);
    const page = await (await s.call(s.operator, "/v1/github/install/new")).text();
    const state = decodeURIComponent(/state=([^"&]+)/.exec(page)![1]!);
    const other = await s.team.token({
      email: "ops@acme.com",
      sub: "sub-other-session",
      exp: Math.floor(now / 1000) + 300,
    });
    expect(
      (
        await s.call(
          other,
          `/v1/github/install/callback?state=${encodeURIComponent(state)}&code=c0`,
        )
      ).status,
    ).toBe(403);
    expect(
      (await s.call(s.operator, `/v1/github/install/callback?state=unknown&code=c1`)).status,
    ).toBe(403);
    const ok = await s.call(
      s.operator,
      `/v1/github/install/callback?state=${encodeURIComponent(state)}&code=c2`,
    );
    expect(ok.status).toBe(200);
    expect(
      (
        await s.call(
          s.operator,
          `/v1/github/install/callback?state=${encodeURIComponent(state)}&code=c3`,
        )
      ).status,
    ).toBe(403);
    expect(s.conversions).toEqual(["c2"]);
    const late = await setup({}, now);
    const latePage = await (await late.call(late.operator, "/v1/github/install/new")).text();
    const lateState = decodeURIComponent(/state=([^"&]+)/.exec(latePage)![1]!);
    const after = await setup({}, now + STATE_TTL_MS);
    const expired = await opsFetch(
      requestWith(
        late.operator,
        `/v1/github/install/callback?state=${encodeURIComponent(lateState)}&code=c4`,
      ),
      late.env,
      after.deps,
    );
    expect(expired!.status).toBe(403);
    expect(after.conversions).toEqual([]);
  });

  it("[FD-OPS-075] the credentials page is no-store", async () => {
    const s = await setup();
    const page = await (await s.call(s.operator, "/v1/github/install/new")).text();
    const state = decodeURIComponent(/state=([^"&]+)/.exec(page)![1]!);
    const res = await s.call(
      s.operator,
      `/v1/github/install/callback?state=${encodeURIComponent(state)}&code=c`,
    );
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.text()).toContain("GITHUB_APP_PRIVATE_KEY");
  });

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
  const view: SpendViewBody = {
    month: "2027-01",
    budget: 50_000_000,
    settled: 1_000_000,
    reserved: 200_000,
    committed: 1_200_000,
    classes: [
      { class: "batch", line: 9_000_000, lane: 410_000, admitted_list_rate: 0, reserve: 0 },
    ],
    floor: 2_000_000,
    measured_reserve_runway_days: 12,
    control_state: "run",
    resets_at: 0,
  };

  it("[FD-SPD-057] GET /v1/spend answers the spend view of the current UTC month for an Access identity", async () => {
    const months: string[] = [];
    const now = Date.UTC(2027, 0, 31, 23, 59);
    const s = await setup(
      {
        spend: Layer.succeed(SpendView, { view: (m) => Effect.sync(() => (months.push(m), view)) }),
      },
      now,
    );
    const res = await s.call(s.viewer, "/v1/spend");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(view);
    expect(months).toEqual(["2027-01"]);
    expect(utcMonth(Date.UTC(2027, 1, 1))).toBe("2027-02");
    expect((await s.call(null, "/v1/spend")).status).toBe(401);
  });

  it("[FD-SPD-058] spend_unreadable answers 503 spend_unreadable", async () => {
    const s = await setup({
      spend: Layer.succeed(SpendView, {
        view: () => Effect.fail(new SpendUnreadable({ reason: "d1 timeout" })),
      }),
    });
    const res = await s.call(s.viewer, "/v1/spend");
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toBe("spend_unreadable");
  });

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
