import { profile } from "@fractalboxdev/flare-dispatch-profile";
import {
  type Actuator,
  ActuatorRateLimit,
  Actuators,
  actuatorRegistry,
  type Alarm,
  AlarmDeliveryFailed,
  AlarmPort,
  type IntentRow,
  type PermitRequest,
} from "@fractalboxdev/mameko-ports";
import { Effect, Layer } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recordingAlarms, sqliteDb, type TestDb } from "./d1.test-support.ts";
import {
  checkCronSilent,
  deliveriesToRedeliver,
  GithubAppReads,
  livenessReport,
  minuteTick,
  onInstallationEvent,
  PROBE_INTERVAL_MS,
  probeResults,
  recordVerifiedDelivery,
  scheduledHandler,
  setInstallationStatus,
  type Delivery,
  type InstallationRead,
  type TickDeps,
  type TickEnv,
} from "./index.ts";

let t: TestDb;
beforeEach(async () => {
  t = await sqliteDb();
});
afterEach(() => t.dispose());

/** A 15 min boundary, so the probes run. */
const T0 = PROBE_INTERVAL_MS * 1_000_000;

const monitor = () => {
  const started: string[] = [];
  return {
    started,
    ns: {
      idFromName: (name: string) => name,
      get: (id: unknown) => ({ start: async () => void started.push(String(id)) }),
    },
  };
};

const appliers = () => {
  const applied: IntentRow[] = [];
  const permits: PermitRequest[] = [];
  const actuator: Actuator = {
    apply: (row) =>
      Effect.sync(
        () => (
          applied.push(row),
          { _tag: "applied" as const, externalRef: `ref:${row.intentKey}` }
        ),
      ),
    lookup: () => Effect.succeed({ _tag: "absent" as const }),
    reconcile: () => Effect.succeed({ _tag: "absent" as const }),
  };
  const layer = Layer.merge(
    // The one fake actuator under every binding the profile names.
    Layer.succeed(
      Actuators,
      actuatorRegistry(
        Object.fromEntries(Object.values(profile.intent_kinds).map((k) => [k.actuator, actuator])),
      ),
    ),
    Layer.succeed(ActuatorRateLimit, {
      acquire: (r) =>
        Effect.sync(
          () => (permits.push(r), { _tag: "granted" as const, permitId: `p${permits.length}` }),
        ),
      release: () => Effect.void,
    }),
  );
  return { applied, permits, layer };
};

const reads = (
  installations: Record<string, InstallationRead>,
  deliveries: readonly Delivery[] = [],
) =>
  Layer.succeed(GithubAppReads, {
    installation: (id) => Effect.succeed(installations[id] ?? { status: "not-found" as const }),
    deliveries: () => Effect.succeed(deliveries),
  });

const deps = (
  over: Partial<TickDeps> = {},
): { deps: TickDeps; alarms: ReturnType<typeof recordingAlarms> } => {
  const alarms = recordingAlarms();
  return {
    alarms,
    deps: {
      profile,
      alarmPort: alarms.layer,
      probes: { fixtureRepo: "acme/canary", fixtureInstallation: "42", webhookSilentHours: 24 },
      appLimitKey: "app",
      webhookSilentHours: 24,
      ...over,
    },
  };
};

const tick = (env: TickEnv, d: TickDeps, now: number) => Effect.runPromise(minuteTick(env, d, now));

const outbox = async () =>
  (
    await t.db
      .prepare("select id, kind, limit_key, execution_id, state from outbox order by id")
      .all()
  ).results as {
    id: string;
    kind: string;
    limit_key: string;
    execution_id: string | null;
    state: string;
  }[];

describe("minute tick", () => {
  it("[FD-INT-067] runs each composed unit as its own step; a failing unit leaves the others running", async () => {
    const ran: string[] = [];
    const m = monitor();
    const { deps: d } = deps({
      units: (now) => [
        { step: "sweep", effect: Effect.sync(() => ran.push(`sweep@${now}`)) },
        { step: "broken", effect: Effect.fail("no bucket") },
        { step: "logs", effect: Effect.sync(() => ran.push("logs")) },
      ],
    });
    const report = await tick({ DB: t.db, MONITOR: m.ns }, d, T0 + 120_000);
    expect(ran).toEqual([`sweep@${T0 + 120_000}`, "logs"]);
    expect(
      report.steps.filter((s) => ["sweep", "broken", "logs"].includes(s.step)).map((s) => s.status),
    ).toEqual(["ran", "failed", "ran"]);
  });

  it("[FD-ARCH-002] the Worker's scheduled export accepts the cron tick: records it and starts the liveness monitor", async () => {
    const m = monitor();
    const { deps: d } = deps();
    const waits: Promise<unknown>[] = [];
    scheduledHandler(() => d)(
      { scheduledTime: T0 + 60_000 },
      { DB: t.db, MONITOR: m.ns },
      { waitUntil: (p) => void waits.push(p) },
    );
    await Promise.all(waits);
    expect(m.started).toEqual(["control-plane"]);
    expect((await livenessReport(t.db, T0 + 90_000)).tick_age_ms).toBe(30_000);
  });

  it("[FD-OPS-038] [FD-ARCH-003] every 15 min inserts one canary.push ops intent under the fixture installation's permit", async () => {
    const m = monitor();
    const a = appliers();
    const { deps: d } = deps({ appliers: a.layer });
    const report = await tick({ DB: t.db, MONITOR: m.ns }, d, T0);
    expect(report.steps.find((s) => s.step === "canary-push")).toMatchObject({
      status: "ran",
      detail: `ops:canary:${T0}`,
    });
    await tick({ DB: t.db, MONITOR: m.ns }, d, T0 + 60_000);
    const rows = await outbox();
    expect(rows).toEqual([
      {
        id: `acme/canary/ops:canary:${T0}`,
        kind: "canary.push",
        limit_key: "42",
        execution_id: null,
        state: "applied",
      },
    ]);
    // The drainer applied it once, under a permit keyed by the installation.
    expect(a.applied.map((r) => r.kind)).toEqual(["canary.push"]);
    expect(a.permits[0]).toMatchObject({ limitKey: "42", kind: "canary.push", call: "apply" });
  });

  it("[FD-OPS-040] 5 min after the push, a canary with no concluded check raises canary-missed naming its last stage", async () => {
    const m = monitor();
    const { deps: d, alarms } = deps();
    await tick({ DB: t.db, MONITOR: m.ns }, d, T0);
    await recordVerifiedDelivery(t.db, { id: "42", accountLogin: "acme" }, T0 + 10_000);
    const report = await tick({ DB: t.db, MONITOR: m.ns }, d, T0 + 300_000);
    expect(report.steps.find((s) => s.step === "canary-check")).toMatchObject({
      status: "ran",
      detail: { stage: "delivery" },
    });
    expect(alarms.delivered).toEqual([
      expect.objectContaining({
        name: "canary-missed",
        severity: "page",
        state: "raised",
        detail: { last_stage: "delivery" },
      }),
    ]);
    // Checked once per push.
    const again = await tick({ DB: t.db, MONITOR: m.ns }, d, T0 + 360_000);
    expect(again.steps.find((s) => s.step === "canary-check")).toBeUndefined();
  });

  it("[FD-OPS-041] [FD-OPS-042] reads each installation and raises installation-lost for a 404 or a suspension", async () => {
    await setInstallationStatus(t.db, "1", "acme", "active", 0);
    await setInstallationStatus(t.db, "2", "globex", "active", 0);
    await setInstallationStatus(t.db, "3", "initech", "active", 0);
    const { deps: d, alarms } = deps({
      githubReads: reads({
        "1": { status: "active", accountLogin: "acme" },
        "2": { status: "suspended", accountLogin: "globex" },
      }),
    });
    await tick({ DB: t.db, MONITOR: monitor().ns }, d, T0);
    expect(
      alarms.delivered.filter((a) => a.name === "installation-lost").map((a) => a.detail),
    ).toEqual([
      { account_login: "globex", status: "suspended" },
      { account_login: "initech", status: "not-found" },
    ]);
    expect((await probeResults(t.db)).find((p) => p.name === "installation")).toMatchObject({
      ok: false,
    });
  });

  it("[FD-OPS-043] an installation event that deletes or suspends raises installation-lost at once", async () => {
    const { delivered, layer } = recordingAlarms();
    const run = (action: string) =>
      Effect.runPromise(
        onInstallationEvent(t.db, { action, installationId: "9", accountLogin: "acme" }, T0).pipe(
          Effect.provide(layer),
        ),
      );
    expect(await run("created")).toBe(false);
    expect(await run("suspend")).toBe(true);
    expect(delivered).toEqual([
      expect.objectContaining({
        name: "installation-lost",
        severity: "page",
        dedupeKey: "installation-lost:9",
      }),
    ]);
  });

  it("[FD-OPS-044] a non-2xx delivery in the last 15 min raises delivery-failing with the statuses and the count", async () => {
    const deliveries: Delivery[] = [
      { id: "d1", guid: "g1", statusCode: 502, deliveredAt: T0 - 60_000, redelivery: false },
      { id: "d2", guid: "g2", statusCode: 404, deliveredAt: T0 - 120_000, redelivery: false },
      { id: "d3", guid: "g3", statusCode: 200, deliveredAt: T0 - 3_600_000, redelivery: false },
    ];
    const { deps: d, alarms } = deps({ githubReads: reads({}, deliveries) });
    await tick({ DB: t.db, MONITOR: monitor().ns }, d, T0);
    expect(alarms.delivered.find((a) => a.name === "delivery-failing")).toMatchObject({
      severity: "page",
      detail: { count: 2, statuses: [404, 502] },
    });
  });

  it("[FD-OPS-045] redelivers each failed delivery of the last 24 h with no later success, once the path answers 2xx", async () => {
    const failed: Delivery = {
      id: "d1",
      guid: "g1",
      statusCode: 502,
      deliveredAt: T0 - 7_200_000,
      redelivery: false,
    };
    const retried: Delivery = {
      id: "d2",
      guid: "g2",
      statusCode: 500,
      deliveredAt: T0 - 7_000_000,
      redelivery: false,
    };
    const retriedOk: Delivery = {
      id: "d3",
      guid: "g2",
      statusCode: 200,
      deliveredAt: T0 - 6_000_000,
      redelivery: true,
    };
    const healthy: Delivery = {
      id: "d4",
      guid: "g4",
      statusCode: 200,
      deliveredAt: T0 - 60_000,
      redelivery: false,
    };
    expect(deliveriesToRedeliver([failed, retried], T0)).toEqual([]);
    expect(deliveriesToRedeliver([failed, retried, retriedOk, healthy], T0)).toEqual([failed]);
    const { deps: d } = deps({ githubReads: reads({}, [failed, retried, retriedOk, healthy]) });
    await tick({ DB: t.db, MONITOR: monitor().ns }, d, T0);
    await tick({ DB: t.db, MONITOR: monitor().ns }, d, T0 + PROBE_INTERVAL_MS);
    expect((await outbox()).filter((r) => r.kind === "delivery.redeliver")).toEqual([
      {
        id: "app/ops:redeliver:d1",
        kind: "delivery.redeliver",
        limit_key: "app",
        execution_id: null,
        state: "pending",
      },
    ]);
  });

  it("[FD-OPS-046] each probe's result is recorded for the heartbeat and the health report", async () => {
    const { deps: d } = deps({ githubReads: reads({}, []) });
    await tick({ DB: t.db, MONITOR: monitor().ns }, d, T0);
    expect((await probeResults(t.db)).map((p) => [p.name, p.ok])).toEqual([
      ["delivery", true],
      ["installation", true],
    ]);
  });

  it("[FD-OPS-089] an installation with an enrolled repository and no verified delivery for the configured hours is webhook-silent", async () => {
    await recordVerifiedDelivery(
      t.db,
      { id: "1", accountLogin: "acme", enrolled: true },
      T0 - 25 * 3_600_000,
    );
    await recordVerifiedDelivery(
      t.db,
      { id: "2", accountLogin: "globex", enrolled: false },
      T0 - 25 * 3_600_000,
    );
    await recordVerifiedDelivery(
      t.db,
      { id: "3", accountLogin: "initech", enrolled: true },
      T0 - 3_600_000,
    );
    const { deps: d, alarms } = deps();
    await tick({ DB: t.db, MONITOR: monitor().ns }, d, T0);
    expect(alarms.delivered.filter((a) => a.name === "webhook-silent")).toEqual([
      expect.objectContaining({
        severity: "notify",
        detail: { account_login: "acme", silent_hours: 24 },
      }),
    ]);
  });

  it("a tick runs each step on its own and reports the ones its composition cannot run", async () => {
    const { deps: d } = deps({ probes: undefined });
    const report = await tick({ DB: t.db, MONITOR: monitor().ns }, d, T0);
    expect(report.steps.map((s) => [s.step, s.status])).toEqual([
      ["record-tick", "ran"],
      ["liveness-monitor", "ran"],
      ["drain", "skipped"],
      ["kill-lines", "ran"],
      ["canary-push", "skipped"],
      ["installation-probe", "skipped"],
      ["delivery-probe", "skipped"],
      ["webhook-silence", "ran"],
    ]);
    const failing = {
      idFromName: (n: string) => n,
      get: () => ({ start: () => Promise.reject(new Error("down")) }),
    };
    const r2 = await tick({ DB: t.db, MONITOR: failing }, d, T0 + 60_000);
    expect(r2.steps.find((s) => s.step === "liveness-monitor")).toMatchObject({ status: "failed" });
    expect(r2.steps.find((s) => s.step === "record-tick")).toMatchObject({ status: "ran" });
  });

  it("[FD-VER-030] the tick reads the kill lines once a day and raises kill-line for a crossed line", async () => {
    // A warm run only 10% faster than the cloud setup crosses the warm-state line.
    for (const [id, kind, ms] of [
      ["d1", "device", 90_000],
      ["c1", "cloudflare-sandbox", 100_000],
    ] as const) {
      await t.db
        .prepare(
          "insert into executions (id, scope_id, run, class, status, enqueued_at, finished_at) values (?, 'acme/app', 'check', 'required', 'success', ?, ?)",
        )
        .bind(id, T0 - 60_000 - ms, T0 - 60_000)
        .run();
      await t.db
        .prepare(
          "insert into placements (execution_id, state, epoch, accepted_kind, eligible_kinds) values (?, 'accepted', 1, ?, ?)",
        )
        .bind(id, kind, JSON.stringify([kind]))
        .run();
    }
    const { deps: d, alarms } = deps({ probes: undefined });
    const ran = async (now: number) =>
      (await tick({ DB: t.db, MONITOR: monitor().ns }, d, now)).steps.find(
        (s) => s.step === "kill-lines",
      );
    expect(await ran(T0)).toMatchObject({ status: "ran" });
    expect(alarms.delivered.filter((a) => a.name === "kill-line")).toEqual([
      expect.objectContaining({
        severity: "notify",
        state: "raised",
        detail: {
          risk: "Warm state saves less than assumed",
          metric: "device median time to verdict below the best cloud setup, % (run check)",
          value: 10,
          threshold: 30,
        },
      }),
    ]);
    expect(await ran(T0 + 60_000)).toBeUndefined();
    expect(await ran(T0 + 86_400_000 - 60_000)).toBeUndefined();
    expect(await ran(T0 + 86_400_000)).toMatchObject({ status: "ran" });
    expect(alarms.delivered.filter((a) => a.name === "kill-line")).toHaveLength(2);
  });

  it("[FD-VER-030] a kill-line notification whose delivery failed is sent again on the next tick", async () => {
    for (const [id, kind, ms] of [
      ["d1", "device", 90_000],
      ["c1", "cloudflare-sandbox", 100_000],
    ] as const) {
      await t.db
        .prepare(
          "insert into executions (id, scope_id, run, class, status, enqueued_at, finished_at) values (?, 'acme/app', 'check', 'required', 'success', ?, ?)",
        )
        .bind(id, T0 - 60_000 - ms, T0 - 60_000)
        .run();
      await t.db
        .prepare(
          "insert into placements (execution_id, state, epoch, accepted_kind, eligible_kinds) values (?, 'accepted', 1, ?, ?)",
        )
        .bind(id, kind, JSON.stringify([kind]))
        .run();
    }
    // The port fails every kill-line delivery until `failing` is cleared.
    let failing = true;
    const delivered: Alarm[] = [];
    const alarmPort = Layer.succeed(AlarmPort, {
      deliver: (alarm) =>
        failing && alarm.name === "kill-line"
          ? Effect.fail(new AlarmDeliveryFailed({ reason: "sink down" }))
          : Effect.sync(() => void delivered.push(alarm)),
    });
    const { deps: d } = deps({ probes: undefined, alarmPort });
    const killLines = async (now: number) =>
      (await tick({ DB: t.db, MONITOR: monitor().ns }, d, now)).steps.find(
        (s) => s.step === "kill-lines",
      );
    expect(await killLines(T0)).toMatchObject({
      status: "ran",
      detail: { raised: [{ risk: "Warm state saves less than assumed", result: "failed" }] },
    });
    failing = false;
    expect(await killLines(T0 + 60_000)).toMatchObject({
      status: "ran",
      detail: { raised: [{ risk: "Warm state saves less than assumed", result: "sent" }] },
    });
    expect(delivered.filter((a) => a.name === "kill-line")).toHaveLength(1);
    expect(await killLines(T0 + 120_000)).toBeUndefined();
  });

  it("the monitor's wake raises cron-silent once the tick is older than 2 min, and the next tick resolves it", async () => {
    const { deps: d, alarms } = deps({ probes: undefined });
    await tick({ DB: t.db, MONITOR: monitor().ns }, d, T0 + 60_000);
    const check = (now: number) =>
      Effect.runPromise(checkCronSilent(t.db, now).pipe(Effect.provide(d.alarmPort)));
    expect(await check(T0 + 180_000)).toBe(false);
    expect(await check(T0 + 181_000)).toBe(true);
    await tick({ DB: t.db, MONITOR: monitor().ns }, d, T0 + 240_000);
    expect(alarms.delivered.map((a) => [a.name, a.state])).toEqual([
      ["cron-silent", "raised"],
      ["cron-silent", "resolved"],
    ]);
  });
});
