// mameko's coordinator conformance suite, at the pinned release, on FlareDispatch's composed control plane:
// host-cloudflare's D1 stores and runtime Layer under workerd, with FlareDispatch's profile and application ports and
// its appliers on a fake GitHub (specs/verification.md FD-VER-032). Each mameko scenario runs on a fresh database.
import {
  alarmPortLayer,
  insertOpsIntent,
  runOpsMigrations,
} from "@fractalboxdev/flare-dispatch-ops";
import {
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
import { actuatorBindings, drainOnce } from "@fractalboxdev/mameko-coordinator";
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
import { Effect, Layer } from "effect";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

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
