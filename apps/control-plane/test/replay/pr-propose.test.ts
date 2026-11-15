// The accepted results' `pr.propose` rows run twice over one journal (pr-propose.replay.ts): the redelivered results,
// the repeated channel step and the repeated apply-outbox stage make no D1 write or intent the first run did not, and
// none at all.
import { describe, expect, it } from "vitest";
import {
  runReplays,
  type ReplayEffect,
} from "../../../../packages/ops/src/verification/harness.ts";
import { PR_PROPOSE_KEY } from "../../src/pr-propose.ts";
import { accept, MANIFEST, workflows, type Journal } from "./pr-propose.replay.ts";

describe("an accepted result's pr.propose row under a replayed accept and workflow", () => {
  it("[FD-AGT-034] inserts one pr.propose row for the success that staged a write, none for the others, and none on the replay", async () => {
    const runs: { journal: Journal; effects: readonly ReplayEffect[] }[] = [];
    const extras = await runReplays([
      {
        ...workflows[0]!,
        run: async (journal) => {
          const out = await accept(journal as Journal | null);
          runs.push(out);
          return out;
        },
      },
    ]);
    const [first, second] = runs as [(typeof runs)[0], (typeof runs)[0]];
    const { db, acks, recorded } = first.journal;
    try {
      expect(extras).toEqual([]);
      expect(second.effects).toEqual([]);
      // The channel accepts each result once; the redelivered frames answer `duplicate` and complete no deferred.
      expect(acks).toEqual([...Array(3).fill("accepted"), ...Array(3).fill("duplicate")]);
      expect(recorded).toEqual(["exec-staged@1", "exec-nothing-staged@1", "exec-failed@1"]);
      const rows = db.sqlite
        .prepare(
          "select execution_id, intent_key, payload_json, state from outbox where kind = 'pr.propose' order by id",
        )
        .all() as { execution_id: string; payload_json: string }[];
      expect(rows.map((r) => ({ ...r, payload_json: JSON.parse(r.payload_json) }))).toEqual([
        {
          execution_id: "exec-staged",
          intent_key: PR_PROPOSE_KEY,
          payload_json: {
            executionId: "exec-staged",
            run: "spec-drift-pr",
            repo: { owner: "acme", name: "app" },
            manifest: MANIFEST,
          },
          state: "pending",
        },
      ]);
      expect(first.effects).toContainEqual({
        kind: "intent",
        key: `outbox exec-staged:${PR_PROPOSE_KEY}`,
      });
      // Each execution's outcome row is written once, by the first run's apply-outbox stage.
      expect(
        db.sqlite
          .prepare("select execution_id, kind from outbox where tier = 'outcome' order by id")
          .all(),
      ).toEqual([
        { execution_id: "exec-failed", kind: "check.conclude" },
        { execution_id: "exec-nothing-staged", kind: "check.conclude" },
        { execution_id: "exec-staged", kind: "check.conclude" },
      ]);
    } finally {
      db.sqlite.close();
    }
  });
});
