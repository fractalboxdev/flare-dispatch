import { VERDICT_RECORD_SCHEMA } from "@fractalboxdev/flare-dispatch-github";
import { d1IntakeStore, IntakeStore, migrateIntake } from "@fractalboxdev/flare-dispatch-intake";
import { buildProfile, profile } from "@fractalboxdev/flare-dispatch-profile";
import { insertOutboxRows } from "@fractalboxdev/mameko-host-cloudflare/d1";
import { newRow } from "@fractalboxdev/mameko-kernel";
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
  FixtureInstallationMissing,
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
  insertOpsIntent,
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
  listed: readonly { installationId: string; accountLogin: string }[] = [],
) =>
  Layer.succeed(GithubAppReads, {
    installations: Effect.succeed(listed),
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
      { id: 1001, guid: "g1", statusCode: 502, deliveredAt: T0 - 60_000, redelivery: false },
      { id: 1002, guid: "g2", statusCode: 404, deliveredAt: T0 - 120_000, redelivery: false },
      { id: 1003, guid: "g3", statusCode: 200, deliveredAt: T0 - 3_600_000, redelivery: false },
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
      id: 1001,
      guid: "g1",
      statusCode: 502,
      deliveredAt: T0 - 7_200_000,
      redelivery: false,
    };
    const retried: Delivery = {
      id: 1002,
      guid: "g2",
      statusCode: 500,
      deliveredAt: T0 - 7_000_000,
      redelivery: false,
    };
    const retriedOk: Delivery = {
      id: 1003,
      guid: "g2",
      statusCode: 200,
      deliveredAt: T0 - 6_000_000,
      redelivery: true,
    };
    const healthy: Delivery = {
      id: 1004,
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
        id: "app/ops:redeliver:1001",
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
      ["verdict-records", "skipped"],
      ["record-undelivered", "skipped"],
      ["advisory-snapshot-stale", "skipped"],
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

describe("the GitHub probes' rows and reads", () => {
  const payloadOf = async (kind: string) =>
    (
      (
        await t.db
          .prepare("select payload_json from outbox where kind = ? order by id")
          .bind(kind)
          .all()
      ).results as { payload_json: string }[]
    ).map((r) => JSON.parse(r.payload_json) as unknown);

  it("[FD-OPS-038] the canary.push payload names the canary branch and the tick time the commit message carries", async () => {
    const { deps: d } = deps();
    await tick({ DB: t.db, MONITOR: monitor().ns }, d, T0);
    expect(await payloadOf("canary.push")).toEqual([
      { branch: "flare-dispatch-canary", tick_time: new Date(T0).toISOString() },
    ]);
  });

  it("[FD-OPS-038] [FD-OPS-040] the push resolves the fixture installation once, and the check reads the installation the push recorded", async () => {
    const a = appliers();
    let reads = 0;
    const { deps: d, alarms } = deps({
      appliers: a.layer,
      probes: Effect.sync(() => {
        reads++;
        return { fixtureRepo: "acme/canary", fixtureInstallation: "77", webhookSilentHours: 24 };
      }),
    });
    await tick({ DB: t.db, MONITOR: monitor().ns }, d, T0);
    await tick({ DB: t.db, MONITOR: monitor().ns }, d, T0 + 60_000);
    expect(a.permits[0]).toMatchObject({ limitKey: "77", kind: "canary.push" });
    const report = await tick({ DB: t.db, MONITOR: monitor().ns }, d, T0 + 300_000);
    expect(report.steps.find((s) => s.step === "canary-check")).toMatchObject({
      status: "ran",
      detail: { stage: "push" },
    });
    expect(reads).toBe(1);
    expect(alarms.delivered.find((x) => x.name === "canary-missed")).toMatchObject({
      detail: { last_stage: "push" },
    });
  });

  it("[FD-OPS-040] a probe configuration read that fails after a successful push still lets the check raise canary-missed", async () => {
    let pushTick = true;
    const { deps: d, alarms } = deps({
      probes: Effect.suspend(() =>
        pushTick
          ? Effect.succeed({
              fixtureRepo: "acme/canary",
              fixtureInstallation: "42",
              webhookSilentHours: 24,
            })
          : Effect.fail("GitHub answered 502"),
      ),
    });
    await tick({ DB: t.db, MONITOR: monitor().ns }, d, T0);
    pushTick = false;
    await recordVerifiedDelivery(t.db, { id: "42", accountLogin: "acme" }, T0 + 10_000);
    const report = await tick({ DB: t.db, MONITOR: monitor().ns }, d, T0 + 300_000);
    expect(report.steps.find((s) => s.step === "canary-check")).toMatchObject({
      status: "ran",
      detail: { stage: "delivery" },
    });
    expect(alarms.delivered.find((x) => x.name === "canary-missed")).toMatchObject({
      state: "raised",
      detail: { last_stage: "delivery" },
    });
  });

  it("[FD-OPS-038] [FD-OPS-040] a fixture repository no installation covers raises canary-missed at the push stage and records the canary probe not ok", async () => {
    const { deps: d, alarms } = deps({
      probes: Effect.fail(new FixtureInstallationMissing({ repository: "acme/canary" })),
    });
    const report = await tick({ DB: t.db, MONITOR: monitor().ns }, d, T0);
    expect(report.steps.find((s) => s.step === "canary-push")).toMatchObject({
      status: "failed",
      cause: expect.stringContaining("FixtureInstallationMissing"),
    });
    expect(alarms.delivered).toEqual([
      expect.objectContaining({
        name: "canary-missed",
        severity: "page",
        state: "raised",
        detail: { last_stage: "push", repository: "acme/canary" },
      }),
    ]);
    expect((await probeResults(t.db)).find((p) => p.name === "canary")).toMatchObject({
      ok: false,
      detail: { stage: "push", reason: "no installation covers acme/canary" },
    });
  });

  it("[FD-OPS-038] a probe configuration read that fails fails the canary step alone", async () => {
    const { deps: d } = deps({
      githubReads: reads({}, []),
      probes: Effect.fail("no installation covers acme/canary"),
    });
    const report = await tick({ DB: t.db, MONITOR: monitor().ns }, d, T0);
    expect(report.steps.find((s) => s.step === "canary-push")?.status).toBe("failed");
    expect(
      report.steps
        .filter((s) => ["installation-probe", "delivery-probe", "webhook-silence"].includes(s.step))
        .map((s) => s.status),
    ).toEqual(["ran", "ran", "ran"]);
    expect(await payloadOf("canary.push")).toEqual([]);
  });

  it("[FD-OPS-041] [FD-OPS-042] registers every installation the App lists, and one it stops listing reads lost", async () => {
    const { deps: listed } = deps({
      githubReads: reads(
        { "5": { status: "active", accountLogin: "acme" } },
        [],
        [{ installationId: "5", accountLogin: "acme" }],
      ),
    });
    await tick({ DB: t.db, MONITOR: monitor().ns }, listed, T0);
    expect((await livenessReport(t.db, T0)).installations).toEqual([
      expect.objectContaining({ installation_id: "5", account_login: "acme", status: "active" }),
    ]);
    // Uninstalled: the App lists it no more, and its read answers 404.
    const { deps: gone, alarms } = deps({ githubReads: reads({}, [], []) });
    await tick({ DB: t.db, MONITOR: monitor().ns }, gone, T0 + PROBE_INTERVAL_MS);
    expect(alarms.delivered.find((a) => a.name === "installation-lost")).toMatchObject({
      severity: "page",
      detail: { account_login: "acme", status: "not-found" },
    });
  });

  it("[FD-OPS-045] the delivery.redeliver payload carries GitHub's numeric delivery id", async () => {
    const failed: Delivery = {
      id: 9001,
      guid: "g1",
      statusCode: 502,
      deliveredAt: T0 - 600_000,
      redelivery: false,
    };
    const healthy: Delivery = {
      id: 9002,
      guid: "g2",
      statusCode: 200,
      deliveredAt: T0 - 60_000,
      redelivery: false,
    };
    const { deps: d } = deps({ githubReads: reads({}, [failed, healthy]) });
    await tick({ DB: t.db, MONITOR: monitor().ns }, d, T0);
    expect(await payloadOf("delivery.redeliver")).toEqual([{ delivery_id: 9001 }]);
  });
});

describe("the minute tick's job and verdict records", () => {
  /** The phase 2 profile of a deploy whose overlay sets `records.url`. */
  const withRecords = buildProfile("production", 2, { records: true });
  const SHA = "c".repeat(40);
  const FINISHED = T0 - 120_000;

  /** One admitted execution as the control plane records it: intake's record and mameko's execution row. */
  const seed = async (
    id: string,
    status: string,
    over: { reason?: string; label?: string | null; trigger?: string } = {},
  ) => {
    await Effect.runPromise(
      IntakeStore.use((s) =>
        s.put({
          executionId: id,
          trigger: (over.trigger ?? "push") as never,
          run: "ci",
          label: over.label ?? null,
          repo: "acme/app",
          sha: SHA,
          ref: "refs/heads/main",
          inputs: { token: "not-recorded" },
          className: "required",
          labels: [],
          attempt: 1,
          familyRoot: id,
          installation: 7,
          caller: null,
          notBefore: null,
          spendLine: null,
          placementConstraint: null,
          cacheTrigger: { _tag: "Other" },
          eligibleKinds: ["cloud"],
          repositoryPublic: null,
          inputAssociations: [],
          createdAt: FINISHED - 60_000,
        }),
      ).pipe(Effect.provide(d1IntakeStore(t.db))),
    );
    const terminal = status !== "pending" && status !== "running";
    await t.db
      .prepare(
        `insert into executions (id, scope_id, run, class, status, reason, enqueued_at, finished_at)
         values (?, 'acme/app', 'ci', 'required', ?, ?, ?, ?)`,
      )
      .bind(id, status, over.reason ?? null, FINISHED - 60_000, terminal ? FINISHED : null)
      .run();
  };

  const row = (
    executionId: string,
    intentKey: string,
    kind: string,
    payload: unknown,
    state: "pending" | "applied" = "pending",
  ) => ({
    id: `${executionId}:${intentKey}`,
    limitKey: "acme/app",
    tier: "effect" as const,
    priority: 0,
    classRank: 1,
    drawsReserve: false,
    intent: {
      executionId,
      scopeId: "acme/app",
      intentKey,
      kind,
      payload,
      payloadDigest: JSON.stringify(payload),
      effectClass: "adoptable" as const,
      attempts: 0,
    },
    row: {
      ...newRow({ effectClass: "adoptable", insertedAt: FINISHED }),
      state,
      ...(state === "applied" ? { appliedAt: FINISHED + 1 } : {}),
    },
  });

  /** Admission's `cp:check:open` row and the applied outcome row of an execution that owns a check run. */
  const ownsCheck = (id: string, name: string, outcome?: unknown) =>
    insertOutboxRows(t.db, [
      row(id, "cp:check:open", "check.open", { name, head_sha: SHA }, "applied"),
      ...(outcome === undefined
        ? []
        : [row(id, "cp:outcome", "check.conclude", { outcome }, "applied")]),
    ]);

  const records = async () =>
    (
      await t.db
        .prepare(
          `select id, execution_id, scope_id, intent_key, limit_key, state, payload_json from outbox
           where kind = 'verdict.record' order by id`,
        )
        .all()
    ).results as {
      id: string;
      execution_id: string | null;
      scope_id: string;
      intent_key: string;
      limit_key: string;
      state: string;
      payload_json: string;
    }[];

  const executionRow = async (id: string) =>
    (
      await t.db
        .prepare("select status, reason, finished_at from executions where id = ?")
        .bind(id)
        .all()
    ).results[0];

  beforeEach(async () => {
    await Effect.runPromise(migrateIntake(t.db));
  });

  it("[FD-GH-094] where records.url is set, each tick inserts one verdict.record ops intent keyed verdict-record:<execution_id> on the records key for each terminal execution without one", async () => {
    await seed("e-pass", "success");
    await t.db
      .prepare(
        "insert into placements (execution_id, state, epoch, accepted_epoch) values (?, ?, ?, ?)",
      )
      .bind("e-pass", "accepted", 2, 2)
      .run();
    await ownsCheck("e-pass", "flare-dispatch/ci:lint", { _tag: "Success", epoch: 2 });
    // A failure that owns no check run and was never placed.
    await seed("e-fail", "failure", { reason: "infra: no executor" });
    // A check run whose conclusion is not applied yet: the record carries no conclusion.
    await seed("e-halted", "cancelled", { reason: "operator-cancel", label: "e2e" });
    await ownsCheck("e-halted", "flare-dispatch/ci:e2e");
    await seed("e-live", "running");
    // An execution recorded before this tick keeps its one row.
    await seed("e-known", "success");
    const known = await Effect.runPromise(
      insertOpsIntent(
        t.db,
        withRecords,
        {
          scopeId: "acme/app",
          intentKey: "verdict-record:e-known",
          kind: "verdict.record",
          payload: { earlier: true },
          limitKey: "records",
        },
        FINISHED,
      ),
    );
    expect(known).toBe("ops:verdict-record:e-known");

    const { deps: d } = deps({ profile: withRecords, probes: undefined });
    const report = await tick({ DB: t.db, MONITOR: monitor().ns }, d, T0);
    expect(report.steps.find((s) => s.step === "verdict-records")).toMatchObject({
      status: "ran",
      detail: ["e-fail", "e-halted", "e-pass"],
    });

    const rows = await records();
    expect(rows.map((r) => [r.id, r.execution_id, r.intent_key, r.limit_key, r.state])).toEqual([
      [
        "acme/app/ops:verdict-record:e-fail",
        null,
        "ops:verdict-record:e-fail",
        "records",
        "pending",
      ],
      [
        "acme/app/ops:verdict-record:e-halted",
        null,
        "ops:verdict-record:e-halted",
        "records",
        "pending",
      ],
      [
        "acme/app/ops:verdict-record:e-known",
        null,
        "ops:verdict-record:e-known",
        "records",
        "pending",
      ],
      [
        "acme/app/ops:verdict-record:e-pass",
        null,
        "ops:verdict-record:e-pass",
        "records",
        "pending",
      ],
    ]);
    const payload = (id: string) =>
      JSON.parse(rows.find((r) => r.intent_key === `ops:verdict-record:${id}`)!.payload_json);
    expect(payload("e-pass")).toEqual({
      schema: VERDICT_RECORD_SCHEMA,
      execution_id: "e-pass",
      epoch: 2,
      run: "ci",
      repository: "acme/app",
      commit_sha: SHA,
      ref: "refs/heads/main",
      class: "required",
      trigger: "push",
      verdict: "success",
      reason: null,
      conclusion: "success",
      check_name: "flare-dispatch/ci:lint",
    });
    expect(payload("e-fail")).toMatchObject({
      epoch: 0,
      verdict: "failure",
      reason: "infra: no executor",
      conclusion: null,
      check_name: null,
    });
    expect(payload("e-halted")).toMatchObject({
      verdict: "cancelled",
      reason: "operator-cancel",
      conclusion: null,
      check_name: "flare-dispatch/ci:e2e",
    });
    expect(payload("e-known")).toEqual({ earlier: true });

    // The next tick inserts nothing for a recorded execution; one that ends meanwhile gets its own row.
    const again = await tick({ DB: t.db, MONITOR: monitor().ns }, d, T0 + 60_000);
    expect(again.steps.find((s) => s.step === "verdict-records")).toMatchObject({ detail: [] });
    await t.db
      .prepare("update executions set status = 'success', finished_at = ? where id = 'e-live'")
      .bind(T0 + 90_000)
      .run();
    const later = await tick({ DB: t.db, MONITOR: monitor().ns }, d, T0 + 120_000);
    expect(later.steps.find((s) => s.step === "verdict-records")).toMatchObject({
      detail: ["e-live"],
    });
    expect((await records()).map((r) => r.intent_key)).toEqual([
      "ops:verdict-record:e-fail",
      "ops:verdict-record:e-halted",
      "ops:verdict-record:e-known",
      "ops:verdict-record:e-live",
      "ops:verdict-record:e-pass",
    ]);
  });

  it("[FD-GH-094] [FD-GH-102] where the overlay sets no records.url, the tick inserts no verdict.record and pages for no record", async () => {
    await seed("e-pass", "success");
    const { deps: d, alarms } = deps({ probes: undefined });
    expect(d.profile.intent_kinds["verdict.record"]).toBeUndefined();
    const report = await tick({ DB: t.db, MONITOR: monitor().ns }, d, T0);
    expect(
      report.steps
        .filter((s) => ["verdict-records", "record-undelivered"].includes(s.step))
        .map((s) => [s.step, s.status]),
    ).toEqual([
      ["verdict-records", "skipped"],
      ["record-undelivered", "skipped"],
    ]);
    expect(await records()).toEqual([]);
    expect(alarms.delivered.filter((a) => a.name === "record-undelivered")).toEqual([]);
  });

  /** The record actuator answering `refused` for every row, with the rate limit granting each permit. */
  const refusingRecords = (reason: string) => {
    const calls: IntentRow[] = [];
    const refusing: Actuator = {
      apply: (r) => Effect.sync(() => (calls.push(r), { _tag: "refused" as const, reason })),
      lookup: () => Effect.succeed({ _tag: "absent" as const }),
      reconcile: () => Effect.succeed({ _tag: "absent" as const }),
    };
    const layer = Layer.merge(
      Layer.succeed(
        Actuators,
        actuatorRegistry(
          Object.fromEntries(
            Object.values(withRecords.intent_kinds).map((k) => [k.actuator, refusing]),
          ),
        ),
      ),
      Layer.succeed(ActuatorRateLimit, {
        acquire: () => Effect.succeed({ _tag: "granted" as const, permitId: "p" }),
        release: () => Effect.void,
      }),
    );
    return { calls, layer };
  };

  it("[FD-GH-102] a verdict.record row the applier refuses raises the page alarm record-undelivered naming the execution, once, and leaves the verdict unchanged", async () => {
    await seed("e-fail", "failure", { reason: "test: 2 failed" });
    await ownsCheck("e-fail", "flare-dispatch/ci", {
      _tag: "Failure",
      reason: "test: 2 failed",
      epoch: 1,
    });
    const before = await executionRow("e-fail");
    const conclusionRows = async () =>
      (
        await t.db
          .prepare("select id, state, payload_json from outbox where kind = 'check.conclude'")
          .all()
      ).results;
    const concludedBefore = await conclusionRows();
    const refusing = refusingRecords("verdict.record: records 400");
    const { deps: d, alarms } = deps({
      profile: withRecords,
      probes: undefined,
      appliers: refusing.layer,
    });
    const env = { DB: t.db, MONITOR: monitor().ns };
    // The first tick inserts the record; the next one's drain sends it and the applier refuses it.
    await tick(env, d, T0);
    expect(alarms.delivered.filter((a) => a.name === "record-undelivered")).toEqual([]);
    await tick(env, d, T0 + 60_000);
    expect(refusing.calls.map((r) => r.intentKey)).toEqual(["ops:verdict-record:e-fail"]);
    expect((await records()).map((r) => r.state)).toEqual(["refused"]);
    const paged = alarms.delivered.filter((a) => a.name === "record-undelivered");
    expect(paged).toEqual([
      expect.objectContaining({
        name: "record-undelivered",
        severity: "page",
        state: "raised",
        detail: {
          execution_id: "e-fail",
          kind: "verdict.record",
          state: "refused",
          reason: "verdict.record: records 400",
        },
      }),
    ]);
    // A refused row stays refused, and its alarm is not sent again.
    await tick(env, d, T0 + 120_000);
    await tick(env, d, T0 + 86_400_000 + 180_000);
    expect(alarms.delivered.filter((a) => a.name === "record-undelivered")).toHaveLength(1);
    // The execution's verdict and its check run's conclusion stay as they were.
    expect(await executionRow("e-fail")).toEqual(before);
    expect(await conclusionRows()).toEqual(concludedBefore);
  });

  it("pages for an expired verdict.record and a refused job.record by execution, and sends a page whose delivery failed again", async () => {
    await seed("e-old", "success");
    await seed("e-leased", "running");
    await Effect.runPromise(
      insertOpsIntent(
        t.db,
        withRecords,
        {
          scopeId: "acme/app",
          intentKey: "verdict-record:e-old",
          kind: "verdict.record",
          payload: { execution_id: "e-old" },
          limitKey: "records",
        },
        FINISHED,
      ),
    );
    await insertOutboxRows(t.db, [row("e-leased", "cp:job-record", "job.record", {})]);
    await t.db
      .prepare("update outbox set state = 'expired' where intent_key = 'ops:verdict-record:e-old'")
      .run();
    await t.db
      .prepare(
        "update outbox set state = 'refused', last_error = 'job.record: records 403' where kind = 'job.record'",
      )
      .run();
    let failing = true;
    const delivered: { dedupeKey: string; detail: unknown }[] = [];
    const flaky = Layer.succeed(AlarmPort, {
      deliver: (alarm: Alarm) =>
        failing && alarm.name === "record-undelivered"
          ? Effect.fail(new AlarmDeliveryFailed({ reason: "sink down" }))
          : Effect.sync(() => void delivered.push(alarm)),
    });
    const { deps: d } = deps({ profile: withRecords, probes: undefined, alarmPort: flaky });
    const env = { DB: t.db, MONITOR: monitor().ns };
    await tick(env, d, T0);
    expect(delivered.filter((a) => a.dedupeKey.startsWith("record-undelivered"))).toEqual([]);
    failing = false;
    await tick(env, d, T0 + 60_000);
    await tick(env, d, T0 + 120_000);
    expect(
      delivered
        .filter((a) => a.dedupeKey.startsWith("record-undelivered"))
        .map((a) => a.detail)
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    ).toEqual([
      {
        execution_id: "e-leased",
        kind: "job.record",
        state: "refused",
        reason: "job.record: records 403",
      },
      { execution_id: "e-old", kind: "verdict.record", state: "expired", reason: null },
    ]);
  });
});
