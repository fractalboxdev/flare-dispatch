// A Container lease's read of the control plane as the Worker serves it: `ci-triage-pr`'s `ExecutionsRead` over the
// executions list and the log aggregate, under the control-plane read token the control plane mints into the lease's
// `credentials` and the egress proxy attaches as the bearer (specs/interfaces.md FD-IFC-102, FD-IFC-103).
import { join } from "node:path";
import { executionsApiReadLayer, ExecutionsRead } from "@fractalboxdev/flare-dispatch-agentic";
import { lookupRun, type CatalogEntry } from "@fractalboxdev/flare-dispatch-catalog";
import { buildProfile } from "@fractalboxdev/flare-dispatch-profile";
import { launchGrants, mintGrants } from "@fractalboxdev/mameko-host-cloudflare";
import { migratedD1 } from "@fractalboxdev/flare-dispatch-intake/testing";
import { Effect } from "effect";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CONTROL_PLANE_READ_CREDENTIAL,
  leaseReadCredentials,
  signControlPlaneReadToken,
  verifyControlPlaneRead,
} from "../src/control-plane-read.ts";
import type { ControlPlaneEnv } from "../src/config.ts";
import { router } from "../src/http.ts";
import { revokeLeaseCredentials } from "../src/lease.ts";
import { mintPoolCredential, poolSettings } from "../src/pools.ts";
import { signModelLeaseToken } from "../src/model-gateway.ts";
import { AUD, OPERATOR, PLANE, startAccessTeam, type AccessTeam } from "./support.ts";
import { wasmModules, workerdBuild } from "./workerd-bundle.ts";

const SECRET = "control-plane-read-secret";
const REPO = "acme/app";
const OTHER_REPO = "acme/other";
/** The `ci-triage-pr` execution whose lease reads. */
const LEASE = "01JREADLEASE0000000000000A";
/** A failed execution of the lease's repository, and one of another repository. */
const OWN_FAILURE = "01JREADOWNFAIL00000000000A";
const OTHER_FAILURE = "01JREADOTHERFAIL0000000000";
/** A lease of `pr-review`, a run that reads no executions. */
const REVIEW = "01JREADREVIEW0000000000000";
const NOW = Date.now();
const DEADLINE = NOW + 30 * 60_000;

let team: AccessTeam;
let mf: Miniflare;

const db = () => mf.getD1Database("DB");

const insertExecution = async (
  id: string,
  row: { repo: string; run: string; status: string; reason?: string; finishedAt?: number },
) => {
  const d = await db();
  await d
    .prepare(
      `insert into mameko_executions (id, scope_id, run, class, status, reason, enqueued_at, deadline_at, finished_at)
       values (?, ?, ?, 'batch', ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      row.repo,
      row.run,
      row.status,
      row.reason ?? null,
      NOW - 60_000,
      DEADLINE,
      row.finishedAt ?? null,
    )
    .run();
  await d
    .prepare(
      "insert into mameko_placements (execution_id, state, epoch, executor_id) values (?, 'leased', 1, null)",
    )
    .bind(id)
    .run();
};

/** One step log of a failed execution at epoch 1, as the executor's log segments land in the `CACHE` bucket. */
const putLog = async (id: string, line: string) => {
  const bucket = await mf.getR2Bucket("CACHE");
  await bucket.put(
    `logs/${id}/1/${"0".repeat(24)}/stdout-0-1.ndjson`,
    `${JSON.stringify({ line })}\n`,
  );
};

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
  mf = new Miniflare({
    modules: [
      { type: "ESModule", path: "worker.js", contents: bundle.outputFiles[0]!.text },
      ...wasmModules(),
    ],
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
      DISPATCH_OIDC_AUDIENCE: "control-plane-read-tests",
      WEBHOOK_SECRET: "webhook-secret-for-control-plane-read-tests",
      DEPLOY_CLAIM_SECRET: "deploy-claim-secret-for-control-plane-read-tests",
      COMPILE_CACHE_SECRET: "compile-cache-secret-for-control-plane-read-tests",
      LINK_KEY: "link-key-for-control-plane-read-tests",
      CONTROL_PLANE_READ_SECRET: SECRET,
      MODEL_LEASE_SECRET: "model-lease-secret-for-control-plane-read-tests",
    },
  });
  await mf.ready;
  // Any routed request runs the Worker's migrations first.
  await mf.dispatchFetch("http://x/v1/executions");
  await insertExecution(LEASE, { repo: REPO, run: "ci-triage-pr", status: "running" });
  await insertExecution(REVIEW, { repo: REPO, run: "pr-review", status: "running" });
  await insertExecution(OWN_FAILURE, {
    repo: REPO,
    run: "check",
    status: "failure",
    reason: "exit: 1",
    finishedAt: NOW - 5 * 60_000,
  });
  await insertExecution(OTHER_FAILURE, {
    repo: OTHER_REPO,
    run: "check",
    status: "failure",
    reason: "exit: 2",
    finishedAt: NOW - 5 * 60_000,
  });
  await putLog(OWN_FAILURE, "FAIL a.test.ts");
  await putLog(OTHER_FAILURE, "the other repository's secret log");
}, 60_000);

afterAll(async () => {
  await mf?.dispose();
  await team?.close();
});

const token = (scope: { executionId?: string; epoch?: number; expiresAt?: number } = {}) =>
  signControlPlaneReadToken(SECRET, {
    executionId: scope.executionId ?? LEASE,
    epoch: scope.epoch ?? 1,
    expiresAt: scope.expiresAt ?? DEADLINE,
  });

const get = async (path: string, bearer: string | null) =>
  mf.dispatchFetch(`http://x${path}`, {
    headers: bearer === null ? {} : { authorization: `Bearer ${bearer}` },
  });

const errorOf = async (r: { json(): Promise<unknown> }) =>
  ((await r.json()) as { error?: string; message?: string }).error;

/** `ExecutionsRead` over the Worker's routes, with the bearer the egress proxy attaches to each request. */
const read = (bearer: string) =>
  executionsApiReadLayer({
    baseUrl: "http://x",
    fetch: ((url: string) =>
      mf.dispatchFetch(url, {
        headers: { authorization: `Bearer ${bearer}` },
      })) as unknown as typeof globalThis.fetch,
  });

const entry = (run: string): CatalogEntry => {
  const found = lookupRun("production", run);
  if (found._tag !== "Available") throw new Error(run);
  return found.entry;
};

describe("a lease's control-plane read token", () => {
  it("[FD-IFC-102] the control plane mints it into a ci-triage-pr lease's credentials under the control-plane-read grant name, for that lease alone, and none for another run or without the secret", async () => {
    const lease = { executionId: LEASE, epoch: 1, expiresAt: DEADLINE };
    const credentials = await leaseReadCredentials(
      { CONTROL_PLANE_READ_SECRET: SECRET },
      entry("ci-triage-pr"),
      lease,
    );
    expect(Object.keys(credentials)).toEqual([CONTROL_PLANE_READ_CREDENTIAL]);
    expect(credentials[CONTROL_PLANE_READ_CREDENTIAL]).toBe(await token());
    expect(credentials[CONTROL_PLANE_READ_CREDENTIAL]!.startsWith("cr1.")).toBe(true);
    for (const run of ["pr-review", "triage-issues", "security-gate"])
      expect(
        await leaseReadCredentials({ CONTROL_PLANE_READ_SECRET: SECRET }, entry(run), lease),
        run,
      ).toEqual({});
    expect(await leaseReadCredentials({}, entry("ci-triage-pr"), lease)).toEqual({});
    expect(
      await leaseReadCredentials({ CONTROL_PLANE_READ_SECRET: "" }, entry("ci-triage-pr"), lease),
    ).toEqual({});
  });

  it("[FD-IFC-102] [FD-IFC-103] [FD-AGT-071] ci-triage-pr's ExecutionsRead reads its own repository's failures and their logs, and none of another repository's", async () => {
    const bearer = await token();
    const failed = await Effect.runPromise(
      ExecutionsRead.use((r) => r.failedSince(REPO, NOW - 24 * 3600_000)).pipe(
        Effect.provide(read(bearer)),
      ),
    );
    expect(failed.map((f) => f.executionId)).toEqual([OWN_FAILURE]);
    expect(
      await Effect.runPromise(
        ExecutionsRead.use((r) => r.failedJobLog(OWN_FAILURE)).pipe(Effect.provide(read(bearer))),
      ),
    ).toBe("FAIL a.test.ts");
    // Another repository's failure is a failed read, never its log.
    const other = await Effect.runPromise(
      Effect.result(
        ExecutionsRead.use((r) => r.failedJobLog(OTHER_FAILURE)).pipe(Effect.provide(read(bearer))),
      ),
    );
    expect(other._tag).toBe("Failure");
    expect(JSON.stringify(other)).not.toContain("secret log");
  });

  it("[FD-IFC-102] a listing under the token answers its own repository's executions whatever repository the query names", async () => {
    const bearer = await token();
    const all = await get("/v1/executions?status=done", bearer);
    expect(all.status).toBe(200);
    const listed = (await all.json()) as {
      executions: { execution_id: string; repository: string }[];
    };
    expect(new Set(listed.executions.map((e) => e.repository))).toEqual(new Set([REPO]));
    expect(listed.executions.map((e) => e.execution_id)).toContain(OWN_FAILURE);
    const other = await get(`/v1/executions?repository=${encodeURIComponent(OTHER_REPO)}`, bearer);
    expect(other.status).toBe(403);
    expect(await errorOf(other)).toBe("forbidden");
    // The repository compares without regard to letter case.
    expect((await get("/v1/executions?repository=ACME%2FApp", bearer)).status).toBe(200);
  });

  it("[FD-IFC-103] the log aggregate under the token answers an execution of another repository execution_not_found", async () => {
    const bearer = await token();
    const own = await get(`/v1/logs/${OWN_FAILURE}?format=text`, bearer);
    expect(own.status).toBe(200);
    expect(await own.text()).toBe("FAIL a.test.ts");
    const other = await get(`/v1/logs/${OTHER_FAILURE}?format=text`, bearer);
    expect(other.status).toBe(404);
    const body = await other.text();
    expect(JSON.parse(body)).toMatchObject({ error: "execution_not_found" });
    expect(body).not.toContain("secret log");
    // A step log file is a link or Access read only.
    expect(
      (await get(`/v1/logs/${OWN_FAILURE}/1/${"0".repeat(24)}/stdout-0-1.ndjson`, bearer)).status,
    ).toBe(401);
  });

  it("[FD-IFC-102] a token past its deadline_at, under another secret, for another epoch, for a run that reads no executions, or for an ended execution is refused", async () => {
    const path = `/v1/executions?repository=${encodeURIComponent(REPO)}`;
    const refusals: [string, string, number, string][] = [
      ["expired", await token({ expiresAt: NOW - 1 }), 401, "unauthenticated"],
      [
        "another secret",
        await signControlPlaneReadToken("another-secret", {
          executionId: LEASE,
          epoch: 1,
          expiresAt: DEADLINE,
        }),
        401,
        "unauthenticated",
      ],
      [
        "a model-lease token",
        await signModelLeaseToken("model-lease-secret-for-control-plane-read-tests", {
          executionId: LEASE,
          epoch: 1,
          expiresAt: DEADLINE,
        }),
        401,
        "unauthenticated",
      ],
      ["another epoch", await token({ epoch: 2 }), 401, "lease_stale"],
      ["a run that reads no executions", await token({ executionId: REVIEW }), 403, "forbidden"],
    ];
    for (const [name, bearer, status, error] of refusals) {
      const list = await get(path, bearer);
      expect({ name, status: list.status, error: await errorOf(list) }).toEqual({
        name,
        status,
        error,
      });
      const logs = await get(`/v1/logs/${OWN_FAILURE}`, bearer);
      expect({ name, status: logs.status }).toEqual({ name, status });
    }
    // The execution ends, and its token stops reading at once.
    const ended = "01JREADENDED00000000000000";
    await insertExecution(ended, { repo: REPO, run: "ci-triage-pr", status: "success" });
    const r = await get(path, await token({ executionId: ended }));
    expect(r.status).toBe(401);
    expect(await r.json()).toMatchObject({
      error: "lease_stale",
      message: "execution is terminal",
    });
  });

  it("[FD-IFC-102] verifies to the lease and the execution's repository, and to nothing on a deploy without the secret", async () => {
    const d1 = await migratedD1();
    await d1
      .prepare(
        `insert into mameko_executions (id, scope_id, run, class, status, enqueued_at, deadline_at)
         values (?, ?, 'ci-triage-pr', 'batch', 'running', ?, ?)`,
      )
      .bind(LEASE, REPO, NOW, DEADLINE)
      .run();
    await d1
      .prepare(
        "insert into mameko_placements (execution_id, state, epoch, executor_id) values (?, 'leased', 3, null)",
      )
      .bind(LEASE)
      .run();
    const bearer = await token({ epoch: 3 });
    expect(
      await Effect.runPromise(
        verifyControlPlaneRead({ DB: d1, CONTROL_PLANE_READ_SECRET: SECRET }, bearer, NOW),
      ),
    ).toEqual({
      _tag: "Lease",
      id: `lease:${LEASE}`,
      executionId: LEASE,
      epoch: 3,
      repository: REPO,
    });
    const unset = await Effect.runPromise(
      Effect.result(verifyControlPlaneRead({ DB: d1 }, bearer, NOW)),
    );
    expect(unset).toMatchObject({ _tag: "Failure", failure: { error: "unauthenticated" } });
  });

  it("[FD-IFC-102] MAMEKO-HOST-050 MAMEKO-HOST-052 a ci-triage-pr Container launch carries the lease's read token as the control-plane-read grant's credential, which verifies until the lease's end revokes it", async () => {
    const d1 = await migratedD1();
    await d1
      .prepare(
        `insert into mameko_executions (id, scope_id, run, class, status, enqueued_at, deadline_at)
         values (?, ?, 'ci-triage-pr', 'batch', 'running', ?, ?)`,
      )
      .bind(LEASE, REPO, NOW, DEADLINE)
      .run();
    await d1
      .prepare(
        "insert into mameko_placements (execution_id, state, epoch, executor_id) values (?, 'leased', 2, 'ci-1')",
      )
      .bind(LEASE)
      .run();
    const deploy = {
      PUBLIC_ORIGIN: "https://ci.example.com",
      CONTROL_PLANE_READ_SECRET: SECRET,
      R2_ACCOUNT_ID: "0123abcd",
    } as unknown as ControlPlaneEnv;
    const settings = poolSettings(deploy, buildProfile("production"));
    expect(settings.mintedGrants).toEqual([CONTROL_PLANE_READ_CREDENTIAL]);
    // The launch's grants as mameko's controller builds them, each minted grant through the controller's minter.
    const grants = await mintGrants(
      launchGrants(settings, "ci-triage-pr"),
      settings.mintedGrants ?? [],
      DEADLINE,
      (grant) =>
        mintPoolCredential(deploy)(grant, { executionId: LEASE, epoch: 2, deadlineAt: DEADLINE }),
    );
    const read = grants.agent.find((g) => g.name === CONTROL_PLANE_READ_CREDENTIAL);
    expect(read?.credential).toBe(`Bearer ${await token({ epoch: 2 })}`);
    const bearer = read!.credential!.slice("Bearer ".length);
    const env = { DB: d1, CONTROL_PLANE_READ_SECRET: SECRET };
    expect(await Effect.runPromise(verifyControlPlaneRead(env, bearer, NOW))).toMatchObject({
      executionId: LEASE,
      epoch: 2,
      repository: REPO,
    });
    await Effect.runPromise(revokeLeaseCredentials(d1, LEASE, 2, NOW));
    expect(
      await Effect.runPromise(Effect.result(verifyControlPlaneRead(env, bearer, NOW))),
    ).toMatchObject({
      _tag: "Failure",
      failure: { error: "lease_stale", message: "token revoked" },
    });
  });

  it("[FD-IFC-102] the token is refused on every write route, and on every read but the executions list and the log aggregate", async () => {
    const bearer = await token();
    const routed = router.routes.map((r) => ({
      method: r.method,
      path: r.path.replace(/:[A-Za-z_]+/g, OWN_FAILURE).replace(/\*$/, "x"),
      surface: r.surface._tag,
    }));
    const writes = routed.filter((r) => r.method !== "GET" && r.method !== "HEAD");
    expect(writes.length).toBeGreaterThan(10);
    // The routes the Worker answers before its router, each with its own token kind.
    const own = [
      { method: "POST", path: `/v1/deploy-claims/${LEASE}` },
      { method: "POST", path: "/v1/model/completions" },
      { method: "PUT", path: `/v1/compile-cache/${REPO}/ns/key` },
    ];
    for (const r of [...writes, ...own]) {
      const response = await mf.dispatchFetch(`http://x${r.path}`, {
        method: r.method,
        headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
        body: "{}",
      });
      expect({ ...r, status: response.status }, r.path).toMatchObject({
        status: expect.toSatisfy((s: number) => s === 401 || s === 403),
      });
    }
    // Every other read whose surface names an identity refuses it: only the executions list and the log aggregate
    // take the token.
    const reads = routed.filter(
      (r) =>
        r.method === "GET" &&
        r.surface !== "Public" &&
        r.surface !== "AccessIfPresent" &&
        r.surface !== "OwnCredential" &&
        r.path !== "/v1/executions" &&
        r.path !== `/v1/logs/${OWN_FAILURE}`,
    );
    expect(reads.length).toBeGreaterThan(10);
    for (const r of reads) {
      const response = await get(r.path, bearer);
      expect({ ...r, status: response.status }, r.path).toMatchObject({
        status: expect.toSatisfy((s: number) => s === 401 || s === 403),
      });
    }
  });
});
