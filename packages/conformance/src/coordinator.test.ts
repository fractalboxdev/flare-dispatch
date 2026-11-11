// mameko's coordinator conformance suite, at the pinned release, on FlareDispatch's composed control plane:
// host-cloudflare's D1 stores and runtime Layer under workerd, with FlareDispatch's profile and application ports and
// its appliers on a fake GitHub (specs/verification.md FD-VER-032). Each mameko scenario runs on a fresh database.
// The workflow starts run through the control plane's own admission port and minute-tick sweeps on that database.
import {
  catalogRuns,
  d1Admission,
  d1IntakeStore,
  d1ShedRecorder,
  IntakeConfig,
  migrateIntake,
  submission,
  submit,
  type IntakeSettings,
} from "@fractalboxdev/flare-dispatch-intake";
import { recordingResolver } from "@fractalboxdev/flare-dispatch-intake/testing";
import {
  alarmPortLayer,
  insertOpsIntent,
  runOpsMigrations,
} from "@fractalboxdev/flare-dispatch-ops";
import {
  buildProfile,
  ConfigurationSourceLive,
  GateDecisionSourceLive,
  missingPorts,
  profile,
} from "@fractalboxdev/flare-dispatch-profile";
import {
  ALLOWANCE_STORE_SCENARIOS,
  CAPACITY_LEASE_STORE_SCENARIOS,
  DRAINER_SCENARIOS,
  EXECUTION_STORE_SCENARIOS,
  GATE_SCENARIOS,
  LEASE_STORE_SCENARIOS,
  OUTBOX_STORE_SCENARIOS,
  RUNTIME_SCENARIOS,
} from "@fractalboxdev/mameko-conformance";
import {
  actuatorBindings,
  drainOnce,
  type ExecutionPayload,
} from "@fractalboxdev/mameko-coordinator";
import {
  d1AllowanceStore,
  d1CapacityLeaseStore,
  d1ExecutionStore,
  d1LeaseStore,
  d1OutboxStore,
  insertOutboxRows,
  runD1Migrations,
  type D1Like,
} from "@fractalboxdev/mameko-host-cloudflare/d1";
import { cloudflareRuntimeLayer } from "@fractalboxdev/mameko-host-cloudflare/runtime";
import {
  ActuatorRateLimit,
  Actuators,
  actuatorRegistry,
  AlarmPort,
  ConfigurationSource,
  GateDecisionSource,
  type IntentRow,
} from "@fractalboxdev/mameko-ports";
import { Effect, Layer, ManagedRuntime } from "effect";
import { TestClock } from "effect/testing";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startExecutionOf } from "../../../apps/control-plane/src/composition.ts";
import type { ControlPlaneEnv } from "../../../apps/control-plane/src/config.ts";
import { startSweeps } from "../../../apps/control-plane/src/tick.ts";

let mf: Miniflare;
let n = 0;
beforeAll(() => {
  mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response(''); } }",
    compatibilityDate: "2026-05-01",
    d1Databases: Array.from({ length: 120 }, (_, i) => `DB${i}`),
  });
}, 60_000);
afterAll(() => mf?.dispose());

const freshDb = async () => {
  const db = (await mf.getD1Database(`DB${n++}`)) as unknown as D1Like;
  await runD1Migrations(db);
  return db;
};

const anchor = () => {
  let at = 0;
  return { read: async () => at, advance: async (e: number) => (at = Math.max(at, e)) };
};

const title = (ids: readonly string[], name: string) =>
  `[FD-VER-032] ${ids.map((id) => `[${id}]`).join(" ")} ${name}`;

describe("mameko's coordinator suite on host-cloudflare in FlareDispatch's control plane", () => {
  for (const s of RUNTIME_SCENARIOS)
    it(title(s.ids, s.name), async () =>
      s.run({ runtime: cloudflareRuntimeLayer({ db: await freshDb(), anchor: anchor() }) }),
    );
  for (const s of [...OUTBOX_STORE_SCENARIOS, ...DRAINER_SCENARIOS, ...GATE_SCENARIOS])
    it(title(s.ids, s.name), async () => {
      const db = await freshDb();
      await s.run({ layer: d1OutboxStore(db), seed: (rows) => insertOutboxRows(db, rows) });
    });
  for (const s of EXECUTION_STORE_SCENARIOS)
    it(title(s.ids, s.name), async () => {
      const db = await freshDb();
      await s.run({
        layer: d1ExecutionStore(db),
        // The claim of a serial group member's first lease takes the group (MAMEKO-ADM-070).
        takeGroup: async (executionId, at) => {
          await db
            .prepare("update executions set serial_held_at = ? where id = ?")
            .bind(at, executionId)
            .run();
        },
      });
    });
  for (const s of LEASE_STORE_SCENARIOS)
    it(title(s.ids, s.name), async () => s.run({ layer: d1LeaseStore(await freshDb()) }));
  for (const s of ALLOWANCE_STORE_SCENARIOS)
    it(title(s.ids, s.name), async () => s.run({ layer: d1AllowanceStore(await freshDb()) }));
  for (const s of CAPACITY_LEASE_STORE_SCENARIOS)
    it(title(s.ids, s.name), async () => s.run({ layer: d1CapacityLeaseStore(await freshDb()) }));
});

describe("FlareDispatch's application ports on the runtime Layer", () => {
  it("[FD-VER-032] [FD-ARCH-039] the phase 0 profile needs no port beyond the ones the composition supplies", async () => {
    const db = await freshDb();
    await runOpsMigrations(db);
    const applied: IntentRow[] = [];
    const permits: string[] = [];
    const actuator = {
      apply: (row: IntentRow) =>
        Effect.sync(() => (applied.push(row), { _tag: "applied" as const, externalRef: "sha" })),
      lookup: () => Effect.succeed({ _tag: "absent" as const }),
      reconcile: () => Effect.succeed({ _tag: "absent" as const }),
    };
    const fakeGithub = Layer.merge(
      Layer.succeed(
        Actuators,
        actuatorRegistry(
          Object.fromEntries(
            Object.values(profile.intent_kinds).map((k) => [k.actuator, actuator]),
          ),
        ),
      ),
      Layer.succeed(ActuatorRateLimit, {
        acquire: (r) =>
          Effect.sync(
            () => (permits.push(r.limitKey), { _tag: "granted" as const, permitId: "p" }),
          ),
        release: () => Effect.void,
      }),
    );
    const composed = Layer.mergeAll(
      cloudflareRuntimeLayer({ db, anchor: anchor() }),
      ConfigurationSourceLive,
      GateDecisionSourceLive,
      alarmPortLayer({
        db,
        sink: "https://alerts.example.com/hook",
        fetch: (async () => new Response(null, { status: 204 })) as unknown as typeof fetch,
      }),
      fakeGithub,
    );
    const supplied = [
      "actuator",
      "gate-decision-source",
      "configuration-source",
      "alarm-port",
      "actuator-rate-limit",
    ];
    expect(missingPorts(profile, supplied)).toEqual([]);
    await Effect.runPromise(
      insertOpsIntent(
        db,
        profile,
        {
          scopeId: "acme/canary",
          intentKey: "canary:1",
          kind: "canary.push",
          payload: { branch: "flare-dispatch-canary" },
          limitKey: "42",
        },
        1_000,
      ),
    );
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* ConfigurationSource;
        yield* GateDecisionSource;
        yield* AlarmPort;
        yield* drainOnce({
          now: 2_000,
          token: () => "t",
          random: () => 0.5,
          actuatorOf: actuatorBindings(profile.intent_kinds),
        });
      }).pipe(Effect.provide(composed)),
    );
    expect(applied.map((r) => r.kind)).toEqual(["canary.push"]);
    expect(permits).toEqual(["42"]);
  });
});

/**
 * A development control plane's admission and minute-tick start sweeps on a fresh database, with an `EXECUTION`
 * namespace that records each `ExecutionEngine` start by the object it reaches, and fails every start while `failing`.
 */
const startingPlane = async () => {
  const db = await freshDb();
  await Effect.runPromise(migrateIntake(db));
  const starts: { readonly object: string; readonly payload: ExecutionPayload }[] = [];
  const engine = { failing: false };
  const env = {
    DB: db,
    DEPLOYMENT: "development",
    EXECUTION: {
      idFromName: (name: string) => ({ name }),
      get: (id: { readonly name: string }) => ({
        start: async (payload: ExecutionPayload) => {
          if (engine.failing) throw new Error("ExecutionEngine unavailable");
          starts.push({ object: id.name, payload });
        },
      }),
    },
    CHANNEL: { idFromName: (name: string) => name, get: () => ({ wake: async () => {} }) },
  } as unknown as ControlPlaneEnv;
  const deployed = buildProfile("development");
  const catalog = catalogRuns("development");
  const settings: IntakeSettings = {
    catalog,
    profile: deployed,
    appId: 1,
    webhookSecret: undefined,
    webhookEvents: undefined,
    writeCredentialIn: () => null,
    allows: () => true,
    confidentiality: () => "unclassified",
  };
  const classOf = new Map<string, string>();
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(
      Layer.succeed(IntakeConfig, settings),
      d1Admission(db, deployed, { startExecution: startExecutionOf(env) }),
      d1IntakeStore(db),
      d1ShedRecorder(db),
      recordingResolver([], (r) => ({
        _tag: "Class",
        class: classOf.get(r.sha) ?? "batch",
        labels: [],
        alarm: null,
      })),
    ).pipe(Layer.provideMerge(TestClock.layer())),
  );
  const ADMITTED_AT = Date.UTC(2026, 10, 4, 12, 0, 0);
  await runtime.runPromise(TestClock.setTime(ADMITTED_AT));
  let n = 0;
  /** Admits a dispatch of `check` that resolves to `className`, and answers its execution id. */
  const admit = async (className: string) => {
    const sha = String(++n).padStart(40, "0");
    classOf.set(sha, className);
    const answer = await runtime.runPromise(
      submit(
        submission({
          run: catalog("check")!,
          trigger: "dispatch",
          event: null,
          repo: "acme/app",
          sha,
          ref: "refs/heads/main",
          inputs: {},
          cacheTrigger: { _tag: "Push", ref: "refs/heads/main", protected: true },
        }),
      ),
    );
    return answer.executionId;
  };
  /** The minute tick's two start sweeps at `at`. */
  const tick = async (at: number) => {
    for (const step of startSweeps(env, at))
      await Effect.runPromise(step.effect as Effect.Effect<unknown>);
  };
  const engineStarted = async (id: string) =>
    (
      (
        await db
          .prepare("select engine_started_at as at from executions where id = ?")
          .bind(id)
          .all()
      ).results[0] as { readonly at: number | null }
    ).at;
  return {
    env,
    engine,
    starts,
    admit,
    tick,
    engineStarted,
    ADMITTED_AT,
    dispose: () => runtime.dispose(),
  };
};

describe("the Execution workflow's start on the composed control plane", () => {
  it("[FD-ARCH-019] starts the workflow of a release, required or interactive execution in its ExecutionEngine at admission", async () => {
    const p = await startingPlane();
    try {
      const ids: Record<string, string> = {};
      for (const cls of ["release", "required", "interactive"]) ids[cls] = await p.admit(cls);
      expect(p.starts.map((s) => [s.object, s.payload.executionId, s.payload.className])).toEqual(
        Object.entries(ids).map(([cls, id]) => [id, id, cls]),
      );
      for (const s of p.starts) expect(s.payload.deadlineOutcome).toBe("failure");
      for (const id of Object.values(ids))
        expect(await p.engineStarted(id)).toEqual(expect.any(Number));
    } finally {
      await p.dispose();
    }
  }, 60_000);

  it("[FD-ARCH-019] starts no batch workflow at admission, and the stale-start sweep starts it at its stale_at", async () => {
    const p = await startingPlane();
    try {
      const batch = await p.admit("batch");
      expect(p.starts).toEqual([]);
      expect(await p.engineStarted(batch)).toBeNull();
      // The admission sweep leaves a deferred class to stale-start, and stale-start waits for `stale_at`
      // (12 h after admission under `stale_after.without_schedule_seconds`).
      await p.tick(p.ADMITTED_AT + 120_000);
      await p.tick(p.ADMITTED_AT + 42_600_000);
      expect(p.starts).toEqual([]);
      await p.tick(p.ADMITTED_AT + 43_230_000);
      expect(
        p.starts.map((s) => [s.object, s.payload.className, s.payload.deadlineOutcome]),
      ).toEqual([[batch, "batch", "deferred"]]);
    } finally {
      await p.dispose();
    }
  }, 60_000);

  it("[FD-ARCH-019] the admission sweep starts an admitted execution whose start at admission failed", async () => {
    const p = await startingPlane();
    try {
      p.engine.failing = true;
      const interactive = await p.admit("interactive");
      expect(await p.engineStarted(interactive)).toBeNull();
      p.engine.failing = false;
      // Younger than 60 s, the row waits for a later sweep.
      await p.tick(p.ADMITTED_AT + 30_000);
      expect(p.starts).toEqual([]);
      await p.tick(p.ADMITTED_AT + 120_000);
      expect(p.starts.map((s) => [s.object, s.payload.className])).toEqual([
        [interactive, "interactive"],
      ]);
      expect(await p.engineStarted(interactive)).toBe(p.ADMITTED_AT + 120_000);
    } finally {
      await p.dispose();
    }
  }, 60_000);
});
