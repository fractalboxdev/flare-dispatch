// An execution's check-run lifecycle runs twice over one journal: the first run admits the execution, drains its
// `check.open` row through a create whose answer GitHub lost, grants a lease, takes a redelivered webhook, writes the
// terminal outcome and drains to quiet; the second run repeats every step over the same D1 and fake GitHub, as an
// engine that lost its journal entries runs them again. The second run makes no GitHub call, D1 write or intent.
import { GithubHttpError, quotaOptionsDefault } from "@fractalboxdev/flare-dispatch-github";
import { describe, expect, it } from "vitest";
import {
  runReplays,
  type ReplayEffect,
} from "../../../../packages/ops/src/verification/harness.ts";
import {
  checkName,
  drainAll,
  idOf,
  MINUTE_MS,
  plane,
  SHA,
  type Execution,
  type Plane,
} from "../sim/github-output.sim.ts";

const execution: Execution = {
  id: idOf(1),
  run: "run-0",
  attempt: 1,
  className: "required",
  outcome: { _tag: "Success", epoch: 1 },
};

/** Every outbox and execution row, keyed by table and id, with its full content. */
const snapshot = (p: Plane): ReadonlyMap<string, string> =>
  new Map([
    ...p
      .rows<{ id: string }>("select * from outbox")
      .map((r) => [`outbox ${r.id}`, JSON.stringify(r)] as const),
    ...p
      .rows<{ id: string }>("select * from executions")
      .map((r) => [`executions ${r.id}`, JSON.stringify(r)] as const),
  ]);

const lifecycle = async (journal: Plane | null) => {
  const p = journal ?? (await plane(quotaOptionsDefault));
  const calls = p.gh.calls.length;
  const before = snapshot(p);

  await p.admit(execution);
  // GitHub creates the check run and the answer is lost; the retry finds it by external_id.
  p.gh.lostAnswers.push(
    new GithubHttpError({ status: 502, message: "bad gateway", rateLimited: false }),
  );
  await p.drain();
  await p.advance(MINUTE_MS);
  await p.drain();
  await p.insert(execution, "check.start", "cp:check:start:1", {
    name: checkName(execution.run),
    head_sha: SHA,
    epoch: 1,
    executor_kind: "device",
    attempt: 1,
  });
  await p.admit(execution, idOf(2));
  await p.terminal(execution);
  await drainAll(p, MINUTE_MS, 50);
  p.gh.lostAnswers.length = 0;

  const after = snapshot(p);
  const effects: ReplayEffect[] = [
    ...p.gh.calls
      .slice(calls)
      .map((call): ReplayEffect => ({ kind: "github", key: `${call} ${execution.id}` })),
    ...[...after]
      .filter(([key, row]) => before.get(key) !== row)
      .map(([key]): ReplayEffect => ({ kind: "d1", key })),
    ...[...after.keys()]
      .filter((key) => key.startsWith("outbox ") && !before.has(key))
      .map((key): ReplayEffect => ({ kind: "intent", key })),
  ];
  return { journal: p, effects };
};

describe("an execution's check run under a replayed lifecycle", () => {
  it("[FD-GH-010] the second run over the journal creates no second check run and makes no extra effect", async () => {
    let first: Plane | null = null;
    const extras = await runReplays([
      {
        name: "check-run-lifecycle",
        ids: ["FD-GH-010"],
        run: async (journal) => {
          const out = await lifecycle(journal as Plane | null);
          first ??= out.journal;
          return out;
        },
      },
    ]);
    const p = first! as Plane;
    try {
      expect(extras).toEqual([]);
      expect(p.gh.calls.filter((c) => c === "create")).toHaveLength(1);
      expect(p.gh.runs).toMatchObject([
        { external_id: execution.id, status: "completed", conclusion: "success" },
      ]);
    } finally {
      await p.dispose();
    }
  });
});
