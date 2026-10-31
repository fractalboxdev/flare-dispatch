// The control plane Worker on workerd through Miniflare: the bindings of `wrangler.jsonc`, admission, the lease path and
// the record. The executor here is the test's own signed WebSocket; `pnpm dogfood` proves the real device executor.
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { connectMessage, CONNECT_HEADERS } from "@fractalboxdev/mameko-coordinator";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const TOKEN = "test-operator-token";
const PLANE = "flare-dispatch";
const SHA = "a".repeat(40);

type Keys = { readonly publicKey: CryptoKey; readonly privateKey: CryptoKey };

const base64 = (bytes: ArrayBuffer | Uint8Array) =>
  Buffer.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)).toString("base64");

const newDevice = async () => {
  const keys = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as Keys;
  return {
    keys,
    identity: {
      public_key: base64((await crypto.subtle.exportKey("spki", keys.publicKey)) as ArrayBuffer),
      key_store: "software",
      certificate_chain: [],
      evidence: null,
    },
  };
};

const miniflare = (script: string, deployment: string, token: string | undefined) =>
  new Miniflare({
    modules: [{ type: "ESModule", path: "worker.js", contents: script }],
    compatibilityDate: "2026-05-01",
    d1Databases: { DB: "control-plane" },
    durableObjects: {
      CHANNEL: { className: "ExecutorChannel", useSQLite: true },
      EXECUTION: { className: "ExecutionEngine", useSQLite: true },
      EPOCH_ANCHOR: { className: "EpochAnchor", useSQLite: true },
      MONITOR: { className: "LivenessMonitor", useSQLite: true },
    },
    bindings: {
      DEPLOYMENT: deployment,
      PLANE_ID: PLANE,
      ...(token === undefined ? {} : { OPERATOR_TOKEN: token }),
    },
  });

let script: string;
let development: Miniflare;
let production: Miniflare;
let unconfigured: Miniflare;

beforeAll(async () => {
  const bundle = await build({
    entryPoints: [join(import.meta.dirname, "../src/worker.ts")],
    bundle: true,
    format: "esm",
    platform: "browser",
    write: false,
    external: ["cloudflare:*"],
  });
  script = bundle.outputFiles[0]!.text;
  development = miniflare(script, "development", TOKEN);
  production = miniflare(script, "production", TOKEN);
  unconfigured = miniflare(script, "production", undefined);
  await Promise.all([development.ready, production.ready, unconfigured.ready]);
});

afterAll(async () => {
  await Promise.all([development?.dispose(), production?.dispose(), unconfigured?.dispose()]);
});

const post = (mf: Miniflare, path: string, body: unknown, token: string | null = TOKEN) =>
  mf.dispatchFetch(`http://x${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(body),
  });

const execution = async (mf: Miniflare, id: string, query = "") => {
  const r = await mf.dispatchFetch(`http://x/v1/executions/${id}${query}`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  return (await r.json()) as Record<string, unknown>;
};

const registration = (executorId: string, identity: unknown) => ({
  executor_id: executorId,
  identity,
  labels: [],
  protocol_version: "1",
  code_hash: null,
});

const dispatchBody = (sha: string) => ({
  repository: "fractalboxdev/flare-dispatch",
  inputs: {
    repo: "https://github.com/fractalboxdev/flare-dispatch",
    sha,
    ref: "main",
    steps: [{ label: "test", command: "pnpm test" }],
  },
});

/** A device's signed upgrade: the connect signature `routeExecutorUpgrade` verifies. */
const connect = async (executorId: string, keys: Keys) => {
  const path = "/v1/executors/connect";
  const nonce = randomBytes(32).toString("hex");
  const at = Date.now();
  const message = await connectMessage({
    method: "GET",
    path,
    executorId,
    planeId: PLANE,
    connectAt: at,
    nonce,
  });
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    keys.privateKey,
    new Uint8Array(message),
  );
  const response = await development.dispatchFetch(`http://x${path}`, {
    headers: {
      Upgrade: "websocket",
      [CONNECT_HEADERS.executorId]: executorId,
      [CONNECT_HEADERS.at]: String(at),
      [CONNECT_HEADERS.nonce]: nonce,
      [CONNECT_HEADERS.signature]: base64(signature),
    },
  });
  const ws = response.webSocket;
  if (ws === null || ws === undefined) throw new Error(`no socket: ${response.status}`);
  const frames: Record<string, unknown>[] = [];
  ws.accept();
  ws.addEventListener("message", (e) => void frames.push(JSON.parse(String(e.data))));
  return {
    send: (m: unknown) => ws.send(JSON.stringify(m)),
    next: async (type: string) => {
      for (let i = 0; i < 1000; i++) {
        const frame = frames.find((f) => f["type"] === type);
        if (frame !== undefined) {
          frames.splice(frames.indexOf(frame), 1);
          return frame;
        }
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error(`no ${type}; received ${JSON.stringify(frames)}`);
    },
  };
};

const hello = (executorId: string) => ({
  type: "session.hello",
  id: "h1",
  executor_id: executorId,
  plane_id: PLANE,
  boot_id: "b",
  executor_version: "t",
  versions: { min: 1, max: 1 },
  held: [],
  capacity: null,
  in_use: {},
  outbox_depth: 0,
});

describe("the operator gate", () => {
  it("FD-IFC-014 answers not_configured with no operator identity set", async () => {
    const r = await post(unconfigured, "/v1/dispatch/check", dispatchBody(SHA));
    expect(r.status).toBe(503);
    expect(await r.json()).toMatchObject({ error: "not_configured" });
  });

  it("FD-IFC-013 and FD-IFC-012 reject a missing and a wrong token before any route logic", async () => {
    expect((await post(development, "/v1/dispatch/nothing", {}, null)).status).toBe(401);
    expect((await post(development, "/v1/dispatch/nothing", {}, "wrong")).status).toBe(403);
  });

  it("serves health without identity and names the deployment", async () => {
    const r = await unconfigured.dispatchFetch("http://x/health");
    expect(await r.json()).toEqual({ status: "ok", deployment: "production", plane_id: PLANE });
  });
});

describe("a production deployment", () => {
  it("MAMEKO-ISO-001 refuses a host execution", async () => {
    const r = await post(production, "/v1/dispatch/check", dispatchBody(SHA));
    expect(r.status).toBe(403);
    expect(await r.json()).toMatchObject({ error: "forbidden" });
  });

  it("FD-IFC-087 refuses a software key and writes no executor row", async () => {
    const { identity } = await newDevice();
    const r = await post(production, "/v1/executors/register", registration("mac", identity));
    expect(r.status).toBe(403);
    expect(await r.json()).toMatchObject({
      error: "registration_refused",
      message: "registration refused: key-store",
    });
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

  it("FD-IFC-029 answers invalid_inputs for a body that fails the run's schema", async () => {
    const r = await post(development, "/v1/dispatch/check", dispatchBody("not-a-sha"));
    expect(r.status).toBe(400);
    expect(await r.json()).toMatchObject({ error: "invalid_inputs" });
  });

  it("FD-IFC-041 answers invalid_wait for a wait out of range", async () => {
    const r = await development.dispatchFetch("http://x/v1/executions/x?wait=61", {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(r.status).toBe(400);
  });

  it("FD-IFC-086 enrolls a software key, and an upgrade with another key is refused", async () => {
    const { identity } = await newDevice();
    const stranger = await newDevice();
    const r = await post(development, "/v1/executors/register", registration("mac-1", identity));
    expect(r.status).toBe(201);
    expect(await r.json()).toEqual({ executor_id: "mac-1", posture_tier: "unmanaged" });
    await expect(connect("mac-1", stranger.keys)).rejects.toThrow("no socket: 403");
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
    expect(await repeat.json()).toEqual({ execution_id: id, class: "batch", duplicate: true });

    const socket = await connect("mac-2", device.keys);
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
    expect(await execution(development, id, "?wait=20")).toEqual({
      execution_id: id,
      run: "check",
      class: "batch",
      status: "done",
      verdict: "failure",
      reason: "finding: test: exit 1",
      epoch,
      accepted_epoch: epoch,
      executor_id: "mac-2",
      outcome_intents: 1,
    });
    // A heartbeat ends this device's standing claim, so the next test's dispatch wakes only that test's device.
    socket.send({
      type: "exec.heartbeat",
      id: "hb1",
      leases: [],
      in_use: {},
      activity: "unknown",
      memory_pressure: "unknown",
      thermal: "unknown",
      power: "unknown",
      free_disk_bytes: 0,
      teardowns: [],
    });
    await socket.next("exec.heartbeat.ack");
  });

  it("wakes a connected device's standing claim when a dispatch is admitted", async () => {
    const device = await newDevice();
    await post(development, "/v1/executors/register", registration("mac-3", device.identity));
    const socket = await connect("mac-3", device.keys);
    socket.send(hello("mac-3"));
    await socket.next("session.welcome");
    socket.send({ type: "exec.claim", id: "c1", free: { batch: 1 } });
    await socket.next("exec.idle");
    const admitted = await post(development, "/v1/dispatch/check", dispatchBody("c".repeat(40)));
    const { execution_id: id } = (await admitted.json()) as { execution_id: string };
    expect(await socket.next("exec.lease")).toMatchObject({ execution_id: id });
  });
});
