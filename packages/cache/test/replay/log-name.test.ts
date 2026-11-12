// The log-naming workflow run twice over one journal (log-name.replay.ts): the rerun of the steps whose results were
// lost writes exactly the log objects the first run wrote for them, so the bucket and the aggregate log stay as they
// were.
import { describe, expect, it } from "vitest";
import { runReplays } from "../../../ops/src/verification/harness.ts";
import { parseLogObjectName, serveLogs, stepKey } from "../../src/logs.ts";
import type { Bucket } from "../../src/manifest.ts";
import {
  EPOCH,
  EXECUTION,
  JOURNALED_STEPS,
  logNameRun,
  STEPS,
  workflows,
  type Journal,
  type LogNameRun,
} from "./log-name.replay.ts";

const keysOf = async (bucket: Bucket) =>
  (await bucket.list({ prefix: `logs/${EXECUTION}/` })).objects.map((o) => o.key).sort();

const aggregate = async (bucket: Bucket) => {
  const read = await serveLogs(
    new Request(`https://ci.example.com/v1/executions/${EXECUTION}/logs?format=text`),
    { executionId: EXECUTION, file: undefined },
    { bucket, execution: async () => ({ terminal: true }) },
  );
  if (read._tag !== "Served") throw new Error(read._tag);
  return read.response.text();
};

describe("log object names under a replayed workflow", () => {
  it("[FD-CACHE-081] a replayed step writes the same log object names from its journal name, epoch and offsets, so the rerun adds no object and the aggregate log shows each line once", async () => {
    const runs: LogNameRun[] = [];
    const snapshots: { keys: string[]; text: string }[] = [];
    const extras = await runReplays([
      {
        ...workflows[0]!,
        run: async (journal) => {
          const out = await logNameRun(journal as Journal | null);
          runs.push(out);
          snapshots.push({
            keys: await keysOf(out.journal.bucket),
            text: await aggregate(out.journal.bucket),
          });
          return out;
        },
      },
    ]);
    expect(extras).toEqual([]);
    const [first, second] = runs;
    const lost = STEPS.slice(JOURNALED_STEPS).map((s) => s.journalName);
    expect(first!.ran).toEqual(STEPS.map((s) => s.journalName));
    expect(second!.ran).toEqual(lost);

    // Every name is the grammar's, at this epoch, under the step key of the step's journal name.
    const stepKeys = new Map(
      await Promise.all(
        STEPS.map(async (s) => [await stepKey(s.journalName), s.journalName] as const),
      ),
    );
    for (const e of first!.effects) {
      const log = parseLogObjectName(e.key.slice("log ".length));
      expect(log).toMatchObject({ executionId: EXECUTION, epoch: EPOCH });
      expect(stepKeys.has(log!.stepKey)).toBe(true);
    }

    // The rerun wrote exactly the names the first run wrote for the lost steps, several segments each.
    const lostKeys = new Set(await Promise.all(lost.map(stepKey)));
    const firstForLost = first!.effects
      .map((e) => e.key)
      .filter((k) => lostKeys.has(parseLogObjectName(k.slice("log ".length))!.stepKey));
    expect(second!.effects.map((e) => e.key)).toEqual(firstForLost);
    expect(second!.effects.length).toBeGreaterThan(lost.length);

    // The bucket holds the same objects, and a reader sees each line once.
    expect(snapshots[1]!.keys).toEqual(snapshots[0]!.keys);
    expect(snapshots[1]!.text).toEqual(snapshots[0]!.text);
    for (const step of STEPS)
      for (const line of [...step.lines.stdout, ...step.lines.stderr])
        expect(snapshots[1]!.text.split(line).length - 1).toBe(1);
  });
});
