import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { freshDb, recordingAlarms, type TestDb } from "./d1.test-support.ts";
import {
  classFigures,
  DASHBOARD_LINK_TTL_S,
  dashboardLink,
  fleet,
  listExecutions,
  mintLinkToken,
  overview,
  parseExecutionQuery,
  percentile,
  raiseOnce,
  renderExecutions,
  renderFleet,
  renderOverview,
  verifyLinkToken,
} from "./index.ts";

let t: TestDb;
beforeEach(async () => {
  t = await freshDb();
});
afterEach(() => t.dispose());

const NOW = 1_800_000_000_000;

const execution = (id: string, over: Partial<Record<string, unknown>> = {}) =>
  t.db
    .prepare(
      "insert into executions (id, scope_id, run, class, status, enqueued_at) values (?, ?, ?, ?, ?, ?)",
    )
    .bind(
      id,
      over["scope_id"] ?? "acme/app",
      over["run"] ?? "check",
      over["class"] ?? "required",
      over["status"] ?? "pending",
      over["enqueued_at"] ?? NOW,
    )
    .run();

const executor = (
  id: string,
  kind: string,
  slots: Record<string, number>,
  flags = { drain: 0, quarantine: 0 },
) =>
  t.db
    .prepare(
      "insert into executors (executor_id, kind, posture_tier, labels_json, slots_json, last_heartbeat_at, drain, quarantine) values (?, ?, 'unmanaged', '[]', ?, ?, ?, ?)",
    )
    .bind(id, kind, JSON.stringify(slots), NOW - 5_000, flags.drain, flags.quarantine)
    .run();

const placement = (executionId: string, executorId: string | null, state = "leased", epoch = 1) =>
  t.db
    .prepare("insert into placements (execution_id, state, epoch, executor_id) values (?, ?, ?, ?)")
    .bind(executionId, state, epoch, executorId)
    .run();

describe("executions view", () => {
  it("[FD-OPS-068] filters by run, repository, class, status and executor kind, with each execution's placement and cost", async () => {
    await executor("dev-1", "device", { batch: 5 });
    await execution("e1", {
      run: "check",
      class: "required",
      status: "running",
      enqueued_at: NOW - 3,
    });
    await execution("e2", {
      run: "lint",
      class: "batch",
      status: "success",
      enqueued_at: NOW - 2,
      scope_id: "acme/web",
    });
    await execution("e3", {
      run: "check",
      class: "interactive",
      status: "pending",
      enqueued_at: NOW - 1,
    });
    await placement("e1", "dev-1", "leased", 2);
    await t.db
      .prepare(
        "insert into reservations (execution_id, class, hold_micro_usd, state, metered_micro_usd, updated_at) values ('e1', 'required', 5000, 'settled', 4200, 0)",
      )
      .run();
    const all = await listExecutions(t.db, {}, 50, null);
    expect(all.rows.map((r) => r.id)).toEqual(["e3", "e2", "e1"]);
    expect(all.rows[2]).toEqual({
      id: "e1",
      run: "check",
      repository: "acme/app",
      class: "required",
      status: "running",
      reason: null,
      enqueuedAt: NOW - 3,
      placement: "leased",
      epoch: 2,
      executorId: "dev-1",
      executorKind: "device",
      holdMicroUsd: 5000,
      settledMicroUsd: 4200,
    });
    const ids = async (f: Parameters<typeof listExecutions>[1]) =>
      (await listExecutions(t.db, f, 50, null)).rows.map((r) => r.id);
    expect(await ids({ run: "check" })).toEqual(["e3", "e1"]);
    expect(await ids({ repository: "acme/web" })).toEqual(["e2"]);
    expect(await ids({ class: "interactive" })).toEqual(["e3"]);
    expect(await ids({ status: "running" })).toEqual(["e1"]);
    expect(await ids({ executorKind: "device" })).toEqual(["e1"]);
  });

  it("[FD-OPS-068] pages with a keyset cursor at 50 by default and at most 200 rows", async () => {
    for (let i = 0; i < 205; i++)
      await execution(`e${String(i).padStart(3, "0")}`, { enqueued_at: NOW - i });
    const q = (search: string) => parseExecutionQuery(new URL(`https://x/${search}`));
    expect(q("").limit).toBe(50);
    expect(q("?limit=500").limit).toBe(200);
    expect(q("?limit=0").limit).toBe(50);
    const first = await listExecutions(t.db, {}, 200, null);
    expect(first.rows).toHaveLength(200);
    const second = await listExecutions(t.db, {}, 200, first.next);
    expect(second.rows.map((r) => r.id)).toEqual(["e200", "e201", "e202", "e203", "e204"]);
    expect(second.next).toBeNull();
  });

  it("[FD-OPS-069] the executions routes return no input payload and no secret value", async () => {
    await t.db
      .prepare(
        "create table if not exists execution_inputs (execution_id text primary key, inputs_json text)",
      )
      .run();
    await execution("e1");
    await t.db
      .prepare("insert into execution_inputs values ('e1', '{\"token\":\"ghs_secret\"}')")
      .run();
    const page = await listExecutions(t.db, {}, 50, null);
    const text = JSON.stringify(page) + renderExecutions(page, {}, {});
    expect(text).not.toContain("ghs_secret");
    expect(Object.keys(page.rows[0]!)).not.toContain("inputs");
  });
});

describe("overview", () => {
  it("[FD-OPS-070] per class: queue depth, queue age p50 and p95, placement rate by executor kind over 24 h, alarms and control state", async () => {
    for (let i = 1; i <= 20; i++)
      await execution(`q${i}`, { class: "batch", enqueued_at: NOW - i * 1000 });
    await executor("dev-1", "device", { batch: 5 });
    await execution("p1", { class: "batch", status: "running", enqueued_at: NOW - 3_600_000 });
    await execution("p2", { class: "batch", status: "running", enqueued_at: NOW - 3_600_000 });
    await execution("old", { class: "batch", status: "success", enqueued_at: NOW - 90_000_000 });
    await placement("p1", "dev-1");
    await placement("p2", "cf-container-1");
    await placement("old", "dev-1");
    const [batch] = await classFigures(t.db, ["batch"], NOW);
    expect(batch).toEqual({
      class: "batch",
      queueDepth: 20,
      queueAgeP50Ms: 10_000,
      queueAgeP95Ms: 19_000,
      placementRate: { device: 0.5, unregistered: 0.5 },
    });
    expect(percentile([], 50)).toBeNull();
    const { layer } = recordingAlarms();
    await Effect.runPromise(
      raiseOnce(
        t.db,
        {
          name: "placement-stalled",
          severity: "page",
          dedupeKey: "placement-stalled",
          detail: null,
        },
        NOW,
      ).pipe(Effect.provide(layer)),
    );
    const o = await overview(t.db, ["release", "required", "interactive", "batch"], NOW);
    expect(o.classes.map((c) => c.class)).toEqual(["release", "required", "interactive", "batch"]);
    expect(o.alarms).toEqual([
      expect.objectContaining({ name: "placement-stalled", runbook: "R6" }),
    ]);
    expect(o.controlState).toBeNull();
    const html = renderOverview(o);
    expect(html).toContain("placement-stalled");
    expect(html).toContain("R6");
  });
});

describe("fleet view", () => {
  it("[FD-OPS-071] each executor's kind, heartbeat age, drain and quarantine flags, and slots in use and in total per class", async () => {
    await executor("dev-1", "device", { required: 2, batch: 5 }, { drain: 1, quarantine: 0 });
    await execution("e1", { class: "batch", status: "running" });
    await execution("e2", { class: "batch", status: "running" });
    await placement("e1", "dev-1");
    await placement("e2", "dev-1");
    expect(await fleet(t.db, NOW)).toEqual([
      {
        executorId: "dev-1",
        kind: "device",
        heartbeatAgeMs: 5_000,
        drain: true,
        quarantine: false,
        slots: { batch: { inUse: 2, total: 5 }, required: { inUse: 0, total: 2 } },
      },
    ]);
    expect(renderFleet(await fleet(t.db, NOW))).toContain("batch 2/5");
  });
});

describe("link tokens", () => {
  const key = "link-key-material";
  it("[FD-OPS-067] a dashboard link carries a token for that one object that expires within 3600 s", async () => {
    const nowS = 1_800_000_000;
    const link = await dashboardLink({
      linkKey: key,
      purpose: "log",
      id: "e1",
      path: "/v1/executions/e1/logs/run.log",
      nowSeconds: nowS,
      epoch: 3,
    });
    const token = decodeURIComponent(link.split("?t=")[1]!);
    expect(Number(token.split(".")[0])).toBe(nowS + DASHBOARD_LINK_TTL_S);
    const verify = (over: Partial<Parameters<typeof verifyLinkToken>[0]>) =>
      Effect.runPromise(
        Effect.result(
          verifyLinkToken({
            linkKey: key,
            purpose: "log",
            id: "e1",
            token,
            nowSeconds: nowS,
            currentEpoch: 3,
            ...over,
          }),
        ),
      );
    expect(await verify({})).toMatchObject({ _tag: "Success" });
    expect(await verify({ id: "e2" })).toMatchObject({
      _tag: "Failure",
      failure: { code: "forbidden" },
    });
    expect(await verify({ purpose: "artifact" })).toMatchObject({
      _tag: "Failure",
      failure: { code: "forbidden" },
    });
    expect(await verify({ nowSeconds: nowS + 3600 })).toMatchObject({
      _tag: "Failure",
      failure: { code: "link_expired" },
    });
    expect(await verify({ currentEpoch: 4 })).toMatchObject({
      _tag: "Failure",
      failure: { code: "link_revoked" },
    });
    const forged = await mintLinkToken({
      linkKey: "other",
      purpose: "log",
      id: "e1",
      expiresAt: nowS + 60,
      epoch: 3,
    });
    expect(await verify({ token: forged })).toMatchObject({
      _tag: "Failure",
      failure: { code: "forbidden" },
    });
  });
});
