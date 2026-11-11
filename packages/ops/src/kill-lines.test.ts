import { VERDICT_AUDIT_SCHEMA } from "@fractalboxdev/flare-dispatch-cache";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recordingAlarms, sqliteDb, type TestDb } from "./d1.test-support.ts";
import { KILL_LINE_RISKS, killLineMonitor, readKillLines } from "./kill-lines.ts";

const DAY = 86_400_000;
const NOW = 400 * DAY;

let t: TestDb;
beforeEach(async () => {
  t = await sqliteDb();
});
afterEach(() => t.dispose());

let n = 0;
/** One concluded execution and its accepted placement: `ms` from enqueue to verdict, accepted on `kind`. */
const verdict = async (
  run: string,
  kind: string,
  ms: number,
  over: { cls?: string; finishedAt?: number; eligible?: readonly string[] | null } = {},
) => {
  const id = `e${n++}`;
  const finishedAt = over.finishedAt ?? NOW - DAY;
  await t.db
    .prepare(
      "insert into executions (id, scope_id, run, class, status, enqueued_at, finished_at) values (?, 'acme/app', ?, ?, 'success', ?, ?)",
    )
    .bind(id, run, over.cls ?? "required", finishedAt - ms, finishedAt)
    .run();
  const eligible = over.eligible === undefined ? null : over.eligible;
  await t.db
    .prepare(
      "insert into placements (execution_id, state, epoch, accepted_kind, eligible_kinds) values (?, 'accepted', 1, ?, ?)",
    )
    .bind(id, kind, eligible === null ? null : JSON.stringify(eligible))
    .run();
};

const audit = async (device: string, cold: string, at = NOW - DAY) => {
  await t.db.prepare(VERDICT_AUDIT_SCHEMA).run();
  await t.db
    .prepare(
      `insert into verdict_audits (device_execution_id, device_executor_id, audit_execution_id, audit_executor_id,
       device_verdict, audit_verdict, recorded_at) values (?, 'dev', ?, 'cloud', ?, ?, ?)`,
    )
    .bind(`d${n}`, `a${n++}`, device, cold, at)
    .run();
};

const lines = () => Effect.runPromise(readKillLines(t.db, NOW));
const line = async (risk: string) => (await lines()).find((l) => l.risk === risk)!;

const monitor = (now = NOW) => {
  const alarms = recordingAlarms();
  const run = (at = now) =>
    Effect.runPromise(killLineMonitor(t.db, at).pipe(Effect.provide(alarms.layer)));
  return { alarms, run };
};

describe("kill-line monitor", () => {
  it("[FD-VER-030] a device median less than 30% below the best cloud setup raises kill-line naming the risk, the metric, its value and the threshold", async () => {
    // The cloud verdicts were not eligible for a device, so the availability line reads 100%.
    for (const ms of [80_000, 80_000, 80_000]) await verdict("check", "device", ms);
    for (const ms of [100_000, 100_000, 100_000])
      await verdict("check", "cloudflare-sandbox", ms, { eligible: ["cloudflare-sandbox"] });
    await verdict("check", "gha", 200_000, { eligible: ["gha"] });
    const { alarms, run } = monitor();
    const report = await run();
    expect(alarms.delivered).toEqual([
      {
        name: "kill-line",
        severity: "notify",
        state: "raised",
        dedupeKey: `kill-line:${KILL_LINE_RISKS.warmState}`,
        detail: {
          risk: KILL_LINE_RISKS.warmState,
          metric: "device median time to verdict below the best cloud setup, % (run check)",
          value: 20,
          threshold: 30,
        },
      },
    ]);
    expect(report.raised).toEqual([{ risk: KILL_LINE_RISKS.warmState, result: "sent" }]);
    const stored = (
      await t.db.prepare("select state from fd_alarms where name = 'kill-line'").all()
    ).results;
    expect(stored).toEqual([{ state: "raised" }]);
  });

  it("[FD-VER-030] a device median at least 30% below the best cloud setup raises nothing", async () => {
    await verdict("check", "device", 60_000);
    await verdict("check", "cloudflare-sandbox", 100_000);
    const { alarms, run } = monitor();
    await run();
    expect(alarms.delivered).toEqual([]);
    expect(await line(KILL_LINE_RISKS.warmState)).toMatchObject({ value: 40, crossed: false });
  });

  it("[FD-VER-030] the warm-state reading is the run that saves least, and samples outside 14 days or not required do not count", async () => {
    await verdict("check", "device", 50_000);
    await verdict("check", "cloudflare-sandbox", 100_000);
    await verdict("oxlint", "device", 9_000);
    await verdict("oxlint", "cloudflare-sandbox", 10_000);
    await verdict("e2e", "device", 1_000, { cls: "batch" });
    await verdict("e2e", "cloudflare-sandbox", 100_000, { cls: "batch" });
    await verdict("check", "device", 500_000, { finishedAt: NOW - 15 * DAY });
    expect(await line(KILL_LINE_RISKS.warmState)).toEqual({
      risk: KILL_LINE_RISKS.warmState,
      metric: "device median time to verdict below the best cloud setup, % (run oxlint)",
      value: 10,
      threshold: 30,
      crossed: true,
    });
  });

  it("[FD-VER-030] devices taking under 50% of eligible executions over 30 days raise kill-line", async () => {
    // Eligible: two on a device, three on a cloud kind; the cloud-only placements and the old one are not eligible.
    await verdict("e2e", "device", 1, { cls: "batch", eligible: ["device", "cloudflare-sandbox"] });
    await verdict("e2e", "device", 1, { cls: "batch", eligible: null });
    for (let i = 0; i < 3; i++)
      await verdict("e2e", "cloudflare-sandbox", 1, {
        cls: "batch",
        eligible: ["device", "cloudflare-sandbox"],
      });
    for (let i = 0; i < 5; i++)
      await verdict("pr-review", "cloudflare-sandbox", 1, {
        cls: "batch",
        eligible: ["cloudflare-sandbox"],
      });
    for (let i = 0; i < 5; i++)
      await verdict("e2e", "cloudflare-sandbox", 1, {
        cls: "batch",
        eligible: null,
        finishedAt: NOW - 31 * DAY,
      });
    const { alarms, run } = monitor();
    await run();
    expect(alarms.delivered.map((a) => a.detail)).toEqual([
      {
        risk: KILL_LINE_RISKS.availability,
        metric: "eligible executions taken by owned devices over 30 days, %",
        value: 40,
        threshold: 50,
      },
    ]);
  });

  it("[FD-VER-030] more than one verdict audit disagreement in 7 days raises kill-line; one does not", async () => {
    await audit("failure", "success", NOW - 8 * DAY);
    expect(await line(KILL_LINE_RISKS.flaky)).toEqual({
      risk: KILL_LINE_RISKS.flaky,
      reason:
        "no verdict audit disagreement recorded in the last 7 days (the table records disagreements only)",
    });
    await audit("success", "failure");
    expect(await line(KILL_LINE_RISKS.flaky)).toMatchObject({ value: 1, crossed: false });
    await audit("failure", "success");
    const { alarms, run } = monitor();
    await run();
    expect(alarms.delivered.map((a) => a.detail)).toEqual([
      {
        risk: KILL_LINE_RISKS.flaky,
        metric: "verdict audit disagreements over 7 days",
        value: 2,
        threshold: 1,
      },
    ]);
  });

  it("[FD-VER-030] a required p95 more than 60 s above the cloud-only p95 over 14 days raises kill-line", async () => {
    // 20 cloud verdicts at 100 s and 4 device verdicts at 200 s: the p95 of all is 200 s, cloud-only 100 s. The device
    // verdicts are slower than cloud, so the warm-state line is crossed too.
    for (let i = 0; i < 20; i++) await verdict("check", "cloudflare-sandbox", 100_000);
    for (let i = 0; i < 4; i++) await verdict("check", "device", 200_000);
    const { alarms, run } = monitor();
    await run();
    expect(alarms.delivered.map((a) => a.detail)).toContainEqual({
      risk: KILL_LINE_RISKS.requiredSlowdown,
      metric: "required p95 time to verdict above cloud-only p95 over 14 days, s",
      value: 100,
      threshold: 60,
    });
  });

  it("[FD-VER-030] a line with no samples, an unreadable table or no metric raises nothing and says why", async () => {
    const { alarms, run } = monitor();
    const report = await run();
    expect(alarms.delivered).toEqual([]);
    expect(report.lines.map((l) => [l.risk, "reason" in l ? l.reason : null])).toEqual([
      [
        KILL_LINE_RISKS.warmState,
        "no required run reached a verdict both on an owned device and on a cloud setup",
      ],
      [
        KILL_LINE_RISKS.availability,
        "no execution eligible for an owned device concluded in the last 30 days",
      ],
      [KILL_LINE_RISKS.toil, "no record counts manual interventions on a device"],
      [KILL_LINE_RISKS.flaky, expect.stringMatching(/^cannot be read: .*verdict_audits/)],
      [
        KILL_LINE_RISKS.requiredSlowdown,
        "no required execution reached a verdict on a cloud setup in the last 14 days",
      ],
      [KILL_LINE_RISKS.productFit, "an operator decision, not a metric"],
    ]);
  });

  it("[FD-VER-030] a crossed line is sent again at most once per 24 h, and a later reading under the line leaves it raised", async () => {
    await verdict("check", "device", 90_000);
    await verdict("check", "cloudflare-sandbox", 100_000);
    const { alarms, run } = monitor();
    await run(NOW);
    await run(NOW + 60_000);
    expect(alarms.delivered).toHaveLength(1);
    await run(NOW + DAY);
    expect(alarms.delivered).toHaveLength(2);
    // Faster device verdicts move the median 50% below cloud: the line is no longer crossed, and only the operator
    // resolves the notification.
    for (let i = 0; i < 4; i++) await verdict("check", "device", 50_000);
    const report = await run(NOW + 2 * DAY);
    expect(report.lines.find((l) => l.risk === KILL_LINE_RISKS.warmState)).toMatchObject({
      crossed: false,
    });
    expect(alarms.delivered.map((a) => a.state)).toEqual(["raised", "raised"]);
    const stored = (
      await t.db.prepare("select state from fd_alarms where name = 'kill-line'").all()
    ).results;
    expect(stored).toEqual([{ state: "raised" }]);
  });
});
