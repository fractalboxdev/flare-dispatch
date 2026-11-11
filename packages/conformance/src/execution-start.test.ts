// A deferred class's workflow start on the composed control plane: the control plane Worker under workerd through
// Miniflare, with its D1 database and its DO-SQLite `ExecutionEngine`, whose object also records the order of the
// `start` and `grantLease` calls it receives (recording-engine.ts). A `batch` execution reaches its lease the way a
// device's does: an operator dispatch, a signed executor socket, a claim.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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
} from "../../../apps/control-plane/test/support.ts";
import type { RecordedCall } from "./recording-engine.ts";

const REPO = "fractalboxdev/flare-dispatch";

const DEV_REPOSITORY = {
  repository: REPO,
  installation: 1,
  default_branch: "main",
  head: "f".repeat(40),
  confidentiality: "non-confidential",
  files: {
    ".github/flare-dispatch.json": readFileSync(
      join(import.meta.dirname, "../../../.github/flare-dispatch.json"),
    ).toString("base64"),
  },
};

let team: AccessTeam;
let plane: Miniflare;

beforeAll(async () => {
  team = await startAccessTeam();
  const bundle = await build({
    entryPoints: [join(import.meta.dirname, "recording-engine.ts")],
    bundle: true,
    format: "esm",
    platform: "browser",
    write: false,
    external: ["cloudflare:*"],
  });
  plane = new Miniflare({
    modules: [{ type: "ESModule", path: "worker.js", contents: bundle.outputFiles[0]!.text }],
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
      DEPLOYMENT: "development",
      PLANE_ID: PLANE,
      PUBLIC_ORIGIN: "https://ci.example.com",
      ACCESS_TEAM_DOMAIN: team.teamDomain,
      ACCESS_AUD: AUD,
      OPERATORS: JSON.stringify([OPERATOR]),
      DISPATCHERS: JSON.stringify([OPERATOR]),
      FD_DEV_REPOSITORY: JSON.stringify(DEV_REPOSITORY),
    },
  });
  await plane.ready;
}, 120_000);

afterAll(async () => {
  await plane?.dispose();
  await team?.close();
});

const db = async () => (await plane.getD1Database("DB")) as unknown as D1Database;

/** The execution's `ExecutionEngine` object: the calls it received and its journal's workflow count. */
const engineOf = async (id: string) => {
  const ns = await plane.getDurableObjectNamespace("EXECUTION");
  const stub = ns.get(ns.idFromName(id)) as unknown as {
    recorded(): Promise<{ readonly calls: readonly RecordedCall[]; readonly journaled: number }>;
  };
  return stub.recorded();
};

const executionRow = async (id: string) =>
  (await (await db())
    .prepare("select class, status, started_at, engine_started_at from executions where id = ?")
    .bind(id)
    .first<{
      class: string;
      status: string;
      started_at: number | null;
      engine_started_at: number | null;
    }>())!;

describe("a deferred class's workflow start on the composed control plane", () => {
  it(
    "[FD-ARCH-019] the executor channel starts a batch execution's workflow in its DO-SQLite ExecutionEngine at the winning claim, before it grants the lease",
    async () => {
      const executorId = "conf-start-1";
      const device = await newDevice();
      const headers = {
        "content-type": "application/json",
        "cf-access-jwt-assertion": await team.jwt(OPERATOR),
      };
      const enrolled = await plane.dispatchFetch("http://x/v1/executors/register", {
        method: "POST",
        headers,
        body: JSON.stringify(registration(executorId, device.identity)),
      });
      expect(enrolled.status).toBe(201);
      const sha = "d".repeat(40);
      const admitted = await plane.dispatchFetch("http://x/v1/dispatch/check", {
        method: "POST",
        headers,
        body: JSON.stringify({
          repository: REPO,
          sha,
          inputs: {
            repo: `https://github.com/${REPO}`,
            sha,
            ref: "main",
            steps: [{ label: "test", command: "pnpm test" }],
          },
        }),
      });
      expect(admitted.status).toBe(202);
      const { execution_id: id } = (await admitted.json()) as { execution_id: string };
      await (await db())
        .prepare("update executions set deadline_at = ? where id = ?")
        .bind(Date.now() + 3_600_000, id)
        .run();

      // Admission leaves a batch execution's workflow unstarted.
      expect(await executionRow(id)).toMatchObject({
        class: "batch",
        status: "pending",
        engine_started_at: null,
      });
      expect(await engineOf(id)).toEqual({ calls: [], journaled: 0 });

      const socket = await connect(plane, executorId, device.keys);
      socket.send(hello(executorId));
      await socket.next("session.welcome");
      socket.send({ type: "exec.claim", id: "c1", free: { batch: 1 } });
      const lease = (await socket.next("exec.lease")) as unknown as {
        readonly execution_id: string;
        readonly epoch: number;
      };
      expect(lease.execution_id).toBe(id);
      await endStandingClaim(socket);

      // The claim started the workflow in the execution's object, then granted the lease there.
      const engine = await engineOf(id);
      expect(engine.calls.map((c) => c.call)).toEqual(["start", "grantLease"]);
      expect(engine.calls[0]!.detail).toMatchObject({
        executionId: id,
        className: "batch",
        deadlineOutcome: "deferred",
      });
      expect(engine.calls[1]!.detail).toMatchObject({ epoch: lease.epoch, executorId });
      expect(engine.journaled).toBe(1);
      // The workflow on the object's journal takes the lease and moves the execution to `running` on D1.
      await vi.waitFor(
        async () =>
          expect(await executionRow(id)).toMatchObject({
            status: "running",
            started_at: expect.any(Number),
          }),
        { timeout: 10_000 },
      );
    },
    60_000,
  );
});
