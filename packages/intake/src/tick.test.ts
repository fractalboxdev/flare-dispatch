// The minute tick: planning units, the scheduled runs of a minute and the missed-webhook sweep.
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { cronDrift, cronMatches, MINUTE_TICK, parseCron } from "./cron.ts";
import {
  APP_ID,
  BASE,
  harness,
  HEAD,
  manifest,
  repoWithManifest,
  REPO,
} from "./harness.test-support.ts";
import { planTick, runTickUnit, type TickUnit } from "./tick.ts";

const at = (h: number, m: number) => Date.UTC(2026, 10, 4, h, m, 0);

describe("cron", () => {
  it("[FD-INT-050] the template's one trigger is the minute tick; any other set drifts", () => {
    expect(cronDrift([MINUTE_TICK])).toBeNull();
    expect(cronDrift([MINUTE_TICK, "*/10 * * * *"])).toContain("differ");
    expect(cronDrift([])).toContain("differ");
  });

  it("[FD-INT-051] matches five-field expressions against the scheduled minute in UTC", () => {
    const daily = parseCron("0 3 * * *")!;
    expect(cronMatches(daily, at(3, 0))).toBe(true);
    expect(cronMatches(daily, at(3, 1))).toBe(false);
    const every = parseCron("*/15 9-17 * * 1-5")!;
    // 2026-11-04 is a Wednesday.
    expect(cronMatches(every, at(9, 45))).toBe(true);
    expect(cronMatches(every, at(18, 0))).toBe(false);
    expect(cronMatches(parseCron("0 0 * * 0,7")!, Date.UTC(2026, 10, 8, 0, 0))).toBe(true);
    expect(parseCron("61 * * * *")).toBeNull();
    expect(parseCron("* * *")).toBeNull();
  });
});

describe("planTick", () => {
  it("[FD-INT-067] the tick only plans: a schedules unit per installation every minute, a sweep unit every 10 min", () => {
    expect(planTick(at(12, 1), [7, 8]).map((u) => `${u._tag}:${u.installation}`)).toEqual([
      "schedules:7",
      "schedules:8",
    ]);
    expect(planTick(at(12, 10), [7]).map((u) => u._tag)).toEqual(["schedules", "sweep"]);
  });
});

const nightly = manifest([
  {
    recipe: "nightly",
    triggers: ["cron"],
    schedules: [{ cron: "0 3 * * *" }, { cron: "0 3 * * *", branch: "release" }],
  },
]);

describe("scheduled runs", () => {
  it("[FD-INT-051] [FD-INT-052] a matching schedule submits once per repository, pinned to its branch's head", async () => {
    const h = await harness({
      repos: { [REPO]: repoWithManifest(nightly, { branches: { main: BASE, release: HEAD } }) },
    });
    const unit: TickUnit = {
      _tag: "schedules",
      installation: 7,
      scheduledAt: at(3, 0),
      repoIndex: 0,
    };
    const result = await h.run(runTickUnit(unit));
    expect(result.next).toBeNull();
    expect(h.records().map((r) => [r.run, r.trigger, r.sha])).toEqual([["nightly", "cron", BASE]]);
    expect(h.rows("select canonical from dedup_keys").map((r) => r.canonical)).toEqual([
      `nightly:${REPO}:cron:2026-11-04T03:00:00.000Z`,
    ]);
    const quiet = await h.run(runTickUnit({ ...unit, scheduledAt: at(3, 1) }));
    expect(quiet.outcome.executions).toEqual([]);
  });

  it("[FD-INT-053] a tick fired twice for one minute creates at most one execution per run and repository", async () => {
    const h = await harness({ repos: { [REPO]: repoWithManifest(nightly) } });
    const unit: TickUnit = {
      _tag: "schedules",
      installation: 7,
      scheduledAt: at(3, 0),
      repoIndex: 0,
    };
    await h.run(runTickUnit(unit));
    const again = await h.run(runTickUnit(unit));
    expect(again).toMatchObject({ outcome: { duplicate: true } });
    expect(h.executions()).toHaveLength(1);
  });

  it("[FD-INT-058] a cron trigger takes no cooldown", async () => {
    const h = await harness({
      repos: {
        [REPO]: repoWithManifest(
          manifest([{ recipe: "lint", triggers: ["cron"], schedules: [{ cron: "* * * * *" }] }]),
        ),
      },
    });
    await h.run(
      runTickUnit({ _tag: "schedules", installation: 7, scheduledAt: at(3, 0), repoIndex: 0 }),
    );
    await h.run(
      runTickUnit({ _tag: "schedules", installation: 7, scheduledAt: at(3, 1), repoIndex: 0 }),
    );
    expect(h.records().map((r) => r.not_before)).toEqual([null, null]);
    expect(h.rows("select * from intake_cooldowns")).toEqual([]);
  });
});

const pull = (n: number, head: string, updatedAgoMs: number) => ({
  number: n,
  updated_at: new Date(Date.UTC(2026, 10, 4, 12) - updatedAgoMs).toISOString(),
  head: { sha: head, ref: `f${n}`, repo: { full_name: REPO } },
  base: { ref: "main", repo: { full_name: REPO } },
});

describe("the missed-webhook sweep", () => {
  const sweepUnit: TickUnit = {
    _tag: "sweep",
    installation: 7,
    scheduledAt: at(12, 0),
    repoIndex: 0,
    pullsSeen: 0,
  };

  it("[FD-INT-032] submits a webhook trigger for each recent head that lacks a required FlareDispatch check run", async () => {
    const covered = "1".repeat(40);
    const h = await harness({
      repos: {
        [REPO]: repoWithManifest(undefined, {
          required: { main: ["flare-dispatch/check:ci", "lint"] },
          pulls: [
            pull(1, HEAD, 3_600_000),
            pull(2, covered, 3_600_000),
            pull(3, "2".repeat(40), 73 * 3_600_000),
          ],
          checkRuns: {
            [covered]: [
              { id: 1, name: "flare-dispatch/check:ci", external_id: "x", app: { id: APP_ID } },
            ],
            [HEAD]: [{ id: 2, name: "flare-dispatch/check:ci", external_id: "y", app: { id: 1 } }],
          },
        }),
      },
    });
    const result = await h.run(runTickUnit(sweepUnit));
    expect(result.skipped).toBeNull();
    expect(new Set(h.records().map((r) => r.sha))).toEqual(new Set([HEAD]));
    expect(h.records().every((r) => r.trigger === "webhook")).toBe(true);
  });

  it("[FD-INT-033] an installation below 30% of its quota is skipped", async () => {
    const h = await harness({
      repos: {
        [REPO]: repoWithManifest(undefined, {
          required: { main: ["flare-dispatch/check:ci"] },
          pulls: [pull(1, HEAD, 0)],
        }),
      },
    });
    const quota = await h.quota();
    await h.run(quota.observe("7", { limit: 5000, remaining: 1400 }));
    const result = await h.run(runTickUnit(sweepUnit));
    expect(result.skipped).toBe("quota below 30%");
    expect(h.executions()).toEqual([]);
    await h.run(quota.observe("7", { remaining: 1600 }));
    await h.run(runTickUnit(sweepUnit));
    expect(h.executions()).toHaveLength(2);
  });

  it("[FD-INT-067] a unit that reaches its budget returns the cursor of the unit that continues it", async () => {
    const pulls = Array.from({ length: 100 }, (_, i) =>
      pull(i, i.toString(16).padStart(40, "0"), 0),
    );
    const h = await harness({
      repos: {
        [REPO]: repoWithManifest(undefined, {
          required: { main: ["flare-dispatch/check:ci"] },
          pulls,
        }),
      },
    });
    const result = await h.run(runTickUnit(sweepUnit));
    expect(result.next).toMatchObject({ _tag: "sweep", installation: 7, repoIndex: 0 });
    expect(Effect.isEffect(runTickUnit(sweepUnit))).toBe(true);
  });
});
