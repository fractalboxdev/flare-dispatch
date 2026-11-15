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

describe("a job matrix parent under a replayed workflow", () => {
  it("[FD-GATE-031] gives each job the dedup key <parent dedup key>/<job key>, so the replayed parent admits no second job", async () => {
    const { extras, first, second, journal } = await replayed(workflows[0]!);
    try {
      expect(extras).toEqual([]);
      expect(second.effects).toEqual([]);
      expect(journal.requests.map((r) => r.dedupKey)).toEqual(
        [...JOB_KEYS, ...JOB_KEYS].map((k) => `${PARENT_DEDUP_KEY}/${k}`),
      );
      // The first run admits each job once; the replay's admissions answer the same executions as duplicates.
      const firstRun = journal.admissions.slice(0, JOB_KEYS.length);
      expect(firstRun.map((a) => [a.key, a.answer])).toEqual(JOB_KEYS.map((k) => [k, "Queued"]));
      expect(journal.admissions.slice(JOB_KEYS.length)).toEqual(
        firstRun.map((a) => ({ ...a, answer: "Duplicate" })),
      );
      expect(
        journal.db.sqlite.prepare("select count(*) as n from executions").get() as { n: number },
      ).toEqual({ n: JOB_KEYS.length });
      expect(first.effects.filter((e) => e.kind === "github")).toEqual([]);
      expect(journal.gh.runs).toEqual([]);
    } finally {
      journal.db.sqlite.close();
    }
  });

  it("[FD-GATE-046] reports each job under flare-dispatch/<run>:<job key>, and the replayed parent opens and concludes no second check run", async () => {
    const { extras, first, second, journal } = await replayed(workflows[1]!);
    try {
      expect(extras).toEqual([]);
      expect(second.effects).toEqual([]);
      const names = JOB_KEYS.map((k) => `flare-dispatch/offload-test:${k}`);
      expect(journal.requests.map((r) => r.checkName)).toEqual([...names, ...names]);
      // One check run per job, created under its job check name and concluded with the job's outcome.
      const ids = new Map(journal.admissions.map((a) => [a.id, a.key]));
      expect(
        journal.gh.runs.map((r) => [ids.get(r.external_id ?? ""), r.name, r.status, r.conclusion]),
      ).toEqual(
        JOB_KEYS.map((k) => [k, `flare-dispatch/offload-test:${k}`, "completed", "success"]),
      );
      expect(first.effects.filter((e) => e.kind === "github").length).toBeGreaterThanOrEqual(
        2 * JOB_KEYS.length,
      );
    } finally {
      journal.db.sqlite.close();
    }
  });
});
