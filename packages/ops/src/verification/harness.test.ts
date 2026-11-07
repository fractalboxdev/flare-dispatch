import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  canonical,
  parseRegressions,
  replayRegressions,
  runDiff,
  type DiffSubject,
} from "./diff.ts";
import {
  runReplays,
  runSims,
  seedsToKeep,
  type ReplayEffect,
  type ReplayWorkflow,
} from "./harness.ts";

/** A gate that rejects a list holding a negative number, with an oracle that agrees, or disagrees past 100. */
const subject = (
  bugAbove = Infinity,
): DiffSubject<readonly number[], { verdict: string; reasons: number }> => ({
  kernel: "toyGate",
  run: (xs) => ({
    verdict: xs.some((x) => x < 0) ? "reject" : "accept",
    reasons: xs.filter((x) => x < 0).length,
  }),
  oracle: async (xs) => ({
    reasons: xs.filter((x) => x < 0).length,
    verdict: xs.some((x) => x < 0 || x > bugAbove) ? "reject" : "accept",
  }),
  arbitrary: fc.array(fc.integer({ min: -5, max: 200 }), { maxLength: 6 }),
});

describe("differential testing", () => {
  it("[FD-VER-019] runs generated traces through the kernel and the oracle, comparing after every event", async () => {
    expect(await runDiff(subject(), { traces: 500, seed: 7 })).toEqual({ ok: true, traces: 500 });
    expect(canonical({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe('{"a":[2,{"c":2,"d":1}],"b":1}');
  });

  it("[FD-VER-021] a differing trace is shrunk and emitted as one line with the kernel, seed, trace and both outputs", async () => {
    const outcome = await runDiff(subject(100), { traces: 2_000, seed: 11 });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.line.kernel).toBe("toyGate");
    expect(outcome.line.seed).toBe(11);
    // Shrunk to one event holding the one value that exposes the difference.
    expect(outcome.line.trace).toEqual([[101]]);
    expect(outcome.line.kernelOutput).toEqual([{ verdict: "accept", reasons: 0 }]);
    expect(outcome.line.oracleOutput).toEqual([{ reasons: 0, verdict: "reject" }]);
    expect(parseRegressions(`${JSON.stringify(outcome.line)}\n`)).toEqual([outcome.line]);
  });

  it("[FD-VER-019] [FD-VER-020] replays every kept regression first, and a fixed kernel passes it", async () => {
    const line = { kernel: "toyGate", seed: 1, trace: [[101]], kernelOutput: [], oracleOutput: [] };
    expect(await replayRegressions(subject(100), [line])).not.toBeNull();
    expect(await replayRegressions(subject(), [line])).toBeNull();
    expect(await replayRegressions(subject(100), [{ ...line, kernel: "other" }])).toBeNull();
  });
});

describe("sim and replay", () => {
  it("[FD-VER-024] runs 100 seeds per scenario plus every kept seed, and keeps each new failing seed", async () => {
    const seen: number[] = [];
    const failures = await runSims(
      [
        {
          name: "late-result",
          ids: [],
          run: async (seed) =>
            void (seen.push(seed),
            seed === 4242 || seed === 7
              ? (() => {
                  throw new Error(`seed ${seed}`);
                })()
              : 0),
        },
      ],
      100,
      [{ scenario: "late-result", seed: 4242 }],
    );
    expect(seen).toHaveLength(101);
    expect(failures.map((f) => f.seed)).toEqual([4242, 7]);
    expect(seedsToKeep(failures, [{ scenario: "late-result", seed: 4242 }])).toEqual([
      { scenario: "late-result", seed: 7 },
    ]);
  });

  it("[FD-VER-025] a second run over the journal that makes an effect the first did not fails, naming it", async () => {
    const workflow = (extra: boolean): ReplayWorkflow<string[]> => ({
      name: "check",
      ids: [],
      run: async (journal) => {
        const effects: ReplayEffect[] =
          journal === null ? [{ kind: "github", key: "POST /check-runs" }] : [];
        if (journal !== null && extra) effects.push({ kind: "d1", key: "insert outbox" });
        return { journal: ["opened"], effects };
      },
    });
    expect(await runReplays([workflow(false) as ReplayWorkflow])).toEqual([]);
    expect(await runReplays([workflow(true) as ReplayWorkflow])).toEqual([
      { workflow: "check", effect: { kind: "d1", key: "insert outbox" } },
    ]);
  });
});
