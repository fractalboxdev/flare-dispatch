// A local execution's writeback run twice over one journal (local-writeback.replay.ts): the rerun steps make no GitHub
// call, D1 write or intent the first run did not, and none at all.
import { describe, expect, it } from "vitest";
import { runReplays, type ReplayWorkflow } from "../../../ops/src/verification/harness.ts";
import { lifecycle, workflows, type LocalRun } from "./local-writeback.replay.ts";

describe("a local execution's writeback under a replayed workflow", () => {
  it("[FD-LOCAL-055] keys each local.writeback intent by execution id and run:<step>:<index>, so the rerun steps write nothing twice", async () => {
    const runs: LocalRun[] = [];
    const extras = await runReplays([
      {
        ...workflows[0]!,
        run: async (journal) => {
          const out = await lifecycle(journal as LocalRun["journal"] | null);
          runs.push(out);
          return out;
        },
      } as ReplayWorkflow,
    ]);
    const [first, second] = runs as [LocalRun, LocalRun];
    const { plane, executions } = first.journal;
    try {
      expect(extras).toEqual([]);
      expect(second.effects).toEqual([]);
      // The first run wrote each writeback intent once per execution: the same step keys under both execution ids.
      const keys = ["run:propose:0", "run:review:0", "run:review:1"];
      expect(plane.outbox()).toEqual(
        [...executions].sort().flatMap((executionId) =>
          keys.map((intentKey) => ({
            executionId,
            intentKey,
            kind: intentKey === "run:propose:0" ? "pr.propose" : "review",
          })),
        ),
      );
      expect(first.effects.filter((e) => e.kind === "intent")).toHaveLength(6);
      expect(first.effects.filter((e) => e.kind === "github")).toEqual([
        { kind: "github", key: "branchProtected" },
        { kind: "github", key: "branchProtected" },
      ]);
      expect(first.acks).toEqual(Array(6).fill("accepted"));
      // The rerun steps' requests each answer duplicate before the gate reads GitHub or counts a rate-window entry.
      expect(second.acks).toEqual(Array(6).fill("duplicate"));
    } finally {
      plane.close();
    }
  });
});
