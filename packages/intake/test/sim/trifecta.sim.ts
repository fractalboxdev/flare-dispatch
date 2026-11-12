// The trifecta rule at admission as a V-SIM scenario (specs/runs/agentic.md § Data classes and the trifecta rule). Each
// seed fixes every draw: whether a pull request comes from a fork, the repository's stated visibility, the author's
// `author_association`, the deployment's confidentiality mode, which delivery GitHub repeats and how far the clock moves
// between deliveries. Every webhook goes through intake's route into mameko's admission on a SQLite D1, for three runs
// whose agent egress differs. After every delivery the scenario checks each run's execution against a model of the
// spec's class table, computed here independently of intake.
// `scenarios` is what the `sim` job runs (packages/ops/scripts/harness.ts): each seed fails on any violation.
import type { ConfidentialityMode } from "@fractalboxdev/flare-dispatch-profile";
import {
  seededRandom,
  throwOnViolations,
  type SimScenario,
  type SimViolation,
} from "../../../ops/src/verification/harness.ts";
import {
  CATALOG,
  harness,
  manifest,
  pullRequestPayload,
  REPO,
  repoWithManifest,
  signedWebhook,
  testRun,
  type Harness,
} from "../../src/harness.test-support.ts";
import { handleIntake } from "../../src/routes.ts";

export interface SimOutcome {
  readonly violations: readonly SimViolation[];
  /** How often each case the scenario exists to reach was reached. */
  readonly reached: Readonly<Record<string, number>>;
  /** Every step, with no execution id in it, so one seed replays to the same trace. */
  readonly trace: readonly string[];
}

const pick = <A>(random: () => number, xs: readonly A[]): A =>
  xs[Math.floor(random() * xs.length)]!;

/**
 * Three runs: `contained` keeps the agent profile's base grants and has a cooldown window, `cloud` adds the `cf-api`
 * grant, and `uncatalogued` adds a grant the grant catalogue does not list.
 */
const RUNS = {
  contained: { agent: [] as string[], cooldown: true },
  cloud: { agent: ["cf-api"], cooldown: false },
  uncatalogued: { agent: ["artifact-store"], cooldown: false },
};
type RunName = keyof typeof RUNS;
const RUN_NAMES = Object.keys(RUNS) as RunName[];

const SIM_CATALOG = {
  ...CATALOG,
  ...Object.fromEntries(
    RUN_NAMES.map((name) => [
      name,
      testRun(name, {
        grants: { setup: [], agent: RUNS[name].agent },
        ...(RUNS[name].cooldown ? { cooldown: { seconds: 120, scope: () => "all" } } : {}),
      }),
    ]),
  ),
};

const SIM_MANIFEST = manifest(RUN_NAMES.map((recipe) => ({ recipe, triggers: ["pull_request"] })));

const ASSOCIATIONS = [
  "OWNER",
  "MEMBER",
  "COLLABORATOR",
  "CONTRIBUTOR",
  "FIRST_TIME_CONTRIBUTOR",
  "NONE",
  undefined,
] as const;
const TRUSTED = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

interface Delivery {
  readonly head: string;
  readonly fork: boolean;
  readonly visibility: boolean | undefined;
  readonly association: string | undefined;
  readonly mode: ConfidentialityMode;
}

const payloadOf = (d: Delivery) => {
  const p = pullRequestPayload({
    head: d.head,
    ...(d.fork ? { headRepo: "mallory/app" } : {}),
  });
  return {
    ...p,
    repository: {
      ...p.repository,
      ...(d.visibility === undefined ? {} : { private: d.visibility }),
    },
    pull_request: {
      ...p.pull_request,
      ...(d.association === undefined ? {} : { author_association: d.association }),
    },
  };
};

/** The spec's class table over one delivery and one run. */
const modelClasses = (d: Delivery, run: RunName) => ({
  privateData: d.visibility !== false || d.mode !== "non-confidential",
  untrustedInput: d.fork || (d.association !== undefined && !TRUSTED.has(d.association)),
  outbound: RUNS[run].agent.length > 0,
});

const deliver = async (h: Harness, payload: unknown, delivery: string) => {
  const r = await h.run(
    handleIntake(await signedWebhook("pull_request", payload, { delivery }), "webhooks/github"),
  );
  if (r === null) throw new Error("the route group served no response");
  return r.status;
};

/** Every record of `run` on `head`, with its execution's status, reason and placement row, when it has one. */
const recordsOf = (h: Harness, run: RunName, head: string) =>
  h.rows(
    `select r.execution_id, r.not_before, e.status, e.reason,
       (select count(*) from placements p where p.execution_id = r.execution_id) as placed
     from intake_records r left join executions e on e.id = r.execution_id
     where r.run = ? and r.sha = ?`,
    run,
    head,
  ) as {
    execution_id: string;
    not_before: number | null;
    status: string | null;
    reason: string | null;
    placed: number;
  }[];

/**
 * Pull request deliveries with seeded facts, each sometimes repeated under the same delivery id. For each run the model
 * computes the three classes from the spec's table. A delivery whose classes are all true must leave that run's request
 * concluded `failure` with `policy: trifecta`, with no placement row, no hold and no workflow start, and a repeated
 * delivery must answer the same execution. Every other request must not carry that reason: it is held for its cooldown
 * window, queued with a placement row, or concluded by placement.
 */
export const simulateTrifecta = async (seed: number): Promise<SimOutcome> => {
  const random = seededRandom(seed);
  const violations: SimViolation[] = [];
  const trace: string[] = [];
  const reached = { refused: 0, refusedSameRepo: 0, admitted: 0, held: 0, repeated: 0 };
  let mode: ConfidentialityMode = "unclassified";
  const h = await harness({
    settings: {
      catalog: (name) => SIM_CATALOG[name as keyof typeof SIM_CATALOG],
      confidentiality: () => mode,
    },
    repos: { [REPO]: repoWithManifest(SIM_MANIFEST) },
  });
  const steps = 12 + Math.floor(random() * 12);
  for (let step = 0; step < steps; step++) {
    mode = pick(random, ["unclassified", "non-confidential"] as const);
    const d: Delivery = {
      head: (step + 1).toString(16).padStart(40, "0"),
      fork: random() < 0.4,
      visibility: pick(random, [true, false, undefined]),
      association: pick(random, ASSOCIATIONS),
      mode,
    };
    const deliveryId = `d-${step}`;
    const repeat = random() < 0.3;
    const started = h.recorded.started.length;
    const statuses = [await deliver(h, payloadOf(d), deliveryId)];
    if (repeat) statuses.push(await deliver(h, payloadOf(d), deliveryId));
    trace.push(
      `step ${step}: fork=${d.fork} private=${String(d.visibility)} association=${String(d.association)} mode=${d.mode} repeat=${repeat} -> ${statuses.join(",")}`,
    );
    const startedIds = new Set(h.recorded.started.slice(started).map((p) => p.executionId));
    for (const run of RUN_NAMES) {
      const classes = modelClasses(d, run);
      const trifecta = classes.privateData && classes.untrustedInput && classes.outbound;
      const records = recordsOf(h, run, d.head);
      const where = `step ${step} ${run} (${JSON.stringify(classes)})`;
      trace.push(
        `  ${run}: ${records.map((r) => `${r.status ?? "held"}:${r.reason ?? "-"}`).join(",") || "none"}`,
      );
      if (records.length !== 1) {
        violations.push({
          id: "FD-AGT-005",
          message: `${where}: ${records.length} records for one request, delivered ${statuses.length} time(s)`,
        });
        continue;
      }
      const r = records[0]!;
      if (trifecta) {
        if (r.status !== "failure" || r.reason !== "policy: trifecta")
          violations.push({
            id: "FD-AGT-005",
            message: `${where}: all three classes are true, but the execution is ${r.status ?? "held"} with ${String(r.reason)}`,
          });
        if (r.placed > 0 || r.not_before !== null || startedIds.has(r.execution_id))
          violations.push({
            id: "FD-AGT-005",
            message: `${where}: a trifecta refusal reached placement (placement row ${r.placed}, hold ${String(r.not_before)}, started ${startedIds.has(r.execution_id)})`,
          });
        reached.refused++;
        if (!d.fork) reached.refusedSameRepo++;
        if (repeat) reached.repeated++;
      } else {
        if (r.reason === "policy: trifecta")
          violations.push({
            id: "FD-AGT-005",
            message: `${where}: refused for the trifecta with a class false`,
          });
        const held = r.status === null && r.not_before !== null;
        const queued = r.status === "pending" && r.placed > 0;
        const unplaced = r.status === "failure" && r.reason === "placement: no eligible executor";
        if (!held && !queued && !unplaced)
          violations.push({
            id: "FD-AGT-005",
            message: `${where}: expected held, queued or unplaced, got ${String(r.status)} with ${String(r.reason)}`,
          });
        if (held) reached.held++;
        if (queued) reached.admitted++;
      }
    }
    await h.adjust(Math.floor(random() * 180_000));
  }
  return { violations, reached, trace };
};

export const scenarios: readonly SimScenario[] = [
  {
    name: "trifecta",
    ids: ["FD-AGT-005"],
    run: async (seed) => throwOnViolations((await simulateTrifecta(seed)).violations),
  },
];
