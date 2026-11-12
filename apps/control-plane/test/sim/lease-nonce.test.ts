// An execution's lease nonce across reclaims, on the control plane Worker under workerd: a device claims a dispatched
// `check`, refuses the lease, claims it again at the next epoch, falls silent past the liveness timeout and claims it a
// third time. Each grant carries a fresh nonce, and each reclaim invalidates the nonce of the epoch it ended.
import { join } from "node:path";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AUD,
  connect,
  hello,
  newDevice,
  OPERATOR,
  PLANE,
  registration,
  startAccessTeam,
  type AccessTeam,
  type Socket,
} from "../support.ts";

const SHA = "c".repeat(40);
const MANIFEST = JSON.stringify({
  version: 1,
  runs: [
    {
      recipe: "check",
      triggers: ["dispatch"],
      params: { steps: [{ label: "x", command: "true" }] },
    },
  ],
});

let team: AccessTeam;
let mf: Miniflare;

beforeAll(async () => {
  team = await startAccessTeam();
  const bundle = await build({
    entryPoints: [join(import.meta.dirname, "../../src/worker.ts")],
    bundle: true,
    format: "esm",
    platform: "browser",
    write: false,
    external: ["cloudflare:*"],
  });
  mf = new Miniflare({
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
      ACCESS_TEAM_DOMAIN: team.teamDomain,
      ACCESS_AUD: AUD,
      OPERATORS: JSON.stringify([OPERATOR]),
      DISPATCHERS: JSON.stringify([OPERATOR]),
      FD_DEV_REPOSITORY: JSON.stringify({
        repository: "fractalboxdev/flare-dispatch",
        installation: 1,
        default_branch: "main",
        head: SHA,
        confidentiality: "non-confidential",
        files: { ".github/flare-dispatch.json": Buffer.from(MANIFEST).toString("base64") },
      }),
    },
  });
  await mf.ready;
}, 60_000);

afterAll(async () => {
  await mf?.dispose();
  await team?.close();
});

type Lease = { readonly execution_id: string; readonly epoch: number; readonly nonce: string };

/** The lease-nonce rows of one execution, by epoch. */
const nonceRows = async (executionId: string) => {
  const db = await mf.getD1Database("DB");
  const { results } = await db
    .prepare(
      "select epoch, nonce, invalidated_at from lease_nonces where execution_id = ? order by epoch",
    )
    .bind(executionId)
    .all<{ epoch: number; nonce: string; invalidated_at: number | null }>();
  return results;
};

/** Claims one slot of `className` until the device holds a lease on `executionId`. */
const claimLease = async (socket: Socket, className: string, executionId: string) => {
  for (let i = 0; i < 50; i++) {
    const from = socket.received.length;
    socket.send({ type: "exec.claim", id: `c${i}`, free: { [className]: 1 } });
    for (let j = 0; j < 200; j++) {
      const frames = socket.received
        .slice(from)
        .map((f) => JSON.parse(f) as Record<string, unknown>);
      const lease = frames.find(
        (f) => f["type"] === "exec.lease" && f["execution_id"] === executionId,
      );
      if (lease !== undefined) return lease as unknown as Lease;
      if (frames.some((f) => f["type"] === "exec.idle")) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`no lease on ${executionId}`);
};

describe("an execution's lease nonce across reclaims", () => {
  it("[FD-PROV-011] each reclaim invalidates the ended epoch's nonce and the next epoch's lease carries a fresh one", async () => {
    const response = await mf.dispatchFetch("http://x/v1/dispatch/check", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "cf-access-jwt-assertion": await team.jwt(OPERATOR),
      },
      body: JSON.stringify({
        repository: "fractalboxdev/flare-dispatch",
        sha: SHA,
        inputs: {
          repo: "https://github.com/fractalboxdev/flare-dispatch.git",
          sha: SHA,
          ref: "refs/heads/main",
          steps: [{ label: "x", command: "true" }],
        },
      }),
    });
    expect(response.status).toBe(202);
    const { execution_id: id, class: className } = (await response.json()) as {
      execution_id: string;
      class: string;
    };

    const device = await newDevice();
    await mf.dispatchFetch("http://x/v1/executors/register", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "cf-access-jwt-assertion": await team.jwt(OPERATOR),
      },
      body: JSON.stringify(registration("mac-nonce", device.identity)),
    });
    const socket = await connect(mf, "mac-nonce", device.keys);
    socket.send(hello("mac-nonce"));
    await socket.next("session.welcome");

    // The first grant: 128 random bits, stored against the execution and the lease's epoch.
    const first = await claimLease(socket, className, id);
    expect(first.nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(await nonceRows(id)).toEqual([
      { epoch: first.epoch, nonce: first.nonce, invalidated_at: null },
    ]);

    // The device refuses the lease; the channel's reclaim invalidates the epoch's nonce.
    socket.send({
      type: "exec.refused",
      id: "r1",
      execution_id: id,
      epoch: first.epoch,
      reason: "slot-gone",
    });
    for (let i = 0; i < 100; i++) {
      const [row] = await nonceRows(id);
      if (row?.invalidated_at !== null) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    const [refused] = await nonceRows(id);
    expect(refused).toMatchObject({ epoch: first.epoch, nonce: first.nonce });
    expect(refused!.invalidated_at).not.toBeNull();

    // The next grant is at a later epoch with a fresh nonce.
    const second = await claimLease(socket, className, id);
    expect(second.epoch).toBeGreaterThan(first.epoch);
    expect(second.nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(second.nonce).not.toBe(first.nonce);

    // The device falls silent past the liveness timeout; the monitor's reclaim invalidates the second epoch's nonce.
    const monitor = (await mf.getDurableObjectNamespace("MONITOR")) as unknown as {
      idFromName(name: string): unknown;
      get(id: unknown): { sweep(now: number): Promise<readonly string[]> };
    };
    const swept = await monitor.get(monitor.idFromName("monitor")).sweep(Date.now() + 600_000);
    expect(swept).toContain(id);
    expect((await nonceRows(id)).at(-1)).toMatchObject({
      epoch: second.epoch,
      nonce: second.nonce,
      invalidated_at: expect.any(Number),
    });
    const third = await claimLease(socket, className, id);
    expect(third.epoch).toBeGreaterThan(second.epoch);
    expect(new Set([first.nonce, second.nonce, third.nonce]).size).toBe(3);

    const rows = await nonceRows(id);
    expect(rows.map((r) => [r.epoch, r.nonce, r.invalidated_at !== null])).toEqual([
      [first.epoch, first.nonce, true],
      [second.epoch, second.nonce, true],
      [third.epoch, third.nonce, false],
    ]);
  }, 60_000);
});
