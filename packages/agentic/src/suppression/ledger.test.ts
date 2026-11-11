import { Effect, Exit, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { memoryD1 } from "../local/d1.test-support.ts";
import { CI_TRIAGE_BRANCH, ExecutionsRead } from "../recipes/ci-triage-pr.ts";
import {
  fakeServices,
  payload,
  recorder,
  type FakeOptions,
} from "../recipes/fakes.test-support.ts";
import { improveBranch } from "../recipes/improve-pr.ts";
import { ciTriageRun, improvePrRun, specDriftRun } from "../recipes/runs.ts";
import { SuppressionLedger, type SuppressionEntry } from "../recipes/services.ts";
import { SPEC_DRIFT_BRANCH } from "../recipes/spec-drift-pr.ts";
import {
  decideSuppression,
  SUPPRESSION_COOLDOWN_DAYS_DEFAULT,
  suppressionKey,
  suppressionLedgerD1,
} from "./ledger.ts";

const DAY = 86_400_000;
const repo = { owner: "o", name: "r" };
const dimension = {
  name: "bundle-size",
  measure: "node scripts/size.js",
  better: "lower" as const,
  materialityFloor: 10,
  verify: "pnpm test",
};
const IMPROVE_KEY = suppressionKey(repo, improveBranch(dimension));

const declined = (key: string): SuppressionEntry => ({ key, declined: true, closedAt: null });
const closedDaysAgo = (key: string, days: number): SuppressionEntry => ({
  key,
  declined: false,
  closedAt: Date.now() - days * DAY,
});

/** A measurement that improves from 120 to 100 and a verify that exits 0: a run that stages a write unless suppressed. */
const improving = (): FakeOptions["shell"] => {
  let measured = 0;
  const scores = [120, 100];
  return (c) =>
    c === dimension.measure
      ? { exitCode: 0, stdout: `size: ${scores[measured++]} KiB`, stderr: "" }
      : { exitCode: 0, stdout: "", stderr: "" };
};

const runImprove = (options: FakeOptions, ledger?: Layer.Layer<SuppressionLedger>) => {
  const rec = recorder();
  const services = fakeServices(rec, { shell: improving(), ...options });
  return Effect.runPromise(
    improvePrRun.workflow
      .execute(payload("improve-pr", { repo, baseBranch: "main", dimension }))
      .pipe(
        Effect.provide(
          Layer.provideMerge(
            improvePrRun.layer,
            ledger === undefined ? services : Layer.merge(services, ledger),
          ),
        ),
      ),
  ).then((result) => ({ result, rec }));
};

const runSpecDrift = (options: FakeOptions) => {
  const rec = recorder({ "specs/a.md": "# A" });
  return Effect.runPromise(
    specDriftRun.workflow.execute(payload("spec-drift-pr", { repo, baseBranch: "main" })).pipe(
      Effect.provide(
        Layer.provideMerge(
          specDriftRun.layer,
          fakeServices(rec, {
            model: () =>
              JSON.stringify({
                inSync: false,
                summary: "Specs lag.",
                files: [{ path: "specs/a.md", content: "# A2" }],
              }),
            ...options,
          }),
        ),
      ),
    ),
  ).then((result) => ({ result, rec }));
};

const runCiTriage = (options: FakeOptions) => {
  const rec = recorder();
  const reads: string[] = [];
  const executions = Layer.succeed(ExecutionsRead, {
    failedSince: () =>
      Effect.sync(() => {
        reads.push("failedSince");
        return [
          { executionId: "01HFAIL", run: "check", reason: "exit: 1", finishedAt: Date.now() },
        ];
      }),
    failedJobLog: () => Effect.succeed("boom"),
  });
  return Effect.runPromise(
    ciTriageRun.workflow.execute(payload("ci-triage-pr", { repo, baseBranch: "main" })).pipe(
      Effect.provide(
        Layer.provideMerge(
          ciTriageRun.layer,
          Layer.merge(
            fakeServices(rec, {
              model: (r) => (r.callSite === "classify" ? "flaky" : "One flaky test."),
              ...options,
            }),
            executions,
          ),
        ),
      ),
    ),
  ).then((result) => ({ result, rec, reads }));
};

describe("the suppression ledger's decision", () => {
  const now = Date.UTC(2026, 10, 12);
  const key = "o/r:flare-dispatch/improve-size";

  it("[FD-AGT-043] suppresses a declined key whatever its age, and no row leaves the proposal open", () => {
    expect(decideSuppression(null, now)).toBe(false);
    expect(decideSuppression({ key, declined: true, closedAt: null }, now)).toBe(true);
    expect(decideSuppression({ key, declined: true, closedAt: now - 400 * DAY }, now)).toBe(true);
  });

  it("[FD-AGT-043] suppresses a key for 30 days from the matching pull request's closed_at, by default", () => {
    expect(SUPPRESSION_COOLDOWN_DAYS_DEFAULT).toBe(30);
    const closedAt = now - 30 * DAY;
    expect(decideSuppression({ key, declined: false, closedAt: closedAt + 1 }, now)).toBe(true);
    expect(decideSuppression({ key, declined: false, closedAt }, now)).toBe(false);
    expect(decideSuppression({ key, declined: false, closedAt: null }, now)).toBe(false);
    expect(decideSuppression({ key, declined: false, closedAt: now - 10 * DAY }, now, 7)).toBe(
      false,
    );
  });
});

describe("the suppression ledger over D1", () => {
  const seed = async (rows: readonly [string, number, number | null][]) => {
    const db = memoryD1();
    for (const [key, isDeclined, closedAt] of rows)
      await db
        .prepare("insert into fd_suppressions (key, declined, closed_at) values (?, ?, ?)")
        .bind(key, isDeclined, closedAt)
        .run();
    return db;
  };
  const lookup = (db: ReturnType<typeof memoryD1>, key: string) =>
    Effect.runPromiseExit(
      Effect.gen(function* () {
        return yield* (yield* SuppressionLedger).lookup(key);
      }).pipe(Effect.provide(suppressionLedgerD1(db))),
    );

  it("[FD-AGT-043] answers the row of the exact key only, letter case included", async () => {
    const db = await seed([
      ["o/r:flare-dispatch/improve-size", 1, null],
      ["o/r:flare-dispatch/spec-drift", 0, 1_700_000_000_000],
    ]);
    expect(await lookup(db, "o/r:flare-dispatch/improve-size")).toEqual(
      Exit.succeed({ key: "o/r:flare-dispatch/improve-size", declined: true, closedAt: null }),
    );
    expect(await lookup(db, "o/r:flare-dispatch/spec-drift")).toEqual(
      Exit.succeed({
        key: "o/r:flare-dispatch/spec-drift",
        declined: false,
        closedAt: 1_700_000_000_000,
      }),
    );
    for (const near of [
      "o/r:flare-dispatch/improve-size-2",
      "o/r:flare-dispatch/improve-",
      "O/R:flare-dispatch/improve-size",
      "o/r:flare-dispatch/improve-%",
      "x/r:flare-dispatch/improve-size",
    ])
      expect(await lookup(db, near)).toEqual(Exit.succeed(null));
  });

  it("[FD-AGT-044] fails the read when the query throws or the row is outside the table's shape, never answering null", async () => {
    const failing = await seed([]);
    failing.fail.on = true;
    const thrown = await lookup(failing, "o/r:b");
    expect(Exit.isFailure(thrown)).toBe(true);
    expect(JSON.stringify(thrown)).toContain("SuppressionReadFailed");

    const malformed = await seed([["o/r:b", 2, null]]);
    const bad = await lookup(malformed, "o/r:b");
    expect(Exit.isFailure(bad)).toBe(true);
    expect(JSON.stringify(bad)).toContain("SuppressionReadFailed");
  });
});

describe("recipes read the suppression ledger before opening a pull request", () => {
  it("[FD-AGT-043] improve-pr looks up its exact key and, while the key is declined, measures nothing and stages nothing", async () => {
    const open = await runImprove({});
    expect(open.rec.suppressionLookups).toEqual(["o/r:flare-dispatch/improve-bundle-size"]);
    expect(open.rec.staged).toHaveLength(1);

    const { result, rec } = await runImprove({
      suppression: (key) => (key === IMPROVE_KEY ? declined(key) : null),
    });
    expect(result).toEqual({ _tag: "success" });
    expect(rec.suppressionLookups).toEqual([IMPROVE_KEY]);
    expect(rec.commands).toEqual([]);
    expect(rec.prompts).toEqual([]);
    expect(rec.staged).toEqual([]);
  });

  it("[FD-AGT-043] improve-pr opens nothing within 30 days of the matching pull request's close, and opens after", async () => {
    const cooling = await runImprove({ suppression: (key) => closedDaysAgo(key, 29) });
    expect(cooling.result).toEqual({ _tag: "success" });
    expect(cooling.rec.staged).toEqual([]);
    expect(cooling.rec.prompts).toEqual([]);

    const cooled = await runImprove({ suppression: (key) => closedDaysAgo(key, 31) });
    expect(cooled.result).toEqual({ _tag: "success" });
    expect(cooled.rec.staged.map((s) => s.branch)).toEqual(["flare-dispatch/improve-bundle-size"]);
  });

  it("[FD-AGT-043] improve-pr decides on the D1 ledger's row for its key", async () => {
    const db = memoryD1();
    await db
      .prepare("insert into fd_suppressions (key, declined, closed_at) values (?, 1, null)")
      .bind(IMPROVE_KEY)
      .run();
    const suppressed = await runImprove({}, suppressionLedgerD1(db));
    expect(suppressed.result).toEqual({ _tag: "success" });
    expect(suppressed.rec.staged).toEqual([]);

    const other = memoryD1();
    await other
      .prepare("insert into fd_suppressions (key, declined, closed_at) values (?, 1, null)")
      .bind(suppressionKey({ owner: "o", name: "other" }, improveBranch(dimension)))
      .run();
    const open = await runImprove({}, suppressionLedgerD1(other));
    expect(open.rec.staged).toHaveLength(1);
  });

  it("[FD-AGT-043] spec-drift-pr and ci-triage-pr open nothing and return no intent while their key is declined", async () => {
    const drift = await runSpecDrift({ suppression: declined });
    expect(drift.result).toEqual({ _tag: "success" });
    expect(drift.rec.suppressionLookups).toEqual([suppressionKey(repo, SPEC_DRIFT_BRANCH)]);
    expect(drift.rec.modelCalls).toEqual([]);
    expect(drift.rec.staged).toEqual([]);
    expect(drift.rec.intents).toEqual([]);
    expect((await runSpecDrift({})).rec.staged).toHaveLength(1);

    const triage = await runCiTriage({ suppression: (key) => closedDaysAgo(key, 3) });
    expect(triage.result).toEqual({ _tag: "success" });
    expect(triage.rec.suppressionLookups).toEqual([suppressionKey(repo, CI_TRIAGE_BRANCH)]);
    expect(triage.reads).toEqual([]);
    expect(triage.rec.staged).toEqual([]);
    expect(triage.rec.intents).toEqual([]);
    expect((await runCiTriage({})).rec.staged).toHaveLength(1);
  });
});

describe("a failed suppression ledger read", () => {
  it("[FD-AGT-044] improve-pr opens nothing and concludes failure with the reason suppression: read failed", async () => {
    const { result, rec } = await runImprove({ suppression: () => "fail" });
    expect(result).toEqual({ _tag: "failure", reason: "suppression: read failed" });
    expect(rec.prompts).toEqual([]);
    expect(rec.staged).toEqual([]);
    expect(rec.intents).toEqual([]);
  });

  it("[FD-AGT-044] improve-pr concludes suppression: read failed when the D1 ledger read throws", async () => {
    const db = memoryD1();
    db.fail.on = true;
    const { result, rec } = await runImprove({}, suppressionLedgerD1(db));
    expect(result).toEqual({ _tag: "failure", reason: "suppression: read failed" });
    expect(rec.staged).toEqual([]);
  });

  it("[FD-AGT-044] spec-drift-pr and ci-triage-pr open nothing and conclude suppression: read failed", async () => {
    for (const { result, rec } of [
      await runSpecDrift({ suppression: () => "fail" }),
      await runCiTriage({ suppression: () => "fail" }),
    ]) {
      expect(result).toEqual({ _tag: "failure", reason: "suppression: read failed" });
      expect(rec.staged).toEqual([]);
      expect(rec.intents).toEqual([]);
      expect(rec.modelCalls).toEqual([]);
    }
  });
});
