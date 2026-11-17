// The floor canary on the control plane Worker under Miniflare (specs/operability.md FD-OPS-050, MAMEKO-OPS-012 to
// MAMEKO-OPS-018): the operator's `POST /v1/ops/floor-canary` and `GET /v1/ops/floor-canary/:id` that `fd deploy`
// calls, and the minute tick's `floor-canary` unit, on a deploy that holds the launch signing key and the gate image.
import { join } from "node:path";
import { floorCanaryExecutionId, FLOOR_CANARY_PERIOD_MS } from "@fractalboxdev/mameko-coordinator";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AUD, OPERATOR, PLANE, startAccessTeam, type AccessTeam } from "./support.ts";
import { wasmModules, workerdBuild } from "./workerd-bundle.ts";

const DIGEST = `sha256:${"c".repeat(64)}`;

let team: AccessTeam;
let script: string;

/** An ES256 private JWK, as the launch signing key Worker secret holds it. */
const launchSigningKey = async (): Promise<string> => {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  return JSON.stringify(await crypto.subtle.exportKey("jwk", pair.privateKey));
};

const plane = async (extra: Record<string, string>) => {
  const mf = new Miniflare({
    modules: [{ type: "ESModule", path: "worker.js", contents: script }, ...wasmModules()],
    compatibilityDate: "2026-05-01",
    d1Databases: { DB: "control-plane" },
    durableObjects: {
      CHANNEL: { className: "ExecutorChannel", useSQLite: true },
      EXECUTION: { className: "ExecutionEngine", useSQLite: true },
      EPOCH_ANCHOR: { className: "EpochAnchor", useSQLite: true },
      MONITOR: { className: "LivenessMonitor", useSQLite: true },
      CACHE_LEDGER: { className: "CacheLedger", useSQLite: true },
    },
    r2Buckets: ["CACHE"],
    bindings: {
      DEPLOYMENT: "production",
      PLANE_ID: PLANE,
      ACCESS_TEAM_DOMAIN: team.teamDomain,
      ACCESS_AUD: AUD,
      OPERATORS: JSON.stringify([OPERATOR]),
      // An email sink with no sender bound: the alarm port records each alarm, then reports the send failed.
      ALERT_SINK: "ops@example.com",
      ...extra,
    },
  });
  await mf.ready;
  return mf;
};

const call = async (
  mf: Miniflare,
  path: string,
  init: { readonly method?: string; readonly body?: unknown; readonly identity?: string } = {},
) =>
  mf.dispatchFetch(`http://x${path}`, {
    method: init.method ?? "GET",
    headers: {
      "content-type": "application/json",
      "cf-access-jwt-assertion": await team.jwt(init.identity ?? OPERATOR),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });

const rows = async <T>(mf: Miniflare, sql: string, ...binds: unknown[]) =>
  (
    await (
      await mf.getD1Database("DB")
    )
      .prepare(sql)
      .bind(...binds)
      .all<T>()
  ).results;

let canary: Miniflare;
let bare: Miniflare;

beforeAll(async () => {
  team = await startAccessTeam();
  const bundle = await build({
    entryPoints: [join(import.meta.dirname, "../src/worker.ts")],
    bundle: true,
    format: "esm",
    platform: "browser",
    ...workerdBuild,
    write: false,
    external: ["cloudflare:*"],
  });
  script = bundle.outputFiles[0]!.text;
  canary = await plane({ LAUNCH_SIGNING_KEY: await launchSigningKey(), GATE_IMAGE_DIGEST: DIGEST });
  bare = await plane({});
});

afterAll(async () => {
  await Promise.all([canary?.dispose(), bare?.dispose()]);
  await team?.close();
});

describe("the floor canary routes", () => {
  it("[FD-OPS-050] admit one canary as a cloud-pinned ops run on a Container pool serving its class, and answer its verdict from the execution", async () => {
    const started = await call(canary, "/v1/ops/floor-canary", { method: "POST", body: {} });
    expect(started.status).toBe(202);
    const body = (await started.json()) as Record<string, string>;
    expect(body).toMatchObject({ pool: "agent", image_digest: DIGEST });
    const id = body["execution_id"]!;

    // mameko's admission wrote it as an ops run of `required`, placed on `cloudflare` alone, with no check run.
    expect(
      await rows(
        canary,
        "select run, class, scope_id, ops_run from mameko_executions where id = ?",
        id,
      ),
    ).toEqual([
      { run: "floor-canary", class: "required", scope_id: "ops:floor-canary", ops_run: 1 },
    ]);
    expect(
      await rows(canary, "select eligible_kinds from mameko_placements where execution_id = ?", id),
    ).toEqual([{ eligible_kinds: '["cloudflare"]' }]);
    expect(await rows(canary, "select kind from mameko_outbox where execution_id = ?", id)).toEqual(
      [],
    );

    const verdict = async () =>
      (await (await call(canary, `/v1/ops/floor-canary/${id}`)).json()) as Record<string, unknown>;
    expect(await verdict()).toEqual({
      execution_id: id,
      verdict: "running",
      stage: null,
      detail: null,
    });
    const db = await canary.getD1Database("DB");
    const set = (status: string, reason: string | null) =>
      db
        .prepare("update mameko_executions set status = ?, reason = ? where id = ?")
        .bind(status, reason, id)
        .run();
    await set("failure", "infra: floor-canary egress: the request answered 200");
    expect(await verdict()).toMatchObject({
      verdict: "failed",
      stage: "egress",
      detail: "the request answered 200",
    });
    await set("failure", "infra: SandboxUnavailable");
    expect(await verdict()).toMatchObject({ verdict: "inconclusive" });
    await set("success", null);
    expect(await verdict()).toMatchObject({ verdict: "passed" });
  });

  it("[FD-OPS-050] refuse a pool that runs no canary, a caller outside operators, and a deploy with no canary pool", async () => {
    const lean = await call(canary, "/v1/ops/floor-canary", {
      method: "POST",
      body: { pool: "lean" },
    });
    expect(lean.status).toBe(400);
    expect(await lean.json()).toMatchObject({ error: "invalid_body" });
    const member = await call(canary, "/v1/ops/floor-canary", {
      method: "POST",
      body: {},
      identity: "member@example.com",
    });
    expect(member.status).toBe(403);
    // Without the launch signing key the pools start no Container, so no pool runs a canary.
    const none = await call(bare, "/v1/ops/floor-canary", { method: "POST", body: {} });
    expect(none.status).toBe(400);
  });
});

describe("the floor-canary tick unit", () => {
  it("[FD-OPS-050] admits each canary pool's canary once per 2 h slot, and pages floor-canary-failed with the stage and image digest for the slot before", async () => {
    const worker = await canary.getWorker();
    // A slot after the canary the earlier test admits at the current time, so the count below holds this slot's alone.
    const slot =
      Math.floor(Date.UTC(2099, 0, 1, 8) / FLOOR_CANARY_PERIOD_MS) * FLOOR_CANARY_PERIOD_MS;
    const tick = (at: number) =>
      worker.scheduled({ cron: "* * * * *", scheduledTime: new Date(at) });
    const canaries = (at: number) =>
      ["agent", "browser"].map((pool) => floorCanaryExecutionId(pool, at));

    await tick(slot + 60_000);
    await tick(slot + 120_000);
    const first = canaries(slot);
    expect(
      await rows(
        canary,
        `select id, ops_run from mameko_executions where id in (?, ?) order by id`,
        ...first,
      ),
    ).toEqual([...first].sort().map((id) => ({ id, ops_run: 1 })));
    // The slot's later tick admits nothing more.
    expect(
      await rows<{ n: number }>(
        canary,
        "select count(*) as n from mameko_executions where run = 'floor-canary' and enqueued_at >= ?",
        slot,
      ),
    ).toEqual([{ n: 2 }]);

    await (
      await canary.getD1Database("DB")
    )
      .prepare("update mameko_executions set status = 'failure', reason = ? where id = ?")
      .bind("infra: floor-canary command: the repeat ran again: 2 lines", first[0])
      .run();
    await tick(slot + FLOOR_CANARY_PERIOD_MS + 60_000);
    expect(
      await rows(
        canary,
        "select name, severity, state, detail_json from fd_alarms where name = 'floor-canary-failed'",
      ),
    ).toEqual([
      {
        name: "floor-canary-failed",
        severity: "page",
        state: "raised",
        detail_json: JSON.stringify({
          pool: "agent",
          imageDigest: DIGEST,
          stage: "command",
          detail: "the repeat ran again: 2 lines",
          executionId: first[0],
        }),
      },
    ]);
  });
});
