// A matrix parent's end and its children's conclusions run twice over one journal: the first run writes each child's
// own terminal outcome, writes the parent's verdict (mameko's parent-ended cascade ends every live child), runs the
// tick's child-conclusions pass twice, and drains the outbox through a conclusion whose answer GitHub lost; the second
// run repeats every step over the same D1 and fake GitHub, as an engine that lost its journal entries runs them again.
// The second run makes no GitHub call, D1 write or intent.
import {
  checkConclusion,
  CHILD_CONCLUDE_KEY,
  GithubHttpError,
  insertChildConclusions,
  migrateChildConclusions,
  PARENT_CLOSED,
  verdictOf,
} from "@fractalboxdev/flare-dispatch-github";
import { fakeGithub } from "@fractalboxdev/flare-dispatch-github/testing";
import { migratedD1 } from "@fractalboxdev/flare-dispatch-intake/testing";
import type { ExecutionOutcome } from "@fractalboxdev/mameko-coordinator";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  runReplays,
  type ReplayEffect,
} from "../../../../packages/ops/src/verification/harness.ts";
import { concludeKindOf } from "../../src/config.ts";
import type { TestD1 } from "../conclude.test-support.ts";
import {
  drain,
  openCheck,
  PARENT,
  profile,
  seed,
  terminalWrite,
} from "../sim/child-conclusions.sim.ts";

const MINUTE_MS = 60_000;

interface Child {
  readonly id: string;
  /** Whether the child owns a check run. */
  readonly owns: boolean;
  /** The outcome the child reaches on its own before the parent ends; `null` while the parent's end finds it live. */
  readonly own: ExecutionOutcome | null;
  /** Whether the child's own conclusion drains before the parent ends. */
  readonly drainedFirst: boolean;
}

const CHILDREN: readonly Child[] = [
  { id: "child-1", owns: true, own: { _tag: "Success", epoch: 1 }, drainedFirst: true },
  {
    id: "child-2",
    owns: true,
    own: { _tag: "Failure", reason: "lint: 3 errors", epoch: 1 },
    drainedFirst: false,
  },
  { id: "child-3", owns: true, own: null, drainedFirst: false },
  { id: "child-4", owns: true, own: null, drainedFirst: false },
  { id: "child-5", owns: false, own: null, drainedFirst: false },
];

const PARENT_OUTCOME: ExecutionOutcome = { _tag: "Failure", reason: "jobs: j2", epoch: 1 };

/** The store and fake GitHub the first run writes, with the clock both runs advance. */
interface Journal {
  readonly db: TestD1;
  readonly gh: ReturnType<typeof fakeGithub>;
  clock: number;
  /** The children each tick pass inserted a `cp:check:conclude` row for, in order. */
  readonly passes: (readonly string[])[];
  /** Whether the first run's drain took the lost answer. */
  lostConsumed: boolean;
}

/** Every outbox and execution row, keyed by table and id, with its full content. */
const snapshot = (db: TestD1): ReadonlyMap<string, string> =>
  new Map([
    ...(db.sqlite.prepare("select * from outbox").all() as { id: string }[]).map(
      (r) => [`outbox ${r.id}`, JSON.stringify(r)] as const,
    ),
    ...(db.sqlite.prepare("select * from executions").all() as { id: string }[]).map(
      (r) => [`executions ${r.id}`, JSON.stringify(r)] as const,
    ),
  ]);

/** The parent, its children and their open check runs, as admission and the first drain leave them. */
const admitted = async (): Promise<Journal> => {
  const db = await migratedD1();
  await Effect.runPromise(migrateChildConclusions(db));
  const gh = fakeGithub();
  // The terminal writes stamp rows with the store's clock, so every drain and pass runs after them.
  const journal: Journal = { db, gh, clock: Date.now() + 1_000, passes: [], lostConsumed: false };
  await seed(db, PARENT, "matrix", null);
  for (const [i, child] of CHILDREN.entries()) {
    await seed(db, child.id, `j${i + 1}`, PARENT);
    if (child.owns) await openCheck(db, child.id, `j${i + 1}`, journal.clock);
  }
  await drainAll(journal);
  return journal;
};

const drainAll = async (j: Journal) => {
  for (let pass = 0; pass < 20; pass++) {
    j.clock += MINUTE_MS;
    await drain(j.db, j.gh, j.clock);
    const open = j.db.sqlite
      .prepare("select count(*) as n from outbox where state in ('pending', 'in_flight')")
      .get() as { n: number };
    if (open.n === 0) return;
  }
};

const parentEnds = async (journal: Journal | null) => {
  const j = journal ?? (await admitted());
  const calls = j.gh.calls.length;
  const before = snapshot(j.db);

  for (const child of CHILDREN) {
    if (child.own === null) continue;
    await terminalWrite(j.db, child.id, child.own);
    if (child.drainedFirst) await drainAll(j);
  }
  await terminalWrite(j.db, PARENT, PARENT_OUTCOME);
  // Two tick passes over the ended parent, the second before any drain.
  const kind = concludeKindOf(profile);
  j.clock += 1_000;
  j.passes.push(await Effect.runPromise(insertChildConclusions(j.db, kind, j.clock)));
  j.passes.push(await Effect.runPromise(insertChildConclusions(j.db, kind, j.clock + MINUTE_MS)));
  // GitHub applies the first conclusion the drain sends and its answer is lost; the retry finds it applied.
  j.gh.lostAnswers.push(
    new GithubHttpError({ status: 502, message: "bad gateway", rateLimited: false }),
  );
  await drainAll(j);
  if (journal === null) j.lostConsumed = j.gh.lostAnswers.length === 0;
  j.gh.lostAnswers.length = 0;

  const after = snapshot(j.db);
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

describe("an ended matrix parent's child conclusions under a replayed tick and drain", () => {
  it("[FD-GATE-047] each open child check gets one conclusion, and the second run makes no extra effect", async () => {
    let first: Journal | null = null;
    const extras = await runReplays([
      {
        name: "child-conclusions",
        ids: ["FD-GATE-047"],
        run: async (journal) => {
          const out = await parentEnds(journal as Journal | null);
          first ??= out.journal;
          return out;
        },
      },
    ]);
    const j = first! as Journal;
    expect(extras).toEqual([]);
    // The first run's first pass inserts a row for each open child check: child-1 concluded before the parent ended
    // and child-5 owns no check run. Its second pass and both of the second run's passes insert none.
    expect(j.passes).toEqual([["child-2", "child-3", "child-4"], [], [], []]);
    expect(j.lostConsumed).toBe(true);
    const rows = j.db.sqlite
      .prepare(
        "select execution_id, kind, payload_json, state from outbox where intent_key = ? order by execution_id",
      )
      .all(CHILD_CONCLUDE_KEY) as { execution_id: string; payload_json: string }[];
    expect(rows.map((r) => ({ ...r, payload_json: JSON.parse(r.payload_json) }))).toEqual([
      {
        execution_id: "child-2",
        kind: "check.conclude",
        payload_json: { verdict: verdictOf(CHILDREN[1]!.own!) },
        state: "applied",
      },
      ...["child-3", "child-4"].map((id) => ({
        execution_id: id,
        kind: "check.conclude",
        payload_json: { verdict: PARENT_CLOSED },
        state: "applied",
      })),
    ]);
    // Each child check run ends completed once, with the child's own outcome or parent closed.
    for (const child of CHILDREN.filter((c) => c.owns)) {
      const expected = checkConclusion(child.own === null ? PARENT_CLOSED : verdictOf(child.own));
      expect(
        j.gh.runs
          .filter((r) => r.external_id === child.id)
          .map((r) => [r.status, r.conclusion, r.output.title]),
        child.id,
      ).toEqual([["completed", expected.conclusion, expected.title]]);
    }
  });
});
