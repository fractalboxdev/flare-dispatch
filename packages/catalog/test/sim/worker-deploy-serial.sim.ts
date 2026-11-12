// The `worker-deploy` serial group's V-SIM scenario (specs/runs/gate.md § `worker-deploy`). A seed fixes a run of
// pushes to one deploy branch, branch-head moves no deploy follows, lease grants, reclaims and deploy ends. Each push's
// deploy request goes through intake's submit into mameko's admission on a SQLite D1, which joins it to the serial
// group intake names; each grant runs the `worker-deploy` recipe against the branch head at that moment, and the
// recipe's outcome ends the execution through mameko's stage work. After every step the scenario checks that one
// target holds at most one leased member, and that a deploy command ran only on the branch head.
import { buildProfile, type Profile } from "@fractalboxdev/flare-dispatch-profile";
import { ExecutionSteps } from "@fractalboxdev/mameko-coordinator";
import { d1PlacementStore } from "@fractalboxdev/mameko-host-cloudflare/d1";
import { d1ExecutionSteps } from "@fractalboxdev/mameko-host-cloudflare/d1-execution";
import { PlacementStore } from "@fractalboxdev/mameko-ports";
import { Effect, Layer, ManagedRuntime, Match } from "effect";
import { TestClock } from "effect/testing";
import {
  catalogRuns,
  d1Admission,
  d1IntakeStore,
  d1ShedRecorder,
  IntakeConfig,
  submission,
  submit,
} from "../../../intake/src/index.ts";
import { migratedD1, recordingHeldChecks, recordingResolver } from "../../../intake/src/testing.ts";
import {
  seededRandom,
  throwOnViolations,
  type SimScenario,
  type SimViolation,
} from "../../../ops/src/verification/harness.ts";
import {
  fakeArtifacts,
  fakeExec,
  fakeGithub,
  fakeIntents,
  memoryLedger,
} from "../../src/gate.test-support.ts";
import type { WorkerDeployInput } from "../../src/inputs.ts";
import type { Outcome } from "../../src/reasons.ts";
import { workerDeploySerialGroup } from "../../src/triggers.ts";
import { runWorkerDeploy } from "../../src/worker-deploy.ts";

const REPO = "acme/app";
const BRANCH = "main";
const COMMAND = "pnpm wrangler deploy";
export const GROUP = workerDeploySerialGroup(REPO, BRANCH);

export interface SerialOutcome {
  readonly violations: readonly SimViolation[];
  readonly reached: Readonly<Record<string, number>>;
  readonly trace: readonly string[];
}

/** The stage configuration with no hold terms, as the control plane's device executions take it. */
const stageConfig = (profile: Profile) => ({
  classes: Object.fromEntries(
    profile.classes.map((c) => [
      c.name,
      {
        rank: c.rank,
        guaranteed: c.guaranteed,
        rateMicroUsdPerS: 0,
        settleMarginS: 0,
        modelAllowanceMicroUsd: 0,
        networkEstimateMicroUsd: 0,
      },
    ]),
  ),
  outcomeKind: profile.outcome_mapping.surface_kind,
  outcomeEffectClass: "adoptable" as const,
  meteredCost: () => Effect.succeed(null),
});

/** The recipe's verdict as the execution's outcome in the epoch that recorded it. */
const executionOutcome = (o: Outcome, epoch: number) =>
  Match.value(o).pipe(
    Match.tag("success", () => ({ _tag: "Success", epoch }) as const),
    Match.tag("cancelled", ({ cause }) => ({ _tag: "Cancelled", cause }) as const),
    Match.tag("failure", ({ reason }) => ({ _tag: "Failure", reason, epoch }) as const),
    Match.tag("skipped", ({ detail }) => ({ _tag: "Skipped", detail, epoch }) as const),
    Match.exhaustive,
  );

export const simulateSerialDeploys = async (seed: number): Promise<SerialOutcome> => {
  const random = seededRandom(seed);
  const violations: SimViolation[] = [];
  const trace: string[] = [];
  const reached: Record<string, number> = {
    deployed: 0,
    headMoved: 0,
    waiterRefused: 0,
    superseded: 0,
    reclaimed: 0,
  };
  const db = await migratedD1();
  const profile = buildProfile("development");
  const run = catalogRuns("development")("worker-deploy")!;
  const layer = Layer.mergeAll(
    Layer.succeed(IntakeConfig, {
      catalog: catalogRuns("development"),
      profile,
      appId: 1,
      webhookSecret: undefined,
      webhookEvents: undefined,
      writeCredentialIn: () => null,
      allows: () => true,
      confidentiality: () => "unclassified",
    }),
    d1Admission(db, profile),
    d1IntakeStore(db),
    d1ShedRecorder(db),
    recordingHeldChecks(),
    recordingResolver(),
    d1PlacementStore(db),
    d1ExecutionSteps(db, stageConfig(profile)),
  ).pipe(Layer.provideMerge(TestClock.layer()));
  const runtime = ManagedRuntime.make(layer);
  const go = <A, E>(effect: Effect.Effect<A, E, Layer.Success<typeof layer>>) =>
    runtime.runPromise(effect);
  const rows = (sql: string, ...params: unknown[]) =>
    db.sqlite.prepare(sql).all(...(params as never[])) as Record<string, unknown>[];

  let head = "0".repeat(40);
  let commits = 0;
  /** Each admitted deploy's commit, by execution id. */
  const shaOf = new Map<string, string>();
  /** A member by its commit's push number, which a seed fixes where the execution id does not. */
  const commitOf = (id: string) => Number(shaOf.get(id));
  /** The members holding a granted lease, by execution id: the commit their deploy command ran on. */
  const leased = new Map<string, { readonly sha: string; readonly epoch: number }>();

  const live = () =>
    rows(
      `select e.id, p.state, p.epoch from executions e join placements p on p.execution_id = e.id
       where e.serial_key = ? and e.status in ('pending', 'running') order by e.enqueued_at`,
      GROUP,
    ) as { id: string; state: string; epoch: number }[];

  const checkSerial = (step: string) => {
    const holders = rows(
      `select count(*) as n from executions e join placements p on p.execution_id = e.id
       where e.serial_key = ? and p.state = 'leased'`,
      GROUP,
    )[0]!.n as number;
    if (holders > 1 || leased.size > 1)
      violations.push({
        id: "FD-GATE-063",
        message: `${step}: ${holders} leased members of ${GROUP} (${leased.size} granted)`,
      });
  };

  /** One push to the deploy branch: the head moves, and when `deploys` its deploy request goes through intake. */
  const push = async (deploys: boolean) => {
    head = String(++commits).padStart(40, "0");
    await go(TestClock.adjust(1_000));
    if (!deploys) {
      trace.push(`move ${commits}`);
      return;
    }
    const inputs: WorkerDeployInput = {
      repo: `https://github.com/${REPO}.git`,
      sha: head,
      ref: `refs/heads/${BRANCH}`,
      scope: REPO,
      branch: BRANCH,
      entry: { command: COMMAND },
    };
    const admitted = await go(
      submit(
        submission({
          run,
          trigger: "webhook",
          event: "push",
          repo: REPO,
          sha: head,
          ref: inputs.ref,
          inputs,
        }),
      ),
    );
    shaOf.set(admitted.executionId, head);
    const key = rows("select serial_key from executions where id = ?", admitted.executionId)[0]!
      .serial_key;
    if (key !== GROUP)
      violations.push({
        id: "FD-GATE-063",
        message: `push ${commits} joined ${String(key)}, not ${GROUP}`,
      });
    trace.push(`push ${commits}`);
  };

  /** A grant to one queued member; a granted member runs the recipe against the branch head now. */
  const grant = async () => {
    const queued = live().filter((m) => m.state === "queued");
    if (queued.length === 0) return;
    const pick = queued[Math.floor(random() * queued.length)]!;
    const placement = await go(
      PlacementStore.use((p) =>
        p.claim(pick.id, {
          expectedEpoch: pick.epoch,
          executorId: "cloud-1",
          floor: 0,
        }),
      ),
    );
    if (placement === null) {
      reached.waiterRefused!++;
      trace.push(`refuse ${commitOf(pick.id)}`);
      return;
    }
    const sha = shaOf.get(pick.id)!;
    leased.set(pick.id, { sha, epoch: placement.epoch });
    checkSerial(`grant ${commitOf(pick.id)}`);
    const exec = fakeExec();
    const outcome = await Effect.runPromise(
      runWorkerDeploy({
        repo: `https://github.com/${REPO}.git`,
        sha,
        ref: `refs/heads/${BRANCH}`,
        scope: REPO,
        branch: BRANCH,
        entry: { command: COMMAND },
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            exec.layer,
            fakeArtifacts().layer,
            fakeIntents().layer,
            fakeGithub({ head }).layer,
            memoryLedger(),
          ),
        ),
      ),
    );
    const deployed = exec.ran.some((r) => r.command === COMMAND);
    if (deployed && sha !== head)
      violations.push({
        id: "FD-GATE-065",
        message: `deploy of ${sha.slice(-4)} ran while the head is ${head.slice(-4)}`,
      });
    if (sha !== head) {
      reached.headMoved!++;
      if (outcome._tag !== "cancelled" || outcome.cause !== "superseded: branch head moved")
        violations.push({
          id: "FD-GATE-065",
          message: `a stale grant of ${sha.slice(-4)} ended ${JSON.stringify(outcome)}`,
        });
      await end(pick.id, outcome);
      return;
    }
    reached.deployed!++;
    trace.push(`deploy ${sha.slice(-4)}`);
  };

  /** The execution ends with the recipe's outcome, which releases the serial group. */
  const end = async (id: string, outcome: Outcome) => {
    const epoch = leased.get(id)?.epoch ?? 1;
    await go(ExecutionSteps.use((s) => s.applyOutbox(id, executionOutcome(outcome, epoch), null)));
    leased.delete(id);
    trace.push(`end ${commitOf(id)} ${outcome._tag}`);
  };

  /** The holder's lease lapses: its placement is queued again under the next epoch, and the group stays its own. */
  const reclaim = () => {
    const holder = [...leased.keys()][0];
    if (holder === undefined) return;
    rows(
      "update placements set state = 'queued', epoch = epoch + 1 where execution_id = ?",
      holder,
    );
    leased.delete(holder);
    reached.reclaimed!++;
    trace.push(`reclaim ${commitOf(holder)}`);
  };

  try {
    const steps = 20 + Math.floor(random() * 30);
    for (let i = 0; i < steps; i++) {
      const draw = random();
      if (draw < 0.3) await push(true);
      else if (draw < 0.38) await push(false);
      else if (draw < 0.75) await grant();
      else if (draw < 0.85) reclaim();
      else {
        const holder = [...leased.keys()][0];
        if (holder !== undefined) await end(holder, { _tag: "success" });
      }
      checkSerial(`step ${i}`);
    }
    // A newer push cancels the older waiters of the group, never its holder (MAMEKO-ADM-073).
    reached.superseded = rows(
      "select count(*) as n from executions where serial_key = ? and reason = 'superseded'",
      GROUP,
    )[0]!.n as number;
  } finally {
    await runtime.dispose();
  }
  return { violations, reached, trace };
};

export const scenarios: readonly SimScenario[] = [
  {
    name: "worker-deploy-serial",
    ids: ["FD-GATE-063", "FD-GATE-065"],
    run: async (seed) => throwOnViolations((await simulateSerialDeploys(seed)).violations),
  },
];
