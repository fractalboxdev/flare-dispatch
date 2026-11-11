// The credential boundary on the composed control plane: the control plane Worker under workerd through Miniflare,
// on a deploy that holds the GitHub App private key. An execution reaches its lease the way a device's does: an
// operator dispatch, a signed executor socket, a claim. Whatever the recorded inputs carry, no `exec.lease` leaves the
// control plane with a write credential in it (specs/runs/agentic.md § Credential boundary).
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
} from "../../../apps/control-plane/test/support.ts";

const REPO = "fractalboxdev/flare-dispatch";
const APP_KEY =
  "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAconformanceappkey\n-----END RSA PRIVATE KEY-----";
const INSTALLATION_TOKEN = `ghs_${"C".repeat(36)}`;

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
let script: string;

beforeAll(async () => {
  team = await startAccessTeam();
  const bundle = await build({
    entryPoints: [join(import.meta.dirname, "../../../apps/control-plane/src/worker.ts")],
    bundle: true,
    format: "esm",
    platform: "browser",
    write: false,
    external: ["cloudflare:*"],
  });
  script = bundle.outputFiles[0]!.text;
}, 120_000);

afterAll(async () => {
  await team?.close();
});

/** A fresh control plane per claim: a grant that fails leaves its placement leased until the lease expires. */
const controlPlane = async () => {
  const plane = new Miniflare({
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
      DEPLOYMENT: "development",
      PLANE_ID: PLANE,
      PUBLIC_ORIGIN: "https://ci.example.com",
      COMPILE_CACHE_SECRET: "compile-cache-secret-for-conformance",
      CACHE_TOKEN_SECRET: "cache-token-secret-for-conformance",
      ACCESS_TEAM_DOMAIN: team.teamDomain,
      ACCESS_AUD: AUD,
      OPERATORS: JSON.stringify([OPERATOR]),
      DISPATCHERS: JSON.stringify([OPERATOR]),
      FD_DEV_REPOSITORY: JSON.stringify(DEV_REPOSITORY),
      // The App's private key alone: the deploy holds it, and with no App id it reads the captured repository.
      GITHUB_APP_PRIVATE_KEY: APP_KEY,
    },
  });
  await plane.ready;
  return plane;
};

let claims = 0;

type Claimed = { readonly id: string; readonly frame: Record<string, unknown> };

/**
 * On a fresh control plane, dispatches `check` once per entry of `inputs`, records `inputs[i](dispatched)` as that
 * execution's inputs, and claims it from a fresh device on the control plane's socket. Answers, per claim, the
 * `exec.lease` it granted or the `session.error` that ended it.
 */
const claimsWith = async (
  ...inputs: readonly ((dispatched: Record<string, unknown>) => unknown)[]
): Promise<readonly Claimed[]> => {
  const plane = await controlPlane();
  try {
    const claimed: Claimed[] = [];
    for (const input of inputs) claimed.push(await claimOn(plane, ++claims, input));
    return claimed;
  } finally {
    await plane.dispose();
  }
};

const claimOn = async (
  plane: Miniflare,
  n: number,
  inputs: (dispatched: Record<string, unknown>) => unknown,
): Promise<Claimed> => {
  const executorId = `conf-boundary-${n}`;
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
  const sha = n.toString(16).padStart(40, "b");
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
  const { execution_id: id } = (await admitted.json()) as {
    execution_id: string;
  };
  const db = (await plane.getD1Database("DB")) as unknown as D1Database;
  const row = await db
    .prepare("select inputs_json from intake_records where execution_id = ?")
    .bind(id)
    .first<{ inputs_json: string }>();
  await db
    .prepare("update intake_records set inputs_json = ? where execution_id = ?")
    .bind(JSON.stringify(inputs(JSON.parse(row!.inputs_json))), id)
    .run();
  await db
    .prepare("update executions set deadline_at = ? where id = ?")
    .bind(Date.now() + 3_600_000, id)
    .run();
  const socket = await connect(plane, executorId, device.keys);
  socket.send(hello(executorId));
  await socket.next("session.welcome");
  socket.send({ type: "exec.claim", id: "c1", free: { batch: 1 } });
  // The claim answers one of the two; the other wait times out and is dropped.
  const frame = await Promise.race(
    ["exec.lease", "session.error"].map((type) =>
      socket.next(type).catch(() => new Promise<never>(() => {})),
    ),
  );
  await endStandingClaim(socket);
  return { id, frame };
};

const INSTALLATION_TOKEN_SHAPE = /\bghs_[A-Za-z0-9]{20,}/;
const PEM_PRIVATE_KEY = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/;

const asRecorded = (d: Record<string, unknown>) => d;

/** The lease a clean execution was granted holds neither the App private key nor an installation token. */
const expectCleanLease = ({ id, frame }: Claimed) => {
  expect(frame).toMatchObject({ type: "exec.lease", execution_id: id });
  const sent = JSON.stringify(frame);
  expect(sent).not.toContain("conformanceappkey");
  expect(sent).not.toMatch(PEM_PRIVATE_KEY);
  expect(sent).not.toMatch(INSTALLATION_TOKEN_SHAPE);
};

describe("the lease the composed control plane grants", () => {
  it("[FD-AGT-008] fails the grant, and sends no exec.lease, when the lease payload would carry the App private key", async () => {
    const [clean, leaking] = await claimsWith(asRecorded, (d) => ({
      ...d,
      steps: [{ label: "leak", command: `printf '%s' '${APP_KEY}' > key.pem` }],
    }));
    expectCleanLease(clean!);
    expect(leaking!.frame).toMatchObject({ type: "session.error" });
    expect(String(leaking!.frame["message"])).toContain("CredentialInPayload");
    expect(JSON.stringify(leaking!.frame)).not.toContain("conformanceappkey");
  }, 60_000);

  it("[FD-AGT-008] fails the grant, and sends no exec.lease, when the lease payload would carry an installation token", async () => {
    const [clean, leaking] = await claimsWith(asRecorded, (d) => ({
      ...d,
      steps: [
        {
          label: "push",
          command: `git push https://x-access-token:${INSTALLATION_TOKEN}@github.com/${REPO}`,
        },
      ],
    }));
    expectCleanLease(clean!);
    expect(leaking!.frame).toMatchObject({ type: "session.error" });
    expect(String(leaking!.frame["message"])).toContain("CredentialInPayload");
    expect(JSON.stringify(leaking!.frame)).not.toContain(INSTALLATION_TOKEN);
  }, 60_000);
});
