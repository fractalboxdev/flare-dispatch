// A job matrix parent's children and their check runs as `V-REPLAY` workflows (specs/runs/gate.md FD-GATE-031,
// FD-GATE-046). The `offload-test` parent runs in the `control` pool from the pool's catalogue, over the live
// `MatrixChildren`: each job it starts is admitted through intake's admission under the job's dedup key, with the job's
// check where the matrix sets `checkPerJob`, and the parent waits for the job's terminal row. An executor stand-in ends
// each admitted job once, through its `Execution` workflow's apply-outbox stage. The outbox then drains through the
// check-run applier against a fake GitHub. A second run repeats the parent's lease at the next epoch over the same D1
// and GitHub, as a control-pool object that lost the parent's journal runs it again.
import {
  ActuatorRateLimitLive,
  CheckRunApplierLive,
  installationQuotaLayer,
} from "@fractalboxdev/flare-dispatch-github";
import { fakeGithub, fakeGithubLayers } from "@fractalboxdev/flare-dispatch-github/testing";
import { drainOnce } from "@fractalboxdev/mameko-coordinator";
import { d1OutboxStore } from "@fractalboxdev/mameko-host-cloudflare/d1";
import { Effect, Layer } from "effect";
import type {
  ReplayEffect,
  ReplayWorkflow,
} from "../../../../packages/ops/src/verification/harness.ts";
import { concludeFactsLayer } from "../../src/github.ts";
import type { TestD1 } from "../conclude.test-support.ts";
import {
  admitParent,
  deploy,
  matrixInput,
  runParent,
  SCOPE,
  withExecutor,
  type Deploy,
} from "../control-pool.test-support.ts";

export { JOB_KEYS, PARENT_DEDUP_KEY } from "../control-pool.test-support.ts";

const MINUTE_MS = 60_000;
/** The installation the fake GitHub maps the repository to. */
const INSTALLATIONS = { [SCOPE]: 7 };

/** The deploy, the parent's execution, the fake GitHub and the epoch of the parent's last lease. */
export interface Journal {
  readonly d: Deploy;
  readonly parent: string;
  readonly gh: ReturnType<typeof fakeGithub>;
  epoch: number;
}

/** Every outbox, execution and dedup-key row, keyed by table and id, with its full content. */
const snapshot = (db: TestD1): ReadonlyMap<string, string> =>
  new Map(
    [
      ["outbox", "select * from mameko_outbox", "id"],
      ["executions", "select * from mameko_executions", "id"],
      ["dedup_keys", "select * from mameko_dedup_keys", "sha256"],
    ].flatMap(([table, sql, key]) =>
      (db.sqlite.prepare(sql!).all() as Record<string, unknown>[]).map(
        (r) => [`${table} ${String(r[key!])}`, JSON.stringify(r)] as const,
      ),
    ),
  );

const drainAll = async (j: Journal) => {
  for (let pass = 0; pass < 10; pass++) {
    const now = Date.now() + (pass + 1) * MINUTE_MS;
    await Effect.runPromise(
      drainOnce({
        now,
        token: (id) => `tok-${id}-${now}`,
        random: () => 0,
        actuatorOf: { "check.open": "checkRun", "check.conclude": "checkRun" },
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            d1OutboxStore(j.d.db),
            CheckRunApplierLive.pipe(
              Layer.provide(
                Layer.merge(fakeGithubLayers(j.gh, INSTALLATIONS), concludeFactsLayer(j.d.env)),
              ),
            ),
            ActuatorRateLimitLive.pipe(
              Layer.provide(
                Layer.merge(installationQuotaLayer(), fakeGithubLayers(j.gh, INSTALLATIONS)),
              ),
            ),
          ),
        ),
      ),
    );
    const open = j.d.db.sqlite
      .prepare(
        "select count(*) as n from mameko_outbox where state in ('pending', 'in_flight') and kind like 'check.%'",
      )
      .get() as { n: number };
    if (open.n === 0) return;
  }
};

/** Runs the parent's lease at the journal's next epoch, then drains its children's check rows. */
export const parent =
  (checkPerJob: boolean) =>
  async (journal: Journal | null): Promise<{ journal: Journal; effects: ReplayEffect[] }> => {
    let j: Journal;
    if (journal === null) {
      const d = await deploy();
      const { executionId } = await admitParent(d, matrixInput(checkPerJob));
      j = { d, parent: executionId, gh: fakeGithub(), epoch: 0 };
    } else j = journal;
    j.epoch += 1;
    const calls = j.gh.calls.length;
    const before = snapshot(j.d.db);
    const ended = await withExecutor(j.d, j.parent, runParent(j.d, j.parent, j.epoch));
    if ((ended.result as { _tag?: string })._tag !== "success")
      throw new Error(`parent ended ${JSON.stringify(ended)}`);
    if (checkPerJob) await drainAll(j);
    const after = snapshot(j.d.db);
    const effects: ReplayEffect[] = [
      ...j.gh.calls.slice(calls).map((call): ReplayEffect => ({ kind: "github", key: call })),
      ...[...after]
        .filter(([key, row]) => before.get(key) !== row)
        .map(([key]): ReplayEffect => ({ kind: "d1", key })),
      ...[...after.keys()]
        .filter((key) => key.startsWith("outbox ") && !before.has(key))
        .map((key): ReplayEffect => ({ kind: "intent", key })),
    ];
    return { journal: j, effects };
  };

export const workflows: readonly ReplayWorkflow<Journal>[] = [
  { name: "matrix-job-dedup", ids: ["FD-GATE-031"], run: parent(false) },
  { name: "matrix-job-checks", ids: ["FD-GATE-046"], run: parent(true) },
];
