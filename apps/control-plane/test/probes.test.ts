// The control plane's GitHub probes: the minute tick composes the canary, installation and delivery probes under the
// GitHub App, the rows they insert decode against the GitHub applier's payloads, and a verified webhook delivery
// reaches the canary's stage read (specs/operability.md § Liveness and alerts).
import { generateKeyPairSync } from "node:crypto";
import { githubAppLayer, SidePayloads } from "@fractalboxdev/flare-dispatch-github";
import { IntakeStore } from "@fractalboxdev/flare-dispatch-intake";
import { migratedD1 } from "@fractalboxdev/flare-dispatch-intake/testing";
import {
  canaryStage,
  GithubAppReads,
  minuteTick,
  PROBE_INTERVAL_MS,
  probeDeliveries,
  probeResults,
  pushCanary,
  registerInstallation,
  runOpsMigrations,
  type TickDeps,
} from "@fractalboxdev/flare-dispatch-ops";
import { buildProfile } from "@fractalboxdev/flare-dispatch-profile";
import { AlarmPort } from "@fractalboxdev/mameko-ports";
import { type Context, Effect, Exit, Layer, Schema } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isolateServices } from "../src/composition.ts";
import type { ControlPlaneEnv } from "../src/config.ts";
import { APP_LIMIT_KEY, githubAppReadsLayer, tickDeps } from "../src/tick.ts";

/** A 15 min boundary, so the probes run. */
const T0 = PROBE_INTERVAL_MS * 2_000_000;
const KEY = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString();
const FIXTURE = "acme/canary";

type Route = (path: string) => { status: number; body: unknown };

/** A GitHub that answers the App's reads from `routes`, keyed `<method> <path without query>`, and records each call. */
const github = (routes: Record<string, Route>) => {
  const calls: string[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    calls.push(`${method} ${url.pathname}${url.search}`);
    const route = routes[`${method} ${url.pathname}`];
    const { status, body } =
      route === undefined
        ? { status: 404, body: { message: "Not Found" } }
        : route(url.pathname + url.search);
    return Response.json(body, { status });
  }) as typeof globalThis.fetch;
  return { calls, fetch };
};

const APP_ROUTES: Record<string, Route> = {
  [`GET /repos/${FIXTURE}/installation`]: () => ({ status: 200, body: { id: 42 } }),
  "GET /app/installations": () => ({
    status: 200,
    body: [{ id: 42, account: { login: "acme" }, suspended_at: null }],
  }),
  "GET /app/installations/42": () => ({
    status: 200,
    body: { id: 42, account: { login: "acme" }, suspended_at: null },
  }),
  "GET /app/hook/deliveries": () => ({ status: 200, body: [] }),
};

const envOf = async (over: Record<string, unknown> = {}) =>
  ({
    DB: await migratedD1(),
    DEPLOYMENT: "production",
    PLANE_ID: "plane",
    GITHUB_APP_ID: "123",
    GITHUB_APP_PRIVATE_KEY: KEY,
    GITHUB_FIXTURE_REPO: FIXTURE,
    MONITOR: { idFromName: (n: string) => n, get: () => ({ start: async () => {} }) },
    INSTALLATION_QUOTA: { idFromName: (n: string) => n, get: () => ({}) },
    ...over,
  }) as unknown as ControlPlaneEnv;

/** The composed tick without the drain and the other areas' units, which need bindings this test does not hold. */
const probesOnly = (deps: TickDeps): TickDeps => {
  const { appliers: _appliers, units: _units, ...rest } = deps;
  return rest;
};

const outbox = async (env: ControlPlaneEnv) =>
  (await env.DB.prepare("select id, kind, limit_key, payload_json from outbox order by id").all())
    .results as { id: string; kind: string; limit_key: string; payload_json: string }[];

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the control plane's GitHub probes", () => {
  it("[FD-OPS-038] [FD-OPS-041] [FD-OPS-044] with the App and a fixture repository, every 15 min the tick pushes the canary and runs the installation and delivery probes", async () => {
    const gh = github(APP_ROUTES);
    vi.stubGlobal("fetch", gh.fetch);
    const env = await envOf();
    const deps = tickDeps(env);
    expect(deps.appLimitKey).toBe(APP_LIMIT_KEY);
    const report = await Effect.runPromise(minuteTick(env, probesOnly(deps), T0));
    expect(
      report.steps
        .filter((s) => ["canary-push", "installation-probe", "delivery-probe"].includes(s.step))
        .map((s) => [s.step, s.status]),
    ).toEqual([
      ["canary-push", "ran"],
      ["installation-probe", "ran"],
      ["delivery-probe", "ran"],
    ]);
    // The canary's row takes the permit of the installation the App maps the fixture repository to.
    expect((await outbox(env)).map((r) => [r.id, r.kind, r.limit_key])).toEqual([
      [`${FIXTURE}/ops:canary:${T0}`, "canary.push", "42"],
    ]);
    expect(gh.calls).toEqual(
      expect.arrayContaining([
        "GET /app/installations?per_page=100",
        "GET /app/installations/42",
        "GET /app/hook/deliveries?per_page=100",
      ]),
    );
    expect((await probeResults(env.DB)).map((p) => [p.name, p.ok])).toEqual([
      ["delivery", true],
      ["installation", true],
    ]);
  });

  it("[FD-OPS-042] an installation the App reads as suspended raises installation-lost through the composed probe", async () => {
    vi.stubGlobal(
      "fetch",
      github({
        ...APP_ROUTES,
        "GET /app/installations/42": () => ({
          status: 200,
          body: { id: 42, account: { login: "acme" }, suspended_at: "2026-11-01T00:00:00Z" },
        }),
      }).fetch,
    );
    const env = await envOf();
    await Effect.runPromise(minuteTick(env, probesOnly(tickDeps(env)), T0));
    const alarms = (
      await env.DB.prepare(
        "select name, severity, dedupe_key from fd_alarms where name = 'installation-lost'",
      ).all()
    ).results;
    expect(alarms).toEqual([
      { name: "installation-lost", severity: "page", dedupe_key: "installation-lost:42" },
    ]);
  });

  it("[FD-OPS-038] without a fixture repository no canary is pushed, and without the App no probe runs", async () => {
    vi.stubGlobal("fetch", github(APP_ROUTES).fetch);
    const noFixture = await envOf({ GITHUB_FIXTURE_REPO: "" });
    const steps = (
      await Effect.runPromise(minuteTick(noFixture, probesOnly(tickDeps(noFixture)), T0))
    ).steps;
    expect(steps.find((s) => s.step === "canary-push")?.status).toBe("skipped");
    expect(steps.find((s) => s.step === "installation-probe")?.status).toBe("ran");

    const noApp = await envOf({ GITHUB_APP_PRIVATE_KEY: undefined });
    const deps = tickDeps(noApp);
    expect([deps.probes, deps.githubReads, deps.appLimitKey]).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
  });

  it("[FD-OPS-038] a fixture repository no installation covers fails the canary push and leaves the other probes running", async () => {
    vi.stubGlobal(
      "fetch",
      github({
        ...APP_ROUTES,
        [`GET /repos/${FIXTURE}/installation`]: () => ({
          status: 404,
          body: { message: "Not Found" },
        }),
      }).fetch,
    );
    const env = await envOf();
    const report = await Effect.runPromise(minuteTick(env, probesOnly(tickDeps(env)), T0));
    expect(report.steps.find((s) => s.step === "canary-push")).toMatchObject({
      status: "failed",
      cause: expect.stringContaining("FixtureInstallationMissing"),
    });
    expect(report.steps.find((s) => s.step === "delivery-probe")?.status).toBe("ran");
    expect(await outbox(env)).toEqual([]);
    // GitHub's 404 is a definite answer: the canary reads not ok and canary-missed names the push stage.
    expect((await probeResults(env.DB)).find((p) => p.name === "canary")).toMatchObject({
      ok: false,
      detail: { stage: "push", reason: `no installation covers ${FIXTURE}` },
    });
    expect(
      (
        await env.DB.prepare(
          "select name, severity, dedupe_key from fd_alarms where name = 'canary-missed'",
        ).all()
      ).results,
    ).toEqual([{ name: "canary-missed", severity: "page", dedupe_key: "canary-missed" }]);
  });
});

describe("the probes' rows against the GitHub applier", () => {
  const profile = buildProfile("production");

  it("[FD-OPS-038] the canary.push row decodes as the applier's canary.push payload", async () => {
    const db = await migratedD1();
    await runOpsMigrations(db);
    await Effect.runPromise(
      pushCanary(
        db,
        profile,
        { fixtureRepo: FIXTURE, fixtureInstallation: "42", webhookSilentHours: 24 },
        T0,
      ),
    );
    const [row] = (await db.prepare("select payload_json from outbox").all()).results as {
      payload_json: string;
    }[];
    const decoded = Schema.decodeUnknownExit(SidePayloads["canary.push"])(
      JSON.parse(row!.payload_json),
    );
    expect(Exit.isSuccess(decoded) && decoded.value).toEqual({
      branch: "flare-dispatch-canary",
      tick_time: new Date(T0).toISOString(),
    });
  });

  it("[FD-OPS-045] the delivery.redeliver row decodes as the applier's payload, with the numeric delivery id the live read answers", async () => {
    vi.stubGlobal(
      "fetch",
      github({
        "GET /app/hook/deliveries": () => ({
          status: 200,
          body: [
            {
              id: 70001,
              guid: "g1",
              delivered_at: new Date(T0 - 600_000).toISOString(),
              redelivery: false,
              status_code: 502,
            },
            {
              id: 70002,
              guid: "g2",
              delivered_at: new Date(T0 - 60_000).toISOString(),
              redelivery: false,
              status_code: 200,
            },
          ],
        }),
      }).fetch,
    );
    const db = await migratedD1();
    await runOpsMigrations(db);
    const reads = githubAppReadsLayer.pipe(
      Layer.provide(
        githubAppLayer({ appId: "123", privateKeyPem: KEY, fetch: (i, n) => fetch(i, n) }),
      ),
    );
    await Effect.runPromise(
      probeDeliveries(db, profile, APP_LIMIT_KEY, T0).pipe(
        Effect.provide(reads),
        Effect.provide(Layer.succeed(AlarmPort, { deliver: () => Effect.void })),
      ),
    );
    const rows = (await db.prepare("select id, limit_key, payload_json from outbox").all())
      .results as { id: string; limit_key: string; payload_json: string }[];
    expect(rows.map((r) => [r.id, r.limit_key])).toEqual([
      ["app/ops:redeliver:70001", APP_LIMIT_KEY],
    ]);
    const decoded = Schema.decodeUnknownExit(SidePayloads["delivery.redeliver"])(
      JSON.parse(rows[0]!.payload_json),
    );
    expect(Exit.isSuccess(decoded) && decoded.value).toEqual({ delivery_id: 70001 });
  });

  it("[FD-OPS-041] an App read that fails is GithubAppReadFailed, never an answer", async () => {
    vi.stubGlobal(
      "fetch",
      github({
        "GET /app/installations/9": () => ({ status: 502, body: { message: "bad gateway" } }),
      }).fetch,
    );
    const reads = githubAppReadsLayer.pipe(
      Layer.provide(
        githubAppLayer({ appId: "123", privateKeyPem: KEY, fetch: (i, n) => fetch(i, n) }),
      ),
    );
    const exit = await Effect.runPromise(
      Effect.exit(GithubAppReads.use((r) => r.installation("9"))).pipe(Effect.provide(reads)),
    );
    expect(JSON.stringify(exit)).toContain("GithubAppReadFailed");
  });
});

describe("a verified webhook delivery", () => {
  it("[FD-OPS-040] reaches the canary's stage read through the isolate's services, so a delivered canary reads past the push", async () => {
    const env = await envOf();
    await runOpsMigrations(env.DB);
    await registerInstallation(env.DB, "42", "acme");
    const config = { fixtureRepo: FIXTURE, fixtureInstallation: "42", webhookSilentHours: 24 };
    expect(await canaryStage(env.DB, config, T0)).toBe("push");
    const services = (await isolateServices(env)) as Context.Context<IntakeStore>;
    await Effect.runPromise(
      IntakeStore.use((s) => s.recordDelivery(42, T0 + 5_000)).pipe(Effect.provide(services)),
    );
    expect(await canaryStage(env.DB, config, T0)).toBe("delivery");
  });
});
