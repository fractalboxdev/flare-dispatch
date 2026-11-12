// The lease a security scan's job sandbox receives on the composed control plane: the control plane Worker under
// workerd through Miniflare, on a deploy that holds the GitHub App private key, a public origin and the compile-cache
// secret. Each execution reaches its lease the way an executor's does: an operator dispatch, a signed executor socket, a
// claim. The lease of `security-gate` and of `security-rescan` names no host the sandbox could reach and carries no
// tenant-scope secret, where a `check` lease on the same plane carries the compile-cache endpoint and its token
// (specs/runs/gate.md FD-GATE-110). Deny-all egress inside a Container is mameko's (MAMEKO-ISO-021); this suite covers
// the lease the control plane sends.
import { createHmac } from "node:crypto";
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

/** The repository of the recorded pull request delivery, whose head is `1` × 40. */
const REPO = "acme/widgets";
const WEBHOOK_SECRET = "webhook-secret-for-security-gate";
const ORIGIN_HOST = "ci.example.com";
const APP_KEY =
  "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAsecuritygateappkey\n-----END RSA PRIVATE KEY-----";
const COMPILE_CACHE_SECRET = "compile-cache-secret-for-security-gate";
const CACHE_TOKEN_SECRET = "cache-token-secret-for-security-gate";

const MANIFEST = {
  version: 1,
  runs: [
    { recipe: "security-gate", triggers: ["pull_request"], params: {} },
    { recipe: "security-rescan", triggers: ["dispatch"] },
    {
      recipe: "check",
      label: "unit",
      triggers: ["dispatch"],
      params: { steps: [{ label: "unit", command: "pnpm test" }] },
    },
  ],
};

const DEV_REPOSITORY = {
  repository: REPO,
  installation: 1,
  default_branch: "main",
  head: "1".repeat(40),
  confidentiality: "non-confidential",
  files: {
    ".github/flare-dispatch.json": Buffer.from(JSON.stringify(MANIFEST)).toString("base64"),
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
      PUBLIC_ORIGIN: `https://${ORIGIN_HOST}`,
      COMPILE_CACHE_SECRET,
      CACHE_TOKEN_SECRET,
      ACCESS_TEAM_DOMAIN: team.teamDomain,
      ACCESS_AUD: AUD,
      OPERATORS: JSON.stringify([OPERATOR]),
      DISPATCHERS: JSON.stringify([OPERATOR]),
      FD_DEV_REPOSITORY: JSON.stringify(DEV_REPOSITORY),
      GITHUB_APP_PRIVATE_KEY: APP_KEY,
      WEBHOOK_SECRET,
      // The gate image a run outside the host process starts in.
      GATE_IMAGE_DIGEST: `sha256:${"9".repeat(64)}`,
    },
  });
  await plane.ready;
  return plane;
};

const sha = (n: number) => n.toString(16).padStart(40, "c");

const INPUTS: Readonly<Record<string, (s: string) => unknown>> = {
  "security-rescan": (s) => ({ repo: `https://github.com/${REPO}.git`, sha: s, ref: "refs/heads/main" }),
  check: (s) => ({
    repo: `https://github.com/${REPO}.git`,
    sha: s,
    ref: "refs/heads/main",
    steps: [{ label: "unit", command: "pnpm test" }],
  }),
};

const RECORDED_PULL_REQUEST = readFileSync(
  join(
    import.meta.dirname,
    "../../../apps/control-plane/test/e2e-local/fixtures/recordings/pull_request.opened.json",
  ),
  "utf8",
);

/**
 * Starts `run` as its trigger does: `security-gate` from a signed pull request delivery (no dispatch names it,
 * FD-IFC-093), any other run from an operator dispatch. Answers the execution it admitted.
 */
const start = async (
  plane: Miniflare,
  run: string,
  commit: string,
  headers: Readonly<Record<string, string>>,
): Promise<string> => {
  if (run === "security-gate") {
    const body = RECORDED_PULL_REQUEST;
    const delivered = await plane.dispatchFetch("http://x/v1/webhooks/github", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "GitHub-Hookshot/conformance",
        "x-github-event": "pull_request",
        "x-github-delivery": crypto.randomUUID(),
        "x-hub-signature-256": `sha256=${createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex")}`,
      },
      body,
    });
    if (delivered.status !== 202) throw new Error(`${run}: ${delivered.status} ${await delivered.text()}`);
    const { executions } = (await delivered.json()) as { executions: string[] };
    expect(executions).toHaveLength(1);
    return executions[0]!;
  }
  const admitted = await plane.dispatchFetch(`http://x/v1/dispatch/${run}`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      repository: REPO,
      sha: commit,
      ...(run === "check" ? { label: "unit" } : {}),
      inputs: INPUTS[run]!(commit),
    }),
  });
  if (admitted.status !== 202) throw new Error(`${run}: ${admitted.status} ${await admitted.text()}`);
  return ((await admitted.json()) as { execution_id: string }).execution_id;
};

/**
 * On a fresh control plane, starts `run` and claims its execution from a fresh device on the control plane's socket;
 * answers the `exec.lease` frame it granted.
 */
const leaseOf = async (run: string, n: number) => {
  const plane = await controlPlane();
  try {
    const executorId = `conf-scan-${n}`;
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
    const id = await start(plane, run, sha(n), headers);
    const socket = await connect(plane, executorId, device.keys);
    socket.send(hello(executorId));
    await socket.next("session.welcome");
    socket.send({
      type: "exec.claim",
      id: "c1",
      free: { release: 1, required: 1, interactive: 1, batch: 1 },
    });
    const frame = (await socket.next("exec.lease")) as Record<string, unknown>;
    await endStandingClaim(socket);
    expect(frame).toMatchObject({ type: "exec.lease", execution_id: id, run });
    return frame;
  } finally {
    await plane.dispose();
  }
};

/** Every string value of a JSON document, at any depth. */
const strings = (value: unknown): readonly string[] =>
  typeof value === "string"
    ? [value]
    : Array.isArray(value)
      ? value.flatMap(strings)
      : value !== null && typeof value === "object"
        ? Object.values(value).flatMap(strings)
        : [];

/** A value that addresses a host: a URL of any scheme, or an scp-style `user@host:path` remote. */
const ADDRESSES_HOST = /(?:^|[^a-z0-9+.-])[a-z][a-z0-9+.-]*:\/\/|^[^\s/@]+@[^\s/:]+:/i;

describe("the lease of a security scan's job sandbox on the composed control plane", () => {
  it("[FD-GATE-110] gives security-gate and security-rescan a lease that names no egress host and carries no tenant-scope secret", async () => {
    let n = 0;
    for (const run of ["security-gate", "security-rescan"]) {
      const lease = await leaseOf(run, ++n);
      expect(lease["credentials"]).toEqual({});
      expect(lease["cache_namespaces"]).toEqual({ read: [], write: null });
      expect(lease["upload_grant"]).toMatchObject({ cache_prefix: null, compile_cache: null });
      const sent = JSON.stringify(lease);
      for (const secret of [COMPILE_CACHE_SECRET, CACHE_TOKEN_SECRET, "securitygateappkey"])
        expect(sent).not.toContain(secret);
      expect(sent).not.toContain(ORIGIN_HOST);
      expect(sent).not.toMatch(/cc3\./);
      // Beside the repository URL its inputs name, no value of the lease names a host.
      expect(
        strings(lease).filter(
          (s) => ADDRESSES_HOST.test(s) && s !== `https://github.com/${REPO}.git`,
        ),
      ).toEqual([]);
    }
    // A `check` lease on the same deploy reaches the compile cache's host with a token.
    const check = await leaseOf("check", ++n);
    expect(JSON.stringify(check["upload_grant"])).toContain(`https://${ORIGIN_HOST}/v1/compile-cache/`);
    expect(JSON.stringify(check["upload_grant"])).toMatch(/cc3\./);
  }, 120_000);
});
