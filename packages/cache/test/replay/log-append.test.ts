// The countersign-and-log step run twice over one journal (log-append.replay.ts): the second run records no intent,
// writes no intent row and sends no append the first did not.
import { describe, expect, it } from "vitest";
import { runReplays } from "../../../ops/src/verification/harness.ts";
import { logAppendRun, workflows, type Journal, type LogAppendRun } from "./log-append.replay.ts";

describe("the countersign-and-log step under a replayed workflow", () => {
  it("[FD-PROV-034] the log-append intent of a countersigned envelope is keyed by its digest, so a replay records no second intent and appends the envelope once", async () => {
    const runs: LogAppendRun[] = [];
    const extras = await runReplays([
      {
        ...workflows[0]!,
        run: async (journal) => {
          const out = await logAppendRun(journal as Journal | null);
          runs.push(out);
          return out;
        },
      },
    ]);
    expect(extras).toEqual([]);
    const [first, second] = runs;
    // The first run recorded the intent, wrote its row twice (insert, logged) and appended once; the replay nothing.
    expect(first!.effects.filter((e) => e.kind === "intent")).toHaveLength(2);
    expect(first!.effects.filter((e) => e.kind === "d1")).toHaveLength(2);
    expect(second!.effects).toEqual([]);
    const { intents, entries } = second!.journal;
    expect([...intents.keys()]).toHaveLength(1);
    expect(entries).toHaveLength(1);
  });
});
