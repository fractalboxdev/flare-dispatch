// A job matrix parent run twice over one journal (matrix-jobs.replay.ts): the replayed parent admits no second job,
// opens and concludes no second check run, and makes no GitHub call, D1 write or intent the first run did not.
import { describe, expect, it } from "vitest";
import {
  runReplays,
  type ReplayEffect,
  type ReplayWorkflow,
} from "../../../../packages/ops/src/verification/harness.ts";
import { JOB_KEYS, PARENT_DEDUP_KEY, workflows, type Journal } from "./matrix-jobs.replay.ts";

const replayed = async (workflow: ReplayWorkflow<Journal>) => {
  const runs: { journal: Journal; effects: readonly ReplayEffect[] }[] = [];
  const extras = await runReplays([
    {
      ...workflow,
      run: async (journal) => {
        const out = await workflow.run(journal as Journal | null);
        runs.push(out);
        return out;
      },
    } as ReplayWorkflow,
  ]);
  const [first, second] = runs as [(typeof runs)[0], (typeof runs)[0]];
  return { extras, first, second, journal: first.journal };
};

/** The parent's children by job key: each one's dedup key, and how many executions the store holds. */
const children = (journal: Journal) => ({
  keys: journal.d.db.sqlite
    .prepare(
      `select r.label as key, k.canonical from mameko_executions e join intake_records r on r.execution_id = e.id
       join mameko_dedup_keys k on k.execution_id = e.id where e.parent_id = ? order by r.label`,
    )
    .all(journal.parent),
  executions: journal.d.db.sqlite.prepare("select count(*) as n from mameko_executions").get(),
});

describe("a job matrix parent under a replayed workflow", () => {
  it("[FD-GATE-031] gives each job the dedup key <parent dedup key>/<job key>, so the replayed parent admits no second job", async () => {
    const { extras, first, second, journal } = await replayed(workflows[0]!);
    try {
      expect(extras).toEqual([]);
      expect(second.effects).toEqual([]);
      // The first run admits each job once, and the replay's admissions answer the same executions.
      expect(children(journal)).toEqual({
        keys: JOB_KEYS.map((k) => ({ key: k, canonical: `${PARENT_DEDUP_KEY}/${k}` })),
        executions: { n: JOB_KEYS.length + 1 },
      });
      expect(first.effects.filter((e) => e.kind === "github")).toEqual([]);
      expect(journal.gh.runs).toEqual([]);
    } finally {
      journal.d.db.sqlite.close();
    }
  });

  it("[FD-GATE-046] reports each job under flare-dispatch/<run>:<job key>, and the replayed parent opens and concludes no second check run", async () => {
    const { extras, first, second, journal } = await replayed(workflows[1]!);
    try {
      expect(extras).toEqual([]);
      expect(second.effects).toEqual([]);
      // One check run per job, created under its job check name and concluded with the job's outcome.
      const ids = new Map(
        (
          journal.d.db.sqlite
            .prepare(
              "select e.id, r.label from mameko_executions e join intake_records r on r.execution_id = e.id where e.parent_id = ?",
            )
            .all(journal.parent) as { id: string; label: string }[]
        ).map((r) => [r.id, r.label]),
      );
      // The parent's own check run, `flare-dispatch/offload-test`, stays open while the parent runs.
      expect(
        journal.gh.runs
          .filter((r) => ids.has(r.external_id ?? ""))
          .map((r) => [ids.get(r.external_id ?? ""), r.name, r.status, r.conclusion])
          .sort(),
      ).toEqual(
        JOB_KEYS.map((k) => [k, `flare-dispatch/offload-test:${k}`, "completed", "success"]),
      );
      expect(first.effects.filter((e) => e.kind === "github").length).toBeGreaterThanOrEqual(
        2 * JOB_KEYS.length,
      );
    } finally {
      journal.d.db.sqlite.close();
    }
  });
});
