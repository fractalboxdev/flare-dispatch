// The burn lanes the coordinator reads as a V-SIM scenario (specs/profile.md § Spend configuration, FD-PROF-058;
// mameko MAMEKO-SPD-048, MAMEKO-SPD-050). A seed fixes the deployment, the spend values the overlay's `SPEND` var
// delivers (any subset, the rest at their defaults), a fleet of device executors, how many executions of each class
// each one holds leased, and the hold each leased execution reserves. Every row lives in mameko's store on a SQLite D1,
// and the scenario reads the control plane's spend view, mameko's view over the deployment's profile and spend
// settings. It checks that every class of the catalogue reads its FD-PROF-058 lane, 0.41 USD per hour for `batch`,
// 0.81 for `interactive`, 2.01 for `required` and 2.82 for `release`, whatever the overlay, the fleet and the holds,
// and that the list rate admitted against each lane, the class's and every lower class's together, stays within it.
// `scenarios` is what the `sim` job runs (packages/ops/scripts/harness.ts): each seed fails on any violation.
import { migratedD1 } from "@fractalboxdev/flare-dispatch-intake/testing";
import { SpendView, utcMonth, type SpendViewBody } from "@fractalboxdev/flare-dispatch-ops";
import { Effect } from "effect";
import {
  seededRandom,
  throwOnViolations,
  type SimScenario,
  type SimViolation,
} from "../../../../packages/ops/src/verification/harness.ts";
import { profileOf } from "../../src/config.ts";
import { spendViewOf } from "../../src/spend.ts";
import { envOf } from "../conclude.test-support.ts";

export const SCENARIO = "burn-lanes";

/** FD-PROF-058's lanes in USD per hour. */
const LANES_USD_PER_HOUR: Readonly<Record<string, number>> = {
  batch: 0.41,
  interactive: 0.81,
  required: 2.01,
  release: 2.82,
};
const MICRO = 1_000_000;

export interface LanesOutcome {
  readonly violations: readonly SimViolation[];
  readonly reached: Readonly<Record<string, number>>;
  readonly trace: readonly string[];
}

/** A subset of the overlay's spend values; reserves stay inside the budget so the configuration validates. */
const spendValues = (random: () => number): Record<string, number> | undefined => {
  if (random() < 0.2) return undefined;
  const int = (lo: number, hi: number) => lo + Math.floor(random() * (hi - lo + 1));
  const budget = int(60, 400);
  const all: Record<string, number> = {
    budgetUsd: budget,
    fixedUsd: int(0, 5),
    releaseReserveUsd: int(0, 15),
    opsReserveUsd: int(0, 5),
    measuredReserveMinUsd: int(0, 25),
    measuredReserveDays: int(1, 30),
    overheadFactor: 1 + Math.floor(random() * 50) / 100,
  };
  return Object.fromEntries(
    Object.entries(all).filter(([k]) => k === "budgetUsd" || random() < 0.5),
  );
};

export const simulateLanes = async (seed: number): Promise<LanesOutcome> => {
  const random = seededRandom(seed);
  const int = (n: number) => Math.floor(random() * n);
  const violations: SimViolation[] = [];
  const reached: Record<string, number> = {};
  const trace: string[] = [];
  const reach = (k: string) => (reached[k] = (reached[k] ?? 0) + 1);
  const v = (message: string) => violations.push({ id: "FD-PROF-058", message });

  const deployment = random() < 0.5 ? "production" : "development";
  const spend = spendValues(random);
  const db = await migratedD1();
  const env = envOf(db, {
    DEPLOYMENT: deployment,
    ...(spend === undefined ? {} : { SPEND: JSON.stringify(spend) }),
  });
  /** The catalogue's classes, highest first: rank 0 is the highest. */
  const classes = [...profileOf(env).classes].sort((a, b) => a.rank - b.rank).map((c) => c.name);
  const now = Date.now();

  // The fleet: device executors, each holding leased executions of random classes, each with a held reservation.
  const executors = 1 + int(5);
  let n = 0;
  for (let x = 0; x < executors; x++) {
    const id = `dev-${x + 1}`;
    db.sqlite
      .prepare(
        `insert into mameko_executors (executor_id, kind, posture_tier, labels_json, slots_json, last_heartbeat_at, drain, quarantine)
         values (?, 'device', 'unmanaged', '[]', '{}', ?, 0, 0)`,
      )
      .run(id, now);
    for (const cls of classes) {
      const leased = int(4);
      for (let i = 0; i < leased; i++) {
        const executionId = `exec-${seed}-${++n}`;
        // A random run length so far, which no lane depends on.
        const startedAt = now - int(3_600_000);
        db.sqlite
          .prepare(
            `insert into mameko_executions (id, scope_id, run, class, status, enqueued_at) values (?, 'acme/app', 'check', ?, 'running', ?)`,
          )
          .run(executionId, cls, startedAt);
        db.sqlite
          .prepare(
            "insert into mameko_placements (execution_id, state, epoch, executor_id) values (?, 'leased', 1, ?)",
          )
          .run(executionId, id);
        db.sqlite
          .prepare(
            `insert into mameko_reservations (execution_id, class, hold_micro_usd, state, updated_at) values (?, ?, ?, 'held', ?)`,
          )
          .run(executionId, cls, int(5_000_000), now);
      }
    }
  }
  trace.push(`${deployment} ${JSON.stringify(spend)} ${executors} executor(s), ${n} leased`);

  const body: SpendViewBody = await Effect.runPromise(
    SpendView.use((view) => view.view(utcMonth(now))).pipe(Effect.provide(spendViewOf(env))),
  );
  const byClass = new Map(body.classes.map((c) => [c.class, c]));
  for (const cls of classes) {
    const row = byClass.get(cls);
    const usd = LANES_USD_PER_HOUR[cls];
    if (usd === undefined) {
      v(`class ${cls} has no FD-PROF-058 lane`);
      continue;
    }
    if (row?.lane !== Math.round(usd * MICRO))
      v(`class ${cls} reads lane ${row?.lane} micro-USD per hour, not ${usd} USD per hour`);
  }
  for (const cls of Object.keys(LANES_USD_PER_HOUR))
    if (!classes.includes(cls)) v(`the ${deployment} catalogue has no class ${cls}`);

  // MAMEKO-SPD-048: the list rate admitted for a class and every lower class together stays within the class's lane.
  classes.forEach((cls, i) => {
    const admitted = classes
      .slice(i)
      .reduce((sum, c) => sum + (byClass.get(c)?.admitted_list_rate ?? 0), 0);
    const lane = byClass.get(cls)?.lane;
    if (lane === null || lane === undefined || admitted > lane)
      v(`class ${cls} and the classes below it admit ${admitted} against lane ${lane}`);
  });
  trace.push(body.classes.map((c) => `${c.class}:${c.lane}/${c.admitted_list_rate}`).join(" "));
  reach(spend === undefined ? "defaults" : "overlay");
  if (n > 0) reach("leased");
  return { violations, reached, trace };
};

export const scenarios: readonly SimScenario[] = [
  {
    name: SCENARIO,
    ids: ["FD-PROF-058"],
    run: async (seed) => throwOnViolations((await simulateLanes(seed)).violations),
  },
];
