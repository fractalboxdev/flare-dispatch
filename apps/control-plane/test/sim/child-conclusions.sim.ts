// A fan-out parent's end and its children's check runs as a V-SIM scenario (specs/github-output.md FD-GH-020). A seed
// fixes the number of children, which own a check run, which reach their own outcome before the parent ends and with
// which outcome, when the outbox drains, and the parent's outcome. Every execution lives in mameko's store on a SQLite
// D1 with intake's records beside it; terminal writes run mameko's `applyOutbox` stage, whose parent-ended cascade
// ends every live child, and the drains run the check-run applier against a fake GitHub with the control plane's
// `ConcludeFacts`. After the parent's end, the tick's child-conclusions step runs twice. The scenario then checks that
// each child check run concluded once, with the child's own outcome or `failure` "parent closed before this part
// settled", that a child owning no check run got no `cp:check:conclude` row, and that the second pass inserted none.
import {
  ActuatorRateLimitLive,
  CheckRunApplierLive,
  checkConclusion,
  installationQuotaLayer,
  insertChildConclusions,
  migrateChildConclusions,
  PARENT_CLOSED,
  verdictOf,
  type Verdict,
} from "@fractalboxdev/flare-dispatch-github";
import { fakeGithub, fakeGithubLayers } from "@fractalboxdev/flare-dispatch-github/testing";
import { d1IntakeStore, IntakeStore } from "@fractalboxdev/flare-dispatch-intake";
import { migratedD1 } from "@fractalboxdev/flare-dispatch-intake/testing";
import { buildProfile } from "@fractalboxdev/flare-dispatch-profile";
import {
  drainOnce,
  ExecutionSteps,
  type ExecutionOutcome,
} from "@fractalboxdev/mameko-coordinator";
import { d1OutboxStore, insertOutboxRows } from "@fractalboxdev/mameko-host-cloudflare/d1";
import { d1ExecutionSteps } from "@fractalboxdev/mameko-host-cloudflare/d1-execution";
import { newRow } from "@fractalboxdev/mameko-kernel";
import { Effect, Layer } from "effect";
import {
  seededRandom,
  throwOnViolations,
  type SimScenario,
  type SimViolation,
} from "../../../../packages/ops/src/verification/harness.ts";
import { concludeKindOf, executionConfig } from "../../src/config.ts";
import { concludeFactsLayer } from "../../src/github.ts";

import { envOf, NOW, record, type TestD1 } from "../conclude.test-support.ts";

export const PARENT = "parent";
const RUN = "offload-test";
const SHA = "b".repeat(40);
export const profile = buildProfile("production");

/** The outcomes a child reaches on its own before the parent ends. */
const OWN_OUTCOMES: readonly ExecutionOutcome[] = [
  { _tag: "Success", epoch: 1 },
  { _tag: "Failure", reason: "lint: 3 errors", epoch: 1 },
  { _tag: "Failure", reason: "capacity: no executor", epoch: null },
  { _tag: "Skipped", detail: "nothing-to-lint", epoch: 1 },
  { _tag: "Cancelled", cause: "superseded" },
];

const PARENT_OUTCOMES: readonly ExecutionOutcome[] = [
  { _tag: "Success", epoch: 1 },
  { _tag: "Failure", reason: "jobs: j1", epoch: 1 },
  { _tag: "Cancelled", cause: "operator-cancel" },
];

export interface ChildConclusionsOutcome {
  readonly violations: readonly SimViolation[];
  readonly reached: Readonly<Record<string, number>>;
  readonly trace: readonly string[];
}

export const terminalWrite = (db: TestD1, executionId: string, outcome: ExecutionOutcome) =>
  Effect.runPromise(
    ExecutionSteps.use((steps) => steps.applyOutbox(executionId, outcome, null)).pipe(
      Effect.provide(
        d1ExecutionSteps(db, { ...executionConfig(profile), meteredCost: () => Effect.succeed(0) }),
      ),
    ),
  );

export const drain = (db: TestD1, gh: ReturnType<typeof fakeGithub>, now: number) =>
  Effect.runPromise(
    drainOnce({
      now,
      token: (id) => `tok-${id}-${now}`,
      random: () => 0,
      actuatorOf: { "check.open": "checkRun", "check.conclude": "checkRun" },
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          d1OutboxStore(db),
          CheckRunApplierLive.pipe(
            Layer.provide(Layer.merge(fakeGithubLayers(gh), concludeFactsLayer(envOf(db)))),
          ),
          ActuatorRateLimitLive.pipe(
            Layer.provide(Layer.merge(installationQuotaLayer(), fakeGithubLayers(gh))),
          ),
        ),
      ),
    ),
  );

/** One admitted execution: its intake record and mameko's execution row, under the parent for a child. */
export const seed = async (db: TestD1, id: string, label: string, parent: string | null) => {
  await Effect.runPromise(
    IntakeStore.use((s) => s.put(record(id, { run: RUN, label, sha: SHA }))).pipe(
      Effect.provide(d1IntakeStore(db)),
    ),
  );
  db.sqlite
    .prepare(
      `insert into executions (id, scope_id, run, class, status, enqueued_at, parent_id)
       values (?, 'acme/app', ?, 'required', 'running', ?, ?)`,
    )
    .run(id, RUN, NOW, parent);
};

/** The `cp:check:open` row admission inserts for an execution that owns a check run (FD-GH-005). */
export const openCheck = async (db: TestD1, id: string, label: string, now: number) => {
  const payload = { name: `flare-dispatch/${RUN}:${label}`, head_sha: SHA };
  await insertOutboxRows(db, [
    {
      id: `${id}:cp:check:open`,
      limitKey: "acme/app",
      tier: "effect",
      priority: 0,
      classRank: 1,
      drawsReserve: false,
      intent: {
        executionId: id,
        scopeId: "acme/app",
        intentKey: "cp:check:open",
        kind: "check.open",
        payload,
        payloadDigest: JSON.stringify(payload),
        effectClass: "adoptable",
        attempts: 0,
      },
      row: newRow({ effectClass: "adoptable", insertedAt: now }),
    },
  ]);
};

export const simulateChildConclusions = async (
  seedValue: number,
): Promise<ChildConclusionsOutcome> => {
  const random = seededRandom(seedValue);
  const pick = <A>(xs: readonly A[]): A => xs[Math.floor(random() * xs.length)]!;
  const violations: SimViolation[] = [];
  const trace: string[] = [];
  const reached: Record<string, number> = {
    ownOutcome: 0,
    parentClosed: 0,
    concludedFirst: 0,
    cascadeDrainedFirst: 0,
    noCheck: 0,
  };
  const db = await migratedD1();
  await Effect.runPromise(migrateChildConclusions(db));
  const gh = fakeGithub();
  // The terminal writes stamp rows with the store's clock, so every drain and pass runs after them.
  let clock = Date.now() + 1_000;
  const drainAll = async () => {
    for (let pass = 0; pass < 20; pass++) {
      clock += 60_000;
      await drain(db, gh, clock);
      const open = db.sqlite
        .prepare("select count(*) as n from outbox where state in ('pending', 'in_flight')")
        .get() as { n: number };
      if (open.n === 0) return;
    }
  };

  await seed(db, PARENT, "matrix", null);
  const count = 2 + Math.floor(random() * 8);
  /** Each child: whether it owns a check run, and the verdict it settled on its own before the parent ended. */
  const children: { id: string; owns: boolean; own: Verdict | null }[] = [];
  for (let i = 1; i <= count; i++) {
    const id = `child-${i}`;
    const owns = random() < 0.8;
    await seed(db, id, `j${i}`, PARENT);
    if (owns) await openCheck(db, id, `j${i}`, clock);
    children.push({ id, owns, own: null });
  }
  for (const child of children) {
    if (random() < 0.5) {
      const outcome = pick(OWN_OUTCOMES);
      await terminalWrite(db, child.id, outcome);
      child.own = verdictOf(outcome);
      trace.push(`${child.id}${child.owns ? "" : " (no check)"} ${outcome._tag}`);
    } else trace.push(`${child.id}${child.owns ? "" : " (no check)"} live`);
    if (random() < 0.3) {
      trace.push("drain");
      await drainAll();
    }
  }
  const parentOutcome = pick(PARENT_OUTCOMES);
  await terminalWrite(db, PARENT, parentOutcome);
  trace.push(`parent ${parentOutcome._tag}`);
  const cascadeFirst = random() < 0.5;
  if (cascadeFirst) {
    trace.push("drain");
    await drainAll();
  }

  // The check runs that concluded before the pass: on their own before the parent ended, or from a drained cascade row.
  const concludedFirst = new Set(
    (
      db.sqlite
        .prepare(
          "select execution_id from outbox where kind = 'check.conclude' and state = 'applied'",
        )
        .all() as { execution_id: string }[]
    ).map((r) => r.execution_id),
  );

  const kind = concludeKindOf(profile);
  clock += 1_000;
  const first = await Effect.runPromise(insertChildConclusions(db, kind, clock));
  const second = await Effect.runPromise(insertChildConclusions(db, kind, clock + 60_000));
  trace.push(`inserted ${first.join(",")}`);
  if (second.length > 0)
    violations.push({
      id: "FD-GH-020",
      message: `a second pass inserted conclusions for ${second.join(",")}`,
    });
  await drainAll();

  const cpRows = new Set(
    (
      db.sqlite
        .prepare("select execution_id from outbox where intent_key = 'cp:check:conclude'")
        .all() as { execution_id: string }[]
    ).map((r) => r.execution_id),
  );
  for (const child of children) {
    if (!child.owns) {
      reached.noCheck!++;
      if (cpRows.has(child.id))
        violations.push({
          id: "FD-GH-020",
          message: `${child.id} owns no check run and got a cp:check:conclude row`,
        });
      continue;
    }
    if (!concludedFirst.has(child.id) && !cpRows.has(child.id))
      violations.push({
        id: "FD-GH-020",
        message: `${child.id}'s check run was open at the pass and got no cp:check:conclude row`,
      });
    const expected = checkConclusion(child.own ?? PARENT_CLOSED);
    const runs = gh.runs.filter((r) => r.external_id === child.id);
    if (
      runs.length !== 1 ||
      runs[0]!.status !== "completed" ||
      runs[0]!.conclusion !== expected.conclusion ||
      runs[0]!.output.title !== expected.title
    )
      violations.push({
        id: "FD-GH-020",
        message: `${child.id} ended with ${JSON.stringify(runs.map((r) => [r.status, r.conclusion, r.output.title]))}, not ${expected.conclusion} "${expected.title}"`,
      });
    if (concludedFirst.has(child.id)) reached.concludedFirst!++;
    else if (child.own === null) reached.parentClosed!++;
    else reached.ownOutcome!++;
    if (cascadeFirst && child.own === null) reached.cascadeDrainedFirst!++;
  }
  return { violations, reached, trace };
};

export const scenarios: readonly SimScenario[] = [
  {
    name: "child-conclusions",
    ids: ["FD-GH-020"],
    run: async (seedValue) =>
      throwOnViolations((await simulateChildConclusions(seedValue)).violations),
  },
];
