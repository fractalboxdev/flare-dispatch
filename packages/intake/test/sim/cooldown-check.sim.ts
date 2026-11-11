// A cooldown run's check run through hold, release and the outbox (specs/intake.md § Cooldown). A seed fixes a run of
// pull_request webhooks on a few head SHAs, clock advances, minute ticks that release held requests, and outbox drains
// through the check-run applier against a fake GitHub. Each webhook goes through intake's route into mameko's admission
// on a SQLite D1. After every step the scenario checks that every held request's check run is `queued` under the id the
// execution is admitted with, that no execution's id is on two check runs, so `check.open` adopted the held one, and
// that a held request release answered with another execution left no check run open.
import {
  ActuatorRateLimitLive,
  CheckRunApplierLive,
  installationQuotaLayer,
} from "@fractalboxdev/flare-dispatch-github";
import { fakeLayers } from "@fractalboxdev/flare-dispatch-github/testing";
import { drainOnce } from "@fractalboxdev/mameko-coordinator";
import { d1OutboxStore } from "@fractalboxdev/mameko-host-cloudflare/d1";
import { Clock, Effect, Layer } from "effect";
import {
  seededRandom,
  throwOnViolations,
  type SimScenario,
  type SimViolation,
} from "../../../ops/src/verification/harness.ts";
import { harness, pullRequestPayload, signedWebhook } from "../../src/harness.test-support.ts";
import { handleIntake } from "../../src/routes.ts";
import { releaseHeld } from "../../src/submit.ts";

const HEADS = ["1", "2", "3"].map((c) => c.repeat(40));
const STEPS = 40;
/** Every check-run kind the profile binds to the check-run applier. */
const CHECK_KINDS = [
  "check.open",
  "check.start",
  "check.progress",
  "check.conclude",
  "check.summary",
  "check.annotations",
];

export interface CooldownCheckOutcome {
  readonly violations: readonly SimViolation[];
  readonly reached: Readonly<Record<string, number>>;
  readonly trace: readonly string[];
}

export const simulateCooldownChecks = async (seed: number): Promise<CooldownCheckOutcome> => {
  const random = seededRandom(seed);
  const violations: SimViolation[] = [];
  const trace: string[] = [];
  const reached: Record<string, number> = { held: 0, adopted: 0, dropped: 0 };
  const h = await harness();
  const drainLayer = Layer.mergeAll(
    d1OutboxStore(h.db),
    CheckRunApplierLive.pipe(Layer.provide(fakeLayers(h.github))),
    ActuatorRateLimitLive.pipe(Layer.provide(installationQuotaLayer())),
  );
  /** Every id a request was held under. */
  const heldIds = new Set<string>();
  const dropped = new Set<string>();
  let deliveries = 0;

  const runsOf = (id: string) => h.github.runs.filter((r) => r.external_id === id);
  const lint = () => h.records().filter((r) => r.run === "lint");

  const check = (step: string) => {
    for (const row of h.rows("select execution_id from intake_held")) {
      const id = row.execution_id as string;
      heldIds.add(id);
      const runs = runsOf(id);
      if (runs.length !== 1 || runs[0]!.status !== "queued")
        violations.push({
          id: "FD-INT-057",
          message: `${step}: held ${id} has ${runs.length} check run(s), status ${runs[0]?.status ?? "none"}`,
        });
      if (h.executions().some((e) => e.id === id))
        violations.push({ id: "FD-INT-057", message: `${step}: held ${id} is admitted` });
    }
    const ids = new Set(h.github.runs.map((r) => r.external_id));
    for (const id of ids)
      if (id !== null && runsOf(id).length > 1)
        violations.push({
          id: "FD-INT-057",
          message: `${step}: ${runsOf(id).length} check runs carry ${id}`,
        });
    for (const id of heldIds) {
      const held = h.rows("select 1 from intake_held where execution_id = ?", id).length > 0;
      const recorded = h.rows("select 1 from intake_records where execution_id = ?", id).length > 0;
      if (held || recorded) continue;
      dropped.add(id);
      if (runsOf(id).some((r) => r.status !== "completed"))
        violations.push({
          id: "FD-INT-057",
          message: `${step}: ${id} was answered by another execution and its check run is still open`,
        });
    }
  };

  const deliver = async () => {
    const head = HEADS[Math.floor(random() * HEADS.length)]!;
    const request = await signedWebhook("pull_request", pullRequestPayload({ head }), {
      delivery: `d-${++deliveries}`,
    });
    await h.run(handleIntake(request, "webhooks/github"));
    await drain();
    trace.push(`deliver ${head.slice(0, 1)} lint=${lint().length}`);
  };

  const drain = async () => {
    const now = await h.run(Clock.currentTimeMillis);
    await h.run(
      drainOnce({
        now,
        token: (id) => `tok-${id}-${now}`,
        random: () => 0,
        actuatorOf: Object.fromEntries(CHECK_KINDS.map((k) => [k, "checkRun"])),
      }).pipe(Effect.provide(drainLayer)),
    );
    trace.push(`drain runs=${h.github.runs.map((r) => `${r.id}:${r.status}`).join(",")}`);
  };

  for (let step = 0; step < STEPS; step++) {
    const r = random();
    if (r < 0.4) await deliver();
    else if (r < 0.65) {
      const ms = 5_000 + Math.floor(random() * 40_000);
      await h.adjust(ms);
      trace.push(`advance ${ms}`);
    } else if (r < 0.8) {
      const report = await h.run(releaseHeld());
      await drain();
      trace.push(`release ${JSON.stringify(report)}`);
    } else if (r < 0.95) await drain();
    else {
      // A pending `lint` finishes, so its class's per-repository queue bound has room again.
      const pending = h.executions().filter((e) => e.run === "lint" && e.status === "pending");
      const done = pending[Math.floor(random() * pending.length)];
      if (done !== undefined)
        h.db.sqlite
          .prepare("update executions set status = 'success' where id = ?")
          .run(done.id as string);
      trace.push(`finish ${done === undefined ? "none" : "one"}`);
    }
    check(`step ${step}`);
  }
  // Every window ends; the last tick releases what is still held and the drain opens every admitted check run.
  await h.adjust(120_000);
  await h.run(releaseHeld());
  await drain();
  check("end");

  const applied = new Set(
    h
      .rows("select execution_id from outbox where kind = 'check.open' and state = 'applied'")
      .map((r) => r.execution_id as string),
  );
  reached.held = heldIds.size;
  reached.adopted = [...heldIds].filter((id) => applied.has(id)).length;
  reached.dropped = dropped.size;
  return { violations, reached, trace };
};

export const scenarios: readonly SimScenario[] = [
  {
    name: "cooldown-check",
    ids: ["FD-INT-057"],
    run: async (seed) => throwOnViolations((await simulateCooldownChecks(seed)).violations),
  },
];
