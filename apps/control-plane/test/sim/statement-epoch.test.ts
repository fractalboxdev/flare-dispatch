// A device statement across a reclaim, on the control plane Worker under workerd: one device claims a dispatched
// `check` and falls silent past the liveness timeout, the monitor reclaims the lease, and a second device claims it at
// the next epoch. The statement the first device signed for its own epoch is then checked through the
// `result-acceptance-check` port the composition binds over the Worker's D1 database, whose lease, lease-record and
// `lease_nonces` rows the claims and the reclaim wrote.
import { join } from "node:path";
import {
  DSSE_PAYLOAD_TYPE,
  dssePae,
  METERING_UNAVAILABLE,
  parseProvenanceKey,
  signPae,
  statementOf,
  unsignedEnvelope,
  type StatementBody,
} from "@fractalboxdev/flare-dispatch-cache";
import type { D1Like } from "@fractalboxdev/mameko-host-cloudflare/d1";
import { ResultAcceptanceCheck } from "@fractalboxdev/mameko-ports";
import { type Context, Effect } from "effect";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isolateServices } from "../../src/composition.ts";
import type { ControlPlaneEnv } from "../../src/config.ts";
import { jwkThumbprint } from "../../src/provenance-records.ts";
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
const sha = (n: number) => `sha256:${n.toString(16).padStart(64, "0")}`;
/** The key helper's `cdhash` as the enrollment route records it: lowercase hex of 20 bytes (FD-PROV-031). */
const CODE_HASH = "4".repeat(40);
const ARTIFACT = { name: "dist/app.tgz", digest: sha(10) };

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
type Device = Awaited<ReturnType<typeof newDevice>>;

const database = async () => (await mf.getD1Database("DB")) as unknown as D1Database;

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

/**
 * Enrolls a device through the Worker's registration route and connects it. The development deployment enrolls a
 * software key without attestation (MAMEKO-LEASE-099), so the executor row then gets the attestation time and key
 * helper code hash a production enrollment's verified evidence records: checks 4 and 11 pass, and the verdict turns
 * on the lease rows alone.
 */
const enroll = async (executorId: string) => {
  const device = await newDevice();
  const registered = await mf.dispatchFetch("http://x/v1/executors/register", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "cf-access-jwt-assertion": await team.jwt(OPERATOR),
    },
    body: JSON.stringify(registration(executorId, device.identity)),
  });
  expect(registered.status).toBeLessThan(300);
  await (await database())
    .prepare("update executors set attested_at = ?, code_hash = ? where executor_id = ?")
    .bind(Date.now() - 3_600_000, CODE_HASH, executorId)
    .run();
  const socket = await connect(mf, executorId, device.keys);
  socket.send(hello(executorId));
  await socket.next("session.welcome");
  return { device, socket };
};

/** The statement envelope the device signs for its lease, over DSSE's pre-authentication encoding. */
const statement = async (device: Device, executorId: string, lease: Lease) => {
  const pub = (await crypto.subtle.exportKey("jwk", device.keys.publicKey)) as JsonWebKey;
  const priv = (await crypto.subtle.exportKey("jwk", device.keys.privateKey)) as JsonWebKey;
  const key = parseProvenanceKey(JSON.stringify({ ...priv, kid: await jwkThumbprint(pub) }))!;
  const body: StatementBody = {
    lease: {
      execution_id: lease.execution_id,
      epoch: lease.epoch,
      nonce: lease.nonce,
      executor_id: executorId,
      executor_kind: "device",
      binding_kind: "execution-lease",
      run: { name: "check", kind: "gate", definition_digest: sha(1), inputs_digest: sha(2) },
      repository: "fractalboxdev/flare-dispatch",
      ref: "refs/heads/main",
      commit_sha: SHA,
      image_digest: sha(3),
      class: "required",
      policy_version: "p-1",
      confidentiality: "non-confidential",
    },
    outcome: "success",
    commands: [{ name: "x", exit_status: 0 }],
    lockfiles: [],
    fetches: [],
    locked_dependencies: [],
    restored_cache: [],
    egress_log_digest: sha(6),
    step_log_digest: sha(7),
    models: [],
  };
  const payload = new TextEncoder().encode(
    JSON.stringify(
      statementOf(body, [{ name: ARTIFACT.name, digest: { sha256: ARTIFACT.digest.slice(7) } }], {
        code_hash: CODE_HASH,
      }),
    ),
  );
  return {
    ...unsignedEnvelope(payload),
    signatures: [await signPae(key, dssePae(DSSE_PAYLOAD_TYPE, payload))],
  };
};

/** The `result-acceptance-check` port the composition binds over the Worker's D1 database. */
const check = async (result: unknown, envelope: unknown) => {
  const env = {
    PLANE_ID: PLANE,
    DEPLOYMENT: "development",
    DB: (await mf.getD1Database("DB")) as unknown as D1Like,
  } as unknown as ControlPlaneEnv;
  const services = (await isolateServices(env)) as Context.Context<ResultAcceptanceCheck>;
  return Effect.runPromise(
    ResultAcceptanceCheck.use((port) => port.check(result, envelope)).pipe(
      Effect.provide(services),
    ),
  );
};

const submission = (lease: Lease, executorId: string) => ({
  execution_id: lease.execution_id,
  epoch: lease.epoch,
  executor_id: executorId,
  artifacts: [ARTIFACT],
});

const quarantined = async (executorId: string) =>
  (
    await (await database())
      .prepare("select quarantine from executors where executor_id = ?")
      .bind(executorId)
      .first<{ quarantine: number }>()
  )?.quarantine === 1;

describe("a device statement across a reclaim", () => {
  it("[FD-PROV-019] after the liveness reclaim, the previous holder's statement for its own epoch is rejected stale-epoch, not wrong-executor", async () => {
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

    const a = await enroll("mac-stale-a");
    const first = await claimLease(a.socket, className, id);
    const stale = await statement(a.device, "mac-stale-a", first);
    // While mac-stale-a holds the lease, its statement passes checks 1 to 11; check 12 fails closed.
    expect(await check(submission(first, "mac-stale-a"), stale)).toEqual({
      _tag: "rejected",
      reasonKind: METERING_UNAVAILABLE,
    });

    // mac-stale-a falls silent past the liveness timeout; the monitor reclaims its lease.
    const monitor = (await mf.getDurableObjectNamespace("MONITOR")) as unknown as {
      idFromName(name: string): unknown;
      get(id: unknown): { sweep(now: number): Promise<readonly string[]> };
    };
    expect(await monitor.get(monitor.idFromName("monitor")).sweep(Date.now() + 600_000)).toContain(
      id,
    );

    // mac-stale-b claims the execution at the next epoch.
    const b = await enroll("mac-stale-b");
    const second = await claimLease(b.socket, className, id);
    expect(second.epoch).toBeGreaterThan(first.epoch);
    const { results: nonces } = await (await database())
      .prepare(
        "select epoch, nonce, invalidated_at is not null as invalidated from lease_nonces where execution_id = ? order by epoch",
      )
      .bind(id)
      .all<{ epoch: number; nonce: string; invalidated: number }>();
    expect(nonces).toEqual([
      { epoch: first.epoch, nonce: first.nonce, invalidated: 1 },
      { epoch: second.epoch, nonce: second.nonce, invalidated: 0 },
    ]);

    // mac-stale-a's statement names the lease issued to mac-stale-a, at an epoch the execution has left: the check
    // answers stale-epoch and does not quarantine the previous holder as another executor's forger.
    expect(await check(submission(first, "mac-stale-a"), stale)).toEqual({
      _tag: "rejected",
      reasonKind: "provenance: stale-epoch",
    });
    expect(await quarantined("mac-stale-a")).toBe(false);

    // The current holder's statement for the current epoch passes check 7.
    const current = await statement(b.device, "mac-stale-b", second);
    expect(await check(submission(second, "mac-stale-b"), current)).toEqual({
      _tag: "rejected",
      reasonKind: METERING_UNAVAILABLE,
    });
    expect(await quarantined("mac-stale-b")).toBe(false);
  }, 60_000);
});
