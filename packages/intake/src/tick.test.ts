// The minute tick: planning units, the scheduled runs of a minute and the missed-webhook sweep.
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { catalogRuns } from "./catalog.ts";
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
import { enqueueUnits, planTick, runQueuedUnit, runTickUnit, type TickUnit } from "./tick.ts";

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

  it("[FD-INT-053] a tick fired twice for one minute creates at most one execution per run, label and repository", async () => {
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

describe("improve-pr schedules", () => {
  const dimension = (name: string, measure: string) => ({
    name,
    measure,
    better: "lower",
    materialityFloor: 10,
    verify: "pnpm test",
  });
  const improve = manifest([
    {
      recipe: "improve-pr",
      label: "size",
      triggers: ["cron"],
      params: { dimension: dimension("size", "node scripts/size.js") },
      schedules: [{ cron: "0 3 * * *" }],
    },
    {
      recipe: "improve-pr",
      label: "lint",
      triggers: ["cron"],
      params: { dimension: dimension("lint", "pnpm lint --count") },
      schedules: [{ cron: "0 3 * * *", branch: "develop" }],
    },
  ]);

  it("[FD-AGT-060] [FD-INT-052] each manifest dimension's schedule starts one improve-pr execution for that dimension, targeting the branch it pins", async () => {
    const h = await harness({
      settings: { catalog: catalogRuns("development") },
      repos: { [REPO]: repoWithManifest(improve, { branches: { main: BASE, develop: HEAD } }) },
    });
    const unit: TickUnit = {
      _tag: "schedules",
      installation: 7,
      scheduledAt: at(3, 0),
      repoIndex: 0,
    };
    const result = await h.run(runTickUnit(unit));
    expect(result.outcome.executions).toHaveLength(2);
    expect(
      h.records().map((r) => [r.run, r.label, r.sha, JSON.parse(r.inputs_json as string)]),
    ).toEqual([
      [
        "improve-pr",
        "size",
        BASE,
        { baseBranch: "main", dimension: dimension("size", "node scripts/size.js") },
      ],
      [
        "improve-pr",
        "lint",
        HEAD,
        { baseBranch: "develop", dimension: dimension("lint", "pnpm lint --count") },
      ],
    ]);
    expect(h.rows("select canonical from dedup_keys order by canonical")).toEqual([
      { canonical: `improve-pr:lint:${REPO}:cron:2026-11-04T03:00:00.000Z` },
      { canonical: `improve-pr:size:${REPO}:cron:2026-11-04T03:00:00.000Z` },
    ]);
    const again = await h.run(runTickUnit(unit));
    expect(again.outcome.duplicate).toBe(true);
    expect(h.executions()).toHaveLength(2);
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

  it("[FD-INT-032] the unit that continues a sweep resumes at the next pull request, so all 100 heads are submitted", async () => {
    const pulls = Array.from({ length: 120 }, (_, i) =>
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
    const units: TickUnit[] = [sweepUnit];
    for (let unit = units.shift(); unit !== undefined; unit = units.shift()) {
      const result = await h.run(runTickUnit(unit));
      if (result.next !== null) units.push(result.next);
    }
    const checked = new Set(
      h
        .records()
        .filter((r) => r.run === "check")
        .map((r) => r.sha),
    );
    expect(checked).toEqual(new Set(pulls.slice(0, 100).map((p) => p.head.sha)));
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

/** A Durable Object's storage in memory; `fire` clears the alarm as the platform does before it runs `alarm()`. */
const memoryStorage = () => {
  const data = new Map<string, unknown>();
  let alarm: number | null = null;
  return {
    get: async (key: string) => structuredClone(data.get(key)),
    put: async (key: string, value: unknown) => void data.set(key, structuredClone(value)),
    getAlarm: async () => alarm,
    setAlarm: async (at: number) => void (alarm = at),
    alarm: () => alarm,
    fire: () => {
      const at = alarm;
      alarm = null;
      return at;
    },
  };
};

/** Forty labelled `nightly` entries, each answering `pull_request` and every minute's cron. */
const wide = manifest(
  Array.from({ length: 40 }, (_, i) => ({
    recipe: "nightly",
    label: `n${i}`,
    triggers: ["pull_request", "cron"],
    schedules: [{ cron: "* * * * *" }],
  })),
);

describe("unit budgets and the unit queue", () => {
  const sweepUnit: TickUnit = {
    _tag: "sweep",
    installation: 7,
    scheduledAt: at(12, 0),
    repoIndex: 0,
    pullsSeen: 0,
  };

  it("[FD-INT-067] a sweep stops within 500 D1 queries and its continuations submit every head", async () => {
    const pulls = Array.from({ length: 60 }, (_, i) =>
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
    const units: TickUnit[] = [sweepUnit];
    const spent: number[] = [];
    const stops: (string | null)[] = [];
    for (let unit = units.shift(); unit !== undefined; unit = units.shift()) {
      const before = h.db.queries();
      const result = await h.run(runTickUnit(unit));
      spent.push(h.db.queries() - before);
      stops.push(result.stoppedAt);
      if (result.next !== null) units.push(result.next);
    }
    expect(stops[0]).toBe("d1-queries");
    expect(spent.length).toBeGreaterThan(1);
    expect(Math.max(...spent)).toBeLessThanOrEqual(500);
    expect(
      new Set(
        h
          .records()
          .filter((r) => r.run === "check")
          .map((r) => r.sha),
      ),
    ).toEqual(new Set(pulls.map((p) => p.head.sha)));
  });

  it("[FD-INT-067] a pull request whose submissions pass the budget is continued at its next submission", async () => {
    const h = await harness({
      repos: {
        [REPO]: repoWithManifest(wide, {
          required: { main: ["flare-dispatch/nightly:n0"] },
          pulls: [pull(1, HEAD, 0)],
        }),
      },
    });
    const first = await h.run(runTickUnit(sweepUnit));
    expect(first.stoppedAt).toBe("d1-queries");
    expect(first.next).toMatchObject({
      repoIndex: 0,
      pullIndex: 0,
      pullsSeen: 0,
    });
    const made = h.records().length;
    expect(first.next).toMatchObject({ submitted: made });
    let units = 1;
    for (let next = first.next; next !== null; units++) {
      const before = h.db.queries();
      next = (await h.run(runTickUnit(next))).next;
      expect(h.db.queries() - before).toBeLessThanOrEqual(500);
    }
    expect(units).toBeGreaterThan(2);
    expect(new Set(h.records().map((r) => r.label)).size).toBe(40);
    expect(h.executions()).toHaveLength(40);
  });

  it("[FD-INT-067] the queue runs one unit per alarm, queues its continuation and reaches every repository", async () => {
    const names = ["acme/a", "acme/b", "acme/c", "acme/d"];
    const repos = Object.fromEntries(
      names.map((r) => [
        r,
        repoWithManifest(wide, {
          required: { main: ["flare-dispatch/nightly:n0"] },
          pulls: [1, 2, 3].map((n) => ({
            ...pull(n, `${r.slice(-1)}${n}`.padEnd(40, "0"), 0),
            head: {
              sha: `${r.slice(-1)}${n}`.padEnd(40, "0"),
              ref: `f${n}`,
              repo: { full_name: r },
            },
            base: { ref: "main", repo: { full_name: r } },
          })),
        }),
      ]),
    );
    const h = await harness({
      repos,
      installations: Object.fromEntries(names.map((r) => [r, 7])),
    });
    const storage = memoryStorage();
    const planned = planTick(at(12, 0), [7]);
    expect(planned.map((u) => u._tag)).toEqual(["schedules", "sweep"]);
    expect(await h.run(enqueueUnits(storage, planned, at(12, 0)))).toBe(2);
    // The same minute's tick fired again adds nothing.
    expect(await h.run(enqueueUnits(storage, planned, at(12, 0)))).toBe(0);
    expect(storage.alarm()).toBe(at(12, 0));
    let alarms = 0;
    while (storage.fire() !== null) {
      const before = h.db.queries();
      const ran = await h.run(runQueuedUnit(storage, at(12, 0)));
      expect(h.db.queries() - before).toBeLessThanOrEqual(500);
      expect(ran).toMatchObject({ _tag: "Ran" });
      alarms++;
    }
    expect(alarms).toBeGreaterThan(8);
    expect(await h.run(runQueuedUnit(storage, at(12, 0)))).toBeNull();
    const count = (trigger: string) =>
      Object.fromEntries(
        names.map((r) => [
          r,
          h.records().filter((x) => x.repo === r && x.trigger === trigger).length,
        ]),
      );
    // A cron execution is one per (run, label, repository, minute), so each of the 40 labelled entries submits one;
    // the sweep submits all 40 entries for each of 3 heads.
    expect(count("cron")).toEqual(Object.fromEntries(names.map((r) => [r, 40])));
    expect(count("webhook")).toEqual(Object.fromEntries(names.map((r) => [r, 120])));
    // About a second alone; the suite's simulation runs beside it.
  }, 30_000);

  it("[FD-INT-067] a unit that fails moves to the back of the queue and leaves it after three attempts", async () => {
    const h = await harness({ repos: { [REPO]: repoWithManifest(nightly) } });
    // The installation's repository listing throws, so every run of the unit dies.
    Object.assign(h.reads, {
      installations: new Proxy(
        {},
        {
          ownKeys: () => {
            throw new Error("listing failed");
          },
        },
      ),
    });
    const storage = memoryStorage();
    const unit: TickUnit = {
      _tag: "schedules",
      installation: 7,
      scheduledAt: at(3, 0),
      repoIndex: 0,
    };
    await h.run(enqueueUnits(storage, [unit], at(3, 0)));
    const runs = [];
    for (let i = 0; i < 3; i++) {
      storage.fire();
      runs.push(await h.run(runQueuedUnit(storage, at(3, 0))));
      // A failed unit alone in its queue retries 30 s later; the last attempt leaves no alarm.
      expect(storage.alarm()).toBe(i < 2 ? at(3, 0) + 30_000 : null);
    }
    expect(runs).toEqual([
      { _tag: "Failed", unit, attempts: 1, dropped: false },
      { _tag: "Failed", unit, attempts: 2, dropped: false },
      { _tag: "Failed", unit, attempts: 3, dropped: true },
    ]);
    expect(await h.run(runQueuedUnit(storage, at(3, 0)))).toBeNull();
  });

  it("[FD-INT-067] a unit enqueued while an alarm's unit runs stays queued", async () => {
    const h = await harness({ repos: { [REPO]: repoWithManifest(nightly) } });
    // The running unit's default-branch read waits until the clock moves, so the next minute's enqueue runs meanwhile.
    h.reads.delays.set(`defaultBranch ${REPO}`, 1_000);
    const storage = memoryStorage();
    const first: TickUnit = {
      _tag: "schedules",
      installation: 7,
      scheduledAt: at(3, 0),
      repoIndex: 0,
    };
    const second: TickUnit = { ...first, scheduledAt: at(3, 1) };
    await h.run(enqueueUnits(storage, [first], at(3, 0)));
    storage.fire();
    const running = h.run(runQueuedUnit(storage, at(3, 0)));
    while (!h.reads.calls.includes(`defaultBranch ${REPO}`))
      await new Promise((r) => setImmediate(r));
    expect(await h.run(enqueueUnits(storage, [second], at(3, 1)))).toBe(1);
    await h.adjust(1_000);
    expect(await running).toMatchObject({ _tag: "Ran", unit: first });
    expect(await storage.get("units")).toEqual([{ unit: second, attempts: 0 }]);
    expect(storage.alarm()).toBe(at(3, 0));
  });
});
