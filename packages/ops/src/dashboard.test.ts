import { refusalReason } from "@fractalboxdev/flare-dispatch-agentic";
import { DASHBOARD_LINK_LIFETIME_S } from "@fractalboxdev/flare-dispatch-api/config";
import { checkLinkToken, mintLinkToken } from "@fractalboxdev/flare-dispatch-api/link-token";
import { insertOutboxRows } from "@fractalboxdev/mameko-host-cloudflare/d1";
import { newRow } from "@fractalboxdev/mameko-kernel";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recordingAlarms, sqliteDb, type TestDb } from "./d1.test-support.ts";
import {
  classFigures,
  dashboardLogLink,
  executionDetail,
  executionPath,
  fleet,
  linkConfigFrom,
  listExecutions,
  overview,
  parseExecutionQuery,
  percentile,
  raiseOnce,
  renderExecutionDetail,
  renderExecutions,
  renderFleet,
  renderOverview,
} from "./index.ts";

let t: TestDb;
beforeEach(async () => {
  t = await sqliteDb();
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
    await t.db.batch(
      Array.from({ length: 205 }, (_, i) =>
        t.db
          .prepare(
            "insert into executions (id, scope_id, run, class, status, enqueued_at) values (?, 'acme/app', 'check', 'required', 'pending', ?)",
          )
          .bind(`e${String(i).padStart(3, "0")}`, NOW - i),
      ),
    );
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

/** One outbox row of an execution, in the state and with the answer a drain left it in. */
const outboxRow = async (
  executionId: string,
  id: string,
  kind: string,
  state: string,
  lastError: string | null,
) => {
  await insertOutboxRows(t.db, [
    {
      id,
      limitKey: "7",
      tier: "effect",
      priority: 0,
      classRank: 1,
      drawsReserve: false,
      intent: {
        executionId,
        scopeId: "acme/app",
        intentKey: `cp:${kind}:${id}`,
        kind,
        payload: { executionId },
        payloadDigest: "d",
        effectClass: "adoptable",
        attempts: 0,
      },
      row: newRow({ effectClass: "adoptable", insertedAt: NOW + Number(id) }),
    },
  ]);
  await t.db
    .prepare("update outbox set state = ?, last_error = ?, attempts = 1 where id = ?")
    .bind(state, lastError, id)
    .run();
};

/** The text of each list item in the page's reason lists. */
const listedReasons = (html: string) =>
  [...html.matchAll(/<li class="mono">([^<]*)<\/li>/g)].map((m) => m[1]);

describe("execution page", () => {
  it("[FD-AGT-018] lists every reason of a refused pr.propose row under its first reason kind", async () => {
    await execution("e1", { status: "success", run: "spec-drift-pr" });
    const reason = refusalReason([
      { kind: "branch-invalid" },
      { kind: "protected-path", path: "runs/x.ts" },
      { kind: "secret-detected", path: "specs/a.md", line: 3, detail: "aws-access-key-id" },
    ]);
    await outboxRow("e1", "1", "check.conclude", "applied", null);
    await outboxRow("e1", "2", "pr.propose", "refused", reason);
    const detail = await executionDetail(t.db, "e1");
    expect(detail?.outbox.map((o) => [o.kind, o.state, o.lastError])).toEqual([
      ["check.conclude", "applied", null],
      ["pr.propose", "refused", reason],
    ]);
    const html = renderExecutionDetail(detail!, null);
    expect(html).toContain("writeback: branch-invalid<ul");
    expect(listedReasons(html)).toEqual([
      "branch-invalid",
      "protected-path runs/x.ts",
      "secret-detected specs/a.md:3 (aws-access-key-id)",
    ]);
    expect(await executionDetail(t.db, "missing")).toBeNull();
    const page = await listExecutions(t.db, {}, 50, null);
    expect(renderExecutions(page, {}, {})).toContain(`href="${executionPath("e1")}"`);
  });

  it("[FD-AGT-038] shows the reason of a refused or expired pr.propose row beside the execution's unchanged verdict", async () => {
    await execution("e1", { status: "success", run: "spec-drift-pr" });
    await outboxRow("e1", "1", "pr.propose", "expired", "writeback: read artifacts");
    let html = renderExecutionDetail((await executionDetail(t.db, "e1"))!, null);
    expect(html).toContain("<tr><th>Verdict</th><td>success</td></tr>");
    expect(html).toMatch(/<td class="notify">expired<\/td>/);
    expect(html).toContain('<span class="mono">writeback: read artifacts</span>');
    expect(listedReasons(html)).toEqual([]);

    await execution("e2", { status: "success", run: "spec-drift-pr" });
    await outboxRow("e2", "2", "pr.propose", "expired", "github createTree: 502");
    html = renderExecutionDetail((await executionDetail(t.db, "e2"))!, null);
    expect(html).toContain("<tr><th>Verdict</th><td>success</td></tr>");
    expect(html).toContain('<span class="mono">github createTree: 502</span>');

    await execution("e3", { status: "success", run: "spec-drift-pr" });
    await outboxRow("e3", "3", "pr.propose", "expired", null);
    html = renderExecutionDetail((await executionDetail(t.db, "e3"))!, null);
    expect(html).toContain("expired with no recorded reason");

    await execution("e4", { status: "success", run: "spec-drift-pr" });
    await outboxRow("e4", "4", "pr.propose", "refused", "writeback: human-commits-present");
    html = renderExecutionDetail((await executionDetail(t.db, "e4"))!, null);
    expect(html).toContain("<tr><th>Verdict</th><td>success</td></tr>");
    expect(listedReasons(html)).toEqual(["human-commits-present"]);

    const { results } = await t.db.prepare("select id, status from executions order by id").all();
    expect(results).toEqual(["e1", "e2", "e3", "e4"].map((id) => ({ id, status: "success" })));
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
  const nowS = 1_800_000_000;
  const configOf = (env: Record<string, unknown>) =>
    Effect.runPromise(linkConfigFrom({ LINK_KEY: key, ...env }, "https://fd.example.com"));
  const tokenOf = (link: string) => new URL(link).searchParams.get("t")!;
  const check = (token: string, over: Partial<Parameters<typeof checkLinkToken>[2]> = {}) =>
    checkLinkToken(key, token, {
      purpose: "logs",
      objectId: "e 1",
      nowS,
      currentEpoch: 3,
      ...over,
    });

  it("[FD-OPS-067] a dashboard link carries the API's link token for that one execution, expiring within 3600 s", async () => {
    const config = await configOf({ LINK_EPOCH: "3" });
    const link = (await Effect.runPromise(dashboardLogLink(config, "e 1", nowS)))!;
    expect(link.split("?")[0]).toBe("https://fd.example.com/v1/executions/e%201/logs");
    const token = tokenOf(link);
    expect(Number(token.split(".")[0])).toBe(nowS + DASHBOARD_LINK_LIFETIME_S);
    expect(await check(token)).toEqual({ _tag: "Granted" });
    expect(await check(token, { objectId: "e 2" })).toEqual({ _tag: "Invalid" });
    expect(await check(token, { purpose: "artifact" })).toEqual({ _tag: "Invalid" });
    expect(await check(token, { nowS: nowS + 3600 })).toEqual({ _tag: "Expired" });
    expect(await check(token, { currentEpoch: 4 })).toEqual({ _tag: "Revoked" });
    const forged = await mintLinkToken("other", {
      purpose: "logs",
      objectId: "e 1",
      expiresAtS: nowS + 60,
      epoch: 3,
    });
    expect(await check(forged)).toEqual({ _tag: "Invalid" });
    expect(
      await Effect.runPromise(
        dashboardLogLink(await configOf({ LINK_KEY: undefined }), "e 1", nowS),
      ),
    ).toBeNull();
  });

  it("[FD-IFC-019] a dashboard link lasts 3600 s, or the configured link lifetime where that is shorter", async () => {
    const expiryUnder = async (lifetime: string | undefined) =>
      Number(
        tokenOf(
          (await Effect.runPromise(
            dashboardLogLink(await configOf({ LINK_LIFETIME_S: lifetime }), "e 1", nowS),
          ))!,
        ).split(".")[0],
      ) - nowS;
    expect(await expiryUnder(undefined)).toBe(3600);
    expect(await expiryUnder("604800")).toBe(3600);
    expect(await expiryUnder("600")).toBe(600);
  });

  it("[FD-IFC-023] the dashboard refuses a link key equal to another capability secret", async () => {
    for (const name of [
      "WEBHOOK_SECRET",
      "OIDC_SIGNING_JWK",
      "PROVENANCE_KEY",
      "COMPILE_CACHE_SECRET",
      "INSTALL_STATE_KEY",
    ]) {
      const refused = await Effect.runPromise(
        Effect.result(linkConfigFrom({ LINK_KEY: key, [name]: key }, "https://fd.example.com")),
      );
      expect(refused, name).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "ConfigInvalid", issues: [`LINK_KEY: the link key equals ${name}`] },
      });
    }
    expect((await configOf({ COMPILE_CACHE_SECRET: "another" })).linkKey).toBe(key);
  });
});
