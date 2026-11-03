// The control plane Worker on workerd through Miniflare: the bindings of `wrangler.jsonc`, the router, admission, the
// lease path and the record. The executor here is the test's own signed WebSocket; `pnpm dogfood` proves the real
// device executor.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AUD,
  connect,
  endStandingClaim,
  hello,
  newDevice,
  OPERATOR,
  PLANE,
  registration,
  startAccessTeam,
  type AccessTeam,
} from "./support.ts";

const SHA = "a".repeat(40);

/** The repository the development deployment reads: this one, at one commit. */
const DEV_REPOSITORY = {
  repository: "fractalboxdev/flare-dispatch",
  installation: 1,
  default_branch: "main",
  head: "f".repeat(40),
  files: {
    ".github/flare-dispatch.json": readFileSync(
      join(import.meta.dirname, "../../../.github/flare-dispatch.json"),
    ).toString("base64"),
  },
};

let team: AccessTeam;
let script: string;
let development: Miniflare;
let production: Miniflare;
let unconfigured: Miniflare;

const miniflare = (deployment: string, access: boolean) =>
  new Miniflare({
    modules: [{ type: "ESModule", path: "worker.js", contents: script }],
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
      DEPLOYMENT: deployment,
      CACHE_TOKEN_SECRET: "cache-token-secret-for-tests",
      PLANE_ID: PLANE,
      ...(access
        ? {
            ACCESS_TEAM_DOMAIN: team.teamDomain,
            ACCESS_AUD: AUD,
            OPERATORS: JSON.stringify([OPERATOR]),
            DISPATCHERS: JSON.stringify([OPERATOR]),
            FD_DEV_REPOSITORY: JSON.stringify(DEV_REPOSITORY),
          }
        : {}),
    },
  });

beforeAll(async () => {
  team = await startAccessTeam();
  const bundle = await build({
    entryPoints: [join(import.meta.dirname, "../src/worker.ts")],
    bundle: true,
    format: "esm",
    platform: "browser",
    write: false,
    external: ["cloudflare:*"],
  });
  script = bundle.outputFiles[0]!.text;
  development = miniflare("development", true);
  production = miniflare("production", true);
  unconfigured = miniflare("production", false);
  await Promise.all([development.ready, production.ready, unconfigured.ready]);
});

afterAll(async () => {
  await Promise.all([development?.dispose(), production?.dispose(), unconfigured?.dispose()]);
  await team?.close();
});

/** `identity` is an Access identity, `null` for none, or `invalid` for a token no key of the team signed. */
const headersFor = async (identity: string | null): Promise<Record<string, string>> =>
  identity === null
    ? {}
    : {
        "cf-access-jwt-assertion":
          identity === "invalid" ? "e30.e30.c2ln" : await team.jwt(identity),
      };

const post = async (
  mf: Miniflare,
  path: string,
  body: unknown,
  identity: string | null = OPERATOR,
) =>
  mf.dispatchFetch(`http://x${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(await headersFor(identity)) },
    body: JSON.stringify(body),
  });

const execution = async (mf: Miniflare, id: string) => {
  const r = await mf.dispatchFetch(`http://x/v1/executions/${id}`, {
    headers: await headersFor(OPERATOR),
  });
  return (await r.json()) as Record<string, unknown>;
};

const dispatchBody = (sha: string) => ({
  repository: "fractalboxdev/flare-dispatch",
  sha: /^[0-9a-f]{40}$/.test(sha) ? sha : SHA,
  inputs: {
    repo: "https://github.com/fractalboxdev/flare-dispatch",
    sha,
    ref: "main",
    steps: [{ label: "test", command: "pnpm test" }],
  },
});

describe("the identity gate", () => {
  it("FD-IFC-014 answers not_configured with no Access team set", async () => {
    const r = await post(unconfigured, "/v1/dispatch/check", dispatchBody(SHA));
    expect(r.status).toBe(503);
    expect(await r.json()).toMatchObject({ error: "not_configured" });
  });

  it("FD-IFC-027 refuses a dispatch with no identity and with a token the team did not sign", async () => {
    expect((await post(development, "/v1/dispatch/nothing", {}, null)).status).toBe(401);
    expect((await post(development, "/v1/dispatch/nothing", {}, "invalid")).status).toBe(401);
  });

  it("FD-IFC-012 refuses an Access token outside operators on an operator route", async () => {
    const { identity } = await newDevice();
    const r = await post(
      development,
      "/v1/executors/register",
      registration("stranger", identity),
      "member@example.com",
    );
    expect(r.status).toBe(403);
  });

  it("serves health without identity and names the deployment", async () => {
    const r = await unconfigured.dispatchFetch("http://x/health");
    expect(await r.json()).toEqual({ status: "ok", deployment: "production", plane_id: PLANE });
  });
});

describe("the minute tick", () => {
  it("FD-INT-050 records the tick and starts the liveness monitor", async () => {
    const worker = await unconfigured.getWorker();
    const at = Date.now();
    await worker.scheduled({ cron: "* * * * *", scheduledTime: new Date(at) });
    const db = await unconfigured.getD1Database("DB");
    await expect
      .poll(
        async () =>
          (await db.prepare("select at from fd_liveness where key = 'tick'").all()).results,
      )
      .toEqual([{ at }]);
  });

  it("FD-OPS-036 serves the liveness report to an operator", async () => {
    const r = await development.dispatchFetch("http://x/v1/ops/health", {
      headers: await headersFor(OPERATOR),
    });
    expect(r.status).toBe(200);
  });
});

describe("the cache, artifact and log routes", () => {
  it("FD-CACHE-083 serves an execution's logs to a member and nothing without a token or identity", async () => {
    expect((await development.dispatchFetch("http://x/v1/executions/01ABC/logs")).status).toBe(404);
    const r = await development.dispatchFetch("http://x/v1/executions/01ABC/logs", {
      headers: await headersFor(OPERATOR),
    });
    expect(r.status).toBe(404);
  });

  it("FD-CACHE-051 refuses a compile-cache request without a signing secret", async () => {
    const r = await development.dispatchFetch("http://x/v1/compile-cache/acme/widgets/ns/key");
    expect(r.status).toBe(503);
  });
});

describe("a production deployment", () => {
  it("MAMEKO-ISO-001 leaves a host execution out of the catalogue", async () => {
    const r = await post(production, "/v1/dispatch/check", dispatchBody(SHA));
    expect(r.status).toBe(404);
    expect(await r.json()).toMatchObject({ error: "run_not_found" });
  });

  it("FD-IFC-087 refuses a software key and writes no executor row", async () => {
    const { identity } = await newDevice();
    const r = await post(production, "/v1/executors/register", registration("mac", identity));
    expect(r.status).toBe(403);
    const body = (await r.json()) as { error: string; message: string };
    expect(body.error).toBe("registration_refused");
    expect(body.message).toContain("key-store");
    const db = await production.getD1Database("DB");
    expect((await db.prepare("select * from executors").all()).results).toEqual([]);
  });
});

describe("a development deployment", () => {
  it("FD-IFC-028 answers run_not_found for a run outside the catalogue", async () => {
    const r = await post(development, "/v1/dispatch/nothing", dispatchBody(SHA));
    expect(r.status).toBe(404);
    expect(await r.json()).toMatchObject({ error: "run_not_found" });
  });

  it("FD-IFC-028 answers run_not_found for a run and label the repository's manifest does not list", async () => {
    const r = await post(development, "/v1/dispatch/check", {
      ...dispatchBody(SHA),
      label: "nightly",
    });
    expect(r.status).toBe(404);
    expect(await r.json()).toMatchObject({ error: "run_not_found" });
  });

  it("FD-INT-022 refuses a webhook on a deployment that holds no webhook secret", async () => {
    const r = await development.dispatchFetch("http://x/v1/webhooks/github", {
      method: "POST",
      headers: { "content-type": "application/json", "x-github-event": "ping" },
      body: "{}",
    });
    expect(r.status).toBe(503);
    expect(await r.json()).toMatchObject({ error: "webhook_unconfigured" });
  });

  it("FD-IFC-029 answers invalid_inputs for a body that fails the run's schema", async () => {
    const r = await post(development, "/v1/dispatch/check", dispatchBody("not-a-sha"));
    expect(r.status).toBe(400);
    expect(await r.json()).toMatchObject({ error: "invalid_inputs" });
  });

  it("FD-IFC-086 enrolls a software key, and an upgrade with another key is refused", async () => {
    const { identity } = await newDevice();
    const stranger = await newDevice();
    const r = await post(development, "/v1/executors/register", registration("mac-1", identity));
    expect(r.status).toBe(201);
    expect(await r.json()).toMatchObject({ executor_id: "mac-1", posture_tier: "unmanaged" });
    await expect(connect(development, "mac-1", stranger.keys)).rejects.toThrow("no socket: 403");
  });

  it("carries one execution from dispatch through the lease to the record, and a duplicate reuses it", async () => {
    const device = await newDevice();
    await post(development, "/v1/executors/register", registration("mac-2", device.identity));
    const sha = "b".repeat(40);
    const admitted = await post(development, "/v1/dispatch/check", dispatchBody(sha));
    expect(admitted.status).toBe(202);
    const { execution_id: id, class: className } = (await admitted.json()) as {
      execution_id: string;
      class: string;
    };
    expect(className).toBe("batch");
    expect(await execution(development, id)).toMatchObject({ status: "queued", verdict: null });
    const repeat = await post(development, "/v1/dispatch/check", dispatchBody(sha));
    expect(await repeat.json()).toMatchObject({ execution_id: id, duplicate: true });

    const socket = await connect(development, "mac-2", device.keys);
    socket.send(hello("mac-2"));
    await socket.next("session.welcome");
    socket.send({ type: "exec.claim", id: "c1", free: { batch: 1 } });
    const lease = await socket.next("exec.lease");
    expect(lease).toMatchObject({
      execution_id: id,
      run: "check",
      run_version: "2.0.0",
      class: "batch",
      scope_id: "fractalboxdev/flare-dispatch",
      inputs: dispatchBody(sha).inputs,
      credentials: {},
    });
    const epoch = lease["epoch"];
    // A device restores the device and content tiers and writes none for a dispatch (FD-CACHE-016).
    expect(lease["upload_grant"]).toMatchObject({
      cache_prefix: null,
      artifact_prefix: `artifacts/${id}/${String(epoch)}/`,
      log_prefix: `logs/${id}/${String(epoch)}/`,
      compile_cache: null,
    });
    expect((lease["cache_namespaces"] as { write: unknown }).write).toBeNull();
    await expect.poll(() => execution(development, id)).toMatchObject({ status: "running" });
    socket.send({
      type: "exec.result",
      id: "r1",
      execution_id: id,
      epoch,
      result_id: `${id}:${String(epoch)}`,
      outcome: { status: "failure", reason: "finding: test: exit 1" },
      usage: {},
      artifacts: [],
    });
    expect(await socket.next("exec.result.ack")).toMatchObject({ status: "accepted" });
    await expect
      .poll(() => execution(development, id), { timeout: 20_000 })
      .toMatchObject({
        execution_id: id,
        run: "check",
        class: "batch",
        status: "done",
        verdict: "failure",
        reason: "finding: test: exit 1",
        epoch,
        accepted_epoch: epoch,
        executor_id: "mac-2",
      });
    await endStandingClaim(socket);
  });

  it("wakes a connected device's standing claim when a dispatch is admitted", async () => {
    const device = await newDevice();
    await post(development, "/v1/executors/register", registration("mac-3", device.identity));
    const socket = await connect(development, "mac-3", device.keys);
    socket.send(hello("mac-3"));
    await socket.next("session.welcome");
    socket.send({ type: "exec.claim", id: "c1", free: { batch: 1 } });
    await socket.next("exec.idle");
    const admitted = await post(development, "/v1/dispatch/check", dispatchBody("c".repeat(40)));
    const { execution_id: id } = (await admitted.json()) as { execution_id: string };
    expect(await socket.next("exec.lease")).toMatchObject({ execution_id: id });
    await endStandingClaim(socket);
  });

  it.each([
    [
      "skipped",
      { status: "skipped", reason: "draft-pr" },
      "skipped",
      "not-applicable: draft-pr",
      "d",
    ],
    ["cancelled", { status: "cancelled", reason: "superseded" }, "cancelled", "superseded", "e"],
  ])(
    "MAMEKO-RUN-046 records a run's %s outcome as itself",
    async (name, outcome, verdict, reason, shaChar) => {
      const device = await newDevice();
      const executor = `mac-${name}`;
      await post(development, "/v1/executors/register", registration(executor, device.identity));
      const admitted = await post(
        development,
        "/v1/dispatch/check",
        dispatchBody(shaChar.repeat(40)),
      );
      const { execution_id: id } = (await admitted.json()) as { execution_id: string };
      const socket = await connect(development, executor, device.keys);
      socket.send(hello(executor));
      await socket.next("session.welcome");
      socket.send({ type: "exec.claim", id: "c1", free: { batch: 1 } });
      const lease = await socket.next("exec.lease");
      socket.send({
        type: "exec.result",
        id: "r1",
        execution_id: id,
        epoch: lease["epoch"],
        result_id: `${id}:${String(lease["epoch"])}`,
        outcome,
        usage: {},
        artifacts: [],
      });
      expect(await socket.next("exec.result.ack")).toMatchObject({ status: "accepted" });
      await expect
        .poll(() => execution(development, id), { timeout: 20_000 })
        .toMatchObject({ status: "done", verdict, reason });
      await endStandingClaim(socket);
    },
  );
});
