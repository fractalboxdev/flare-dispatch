// The `offload-test` job matrix parent in the `control` pool (specs/runs/gate.md § Job matrix): admitted through intake,
// claimed by the `control` pool alone, and run from the pool's catalogue over the live `MatrixChildren`, which admits
// each job as a child execution through intake's admission and waits for its terminal row in mameko's store.
import {
  ExecutionLease,
  expandMatrix,
  Outcome,
  runMatrix,
} from "@fractalboxdev/flare-dispatch-catalog";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { controlRunServices } from "../src/control-pool.ts";
import {
  admitParent,
  childrenOf,
  claimedBy,
  deploy,
  endChild,
  JOB_KEYS,
  matrixInput,
  PARENT_DEDUP_KEY,
  runParent,
  SHA,
  withExecutor,
} from "./control-pool.test-support.ts";

const outboxOf = (d: Awaited<ReturnType<typeof deploy>>, parentId: string, kind: string) =>
  d.db.sqlite
    .prepare(
      `select r.label as key, o.payload_json from mameko_outbox o
       join mameko_executions e on e.id = o.execution_id join intake_records r on r.execution_id = e.id
       where e.parent_id = ? and o.kind = ? order by r.label`,
    )
    .all(parentId, kind) as { key: string; payload_json: string }[];

describe("an offload-test parent in the control pool", () => {
  it("[FD-GATE-030] [FD-GATE-031] [FD-GATE-046] admits each job as a child execution under <parent dedup key>/<job key> with its job check, and concludes from the jobs' outcomes", async () => {
    const d = await deploy();
    const { executionId: parent } = await admitParent(d, matrixInput(true));
    // Only the `control` pool claims the parent: it requires no job sandbox and is pinned to that pool.
    expect(await claimedBy(d.db, parent, "agent")).toBe(false);
    expect(await claimedBy(d.db, parent, "control")).toBe(true);

    const ended = await withExecutor(d, parent, runParent(d, parent, 1));
    expect(ended).toEqual({ result: { _tag: "success" }, intents: [] });

    const children = childrenOf(d.db, parent);
    expect(children.map((c) => [c.key, c.canonical, c.status])).toEqual(
      JOB_KEYS.map((k) => [k, `${PARENT_DEDUP_KEY}/${k}`, "success"]),
    );
    // Each child is a `gate-job` execution of its own, at the parent's class, with its own placement.
    expect(
      d.db.sqlite
        .prepare(
          "select e.run, e.class, count(p.execution_id) as placements from mameko_executions e join mameko_placements p on p.execution_id = e.id where e.parent_id = ? group by e.id",
        )
        .all(parent),
    ).toEqual(JOB_KEYS.map(() => ({ run: "gate-job", class: "required", placements: 1 })));
    // Admission opened each job's check `flare-dispatch/offload-test:<job key>`, and the terminal write concludes it.
    expect(outboxOf(d, parent, "check.open")).toEqual(
      JOB_KEYS.map((k) => ({
        key: k,
        payload_json: JSON.stringify({ name: `flare-dispatch/offload-test:${k}`, head_sha: SHA }),
      })),
    );
    expect(outboxOf(d, parent, "check.conclude").map((r) => r.key)).toEqual([...JOB_KEYS]);
  });

  it("[FD-GATE-041] a job that fails lists its key in the parent's verdict, and the job that needs it does not start", async () => {
    const d = await deploy();
    const { executionId: parent } = await admitParent(d, matrixInput(false));
    const ended = await withExecutor(d, parent, runParent(d, parent, 1), (key) =>
      key === "build"
        ? { _tag: "Failure", reason: "exit: 1", epoch: 1 }
        : { _tag: "Success", epoch: 1 },
    );
    expect(ended.result).toEqual({ _tag: "failure", reason: "jobs: build, e2e-1, e2e-2" });
    expect(childrenOf(d.db, parent).map((c) => [c.key, c.status])).toEqual([["build", "failure"]]);
  });

  it("[FD-GATE-031] a replay of the parent admits no second child and concludes as the first run did", async () => {
    const d = await deploy();
    const { executionId: parent } = await admitParent(d, matrixInput(true));
    await withExecutor(d, parent, runParent(d, parent, 1));
    const first = childrenOf(d.db, parent);
    const rows = () =>
      d.db.sqlite.prepare("select count(*) as n from mameko_executions").get() as { n: number };
    const before = rows();

    // The object that lost the parent's journal runs the parent again at its next epoch.
    const replayed = await runParent(d, parent, 2);
    expect(replayed).toEqual({ result: { _tag: "success" }, intents: [] });
    expect(childrenOf(d.db, parent)).toEqual(first);
    expect(rows()).toEqual(before);
    expect(
      d.db.sqlite.prepare("select count(*) as n from intake_records where label is not null").get(),
    ).toEqual({ n: JOB_KEYS.length });
  });

  it("[FD-GATE-010] a job that ends with an infrastructure error after its class's retries makes the parent record failure with infra: <error tag>", async () => {
    const d = await deploy();
    const input = matrixInput(false);
    const { executionId: parent } = await admitParent(d, input);
    const expanded = expandMatrix([{ key: "build", command: "pnpm build" }], "push-default");
    if ("failure" in expanded) throw new Error("the matrix does not expand");
    const services = controlRunServices(d.env, d.isolate, { pollMs: 5 }).pipe(
      Layer.provide(
        Layer.succeed(ExecutionLease, {
          executionId: parent,
          epoch: 1,
          run: "offload-test",
          input,
        }),
      ),
    );
    const matrix = Effect.runPromise(
      runMatrix({
        run: "offload-test",
        parentDedupKey: PARENT_DEDUP_KEY,
        ctx: { repo: input.repo, sha: SHA, ref: input.ref, scope: input.scope! },
        jobs: expanded.jobs,
        window: 1,
        failFast: false,
        checkPerJob: false,
      }).pipe(Effect.provide(services)) as Effect.Effect<
        Effect.Success<ReturnType<typeof runMatrix>>,
        unknown
      >,
    );
    let settled = false;
    void matrix.finally(() => void (settled = true));
    const child = async () => {
      for (;;) {
        const [row] = childrenOf(d.db, parent);
        if (row !== undefined) return row;
        await new Promise((r) => setTimeout(r, 5));
      }
    };
    const job = await child();
    // The first lease ends `infra: ExecFailed` and the control plane requeues the job under the class's retry bound
    // (MAMEKO-ADM-083): the row stays live, so the parent keeps waiting.
    d.db.sqlite
      .prepare("update mameko_placements set state = 'queued', epoch = 2 where execution_id = ?")
      .run(job.id);
    await new Promise((r) => setTimeout(r, 50));
    expect(settled).toBe(false);
    // The retry's lease ends `infra: ExecFailed` too, with no retry left: the terminal write records it.
    await endChild(d.db, job.id, { _tag: "Failure", reason: "infra: ExecFailed", epoch: 2 });
    const { outcome, states } = await matrix;
    expect(states.get("build")).toEqual({
      _tag: "Done",
      outcome: Outcome.failure("infra: ExecFailed"),
    });
    expect(outcome).toEqual(Outcome.failure("jobs: build"));
    expect(childrenOf(d.db, parent).map((c) => [c.key, c.status, c.reason])).toEqual([
      ["build", "failure", "infra: ExecFailed"],
    ]);
  });
});
