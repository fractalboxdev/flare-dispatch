// The deploy-claim route and its tokens (specs/runs/gate.md § `worker-deploy`): one claim per execution, held in D1,
// and admitted only under a token minted for the execution at its current epoch.
import {
  lookupRun,
  WorkerDeployInput,
  type CatalogEntry,
} from "@fractalboxdev/flare-dispatch-catalog";
import { migratedD1 } from "@fractalboxdev/flare-dispatch-intake/testing";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  deployClaimFetch,
  leaseDeployClaim,
  migrateDeployClaims,
  signDeployClaimToken,
  withDeployClaim,
  type DeployClaimEnv,
} from "../src/deploy-claim.ts";

const SECRET = "deploy-claim-secret";
const ORIGIN = "https://ci.example.com";
const NOW = Date.UTC(2026, 10, 15, 12);
const DEADLINE = NOW + 30 * 60_000;
const EXECUTION = "01JDEPLOY0000000000000000A";

const entry = (run: string): CatalogEntry => {
  const found = lookupRun("production", run);
  if (found._tag !== "Available") throw new Error(run);
  return found.entry;
};

/** A plane with one running `worker-deploy` execution per id, each placed at `epoch`. */
const plane = async (executions: Readonly<Record<string, number>>) => {
  const db = await migratedD1();
  // The Worker's startup migration creates the table before the first request.
  await migrateDeployClaims(db);
  for (const [id, epoch] of Object.entries(executions)) {
    await db
      .prepare(
        `insert into mameko_executions (id, scope_id, run, class, status, enqueued_at, deadline_at)
         values (?, 'acme/app', 'worker-deploy', 'release', 'running', ?, ?)`,
      )
      .bind(id, NOW - 60_000, DEADLINE)
      .run();
    await db
      .prepare(
        "insert into mameko_placements (execution_id, state, epoch, executor_id) values (?, 'leased', ?, null)",
      )
      .bind(id, epoch)
      .run();
  }
  const env: DeployClaimEnv = { DB: db, DEPLOY_CLAIM_SECRET: SECRET, PUBLIC_ORIGIN: ORIGIN };
  const reclaim = (id: string, epoch: number) =>
    db.prepare("update mameko_placements set epoch = ? where execution_id = ?").bind(epoch, id).run();
  const finish = (id: string) =>
    db.prepare("update mameko_executions set status = 'success' where id = ?").bind(id).run();
  return { db, env, reclaim, finish };
};

const token = (scope: { executionId?: string; epoch?: number; expiresAt?: number } = {}) =>
  signDeployClaimToken(SECRET, {
    executionId: scope.executionId ?? EXECUTION,
    epoch: scope.epoch ?? 1,
    expiresAt: scope.expiresAt ?? DEADLINE,
  });

const claim = async (
  env: DeployClaimEnv,
  bearer: string | null,
  options: { id?: string; method?: string; at?: number } = {},
) => {
  const response = await deployClaimFetch(
    new Request(`${ORIGIN}/v1/deploy-claims/${options.id ?? EXECUTION}`, {
      method: options.method ?? "POST",
      headers: bearer === null ? {} : { authorization: `Bearer ${bearer}` },
    }),
    env,
    options.at ?? NOW,
  );
  if (response === null) throw new Error("the route served no response");
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
};

const claimRows = async (p: Awaited<ReturnType<typeof plane>>) =>
  (await p.db.prepare("select execution_id, epoch from deploy_claims order by execution_id").all())
    .results;

describe("the deploy-claim route", () => {
  it("[FD-GATE-067] the first claim of an execution answers claimed and records the claiming epoch", async () => {
    const p = await plane({ [EXECUTION]: 1 });
    expect(await claim(p.env, await token())).toEqual({ status: 200, body: { claimed: true } });
    expect(await claimRows(p)).toEqual([{ execution_id: EXECUTION, epoch: 1 }]);
  });

  it("[FD-GATE-067] every later claim of the execution answers not-claimed, in the same epoch and after a reclaim", async () => {
    const p = await plane({ [EXECUTION]: 1 });
    expect((await claim(p.env, await token())).body).toEqual({ claimed: true });
    expect(await claim(p.env, await token())).toEqual({ status: 200, body: { claimed: false } });
    // A reclaim starts epoch 2; its lease's token is current, and the execution's deploy was already claimed.
    await p.reclaim(EXECUTION, 2);
    expect(await claim(p.env, await token({ epoch: 2 }))).toEqual({
      status: 200,
      body: { claimed: false },
    });
    expect(await claimRows(p)).toEqual([{ execution_id: EXECUTION, epoch: 1 }]);
  });

  it("[FD-GATE-067] refuses a token for an epoch other than the execution's current one, and claims nothing", async () => {
    const p = await plane({ [EXECUTION]: 2 });
    const stale = await claim(p.env, await token({ epoch: 1 }));
    expect(stale.status).toBe(403);
    expect(stale.body).toMatchObject({ error: "forbidden", message: "token epoch is not current" });
    expect(await claimRows(p)).toEqual([]);
    // The current epoch's token claims.
    expect((await claim(p.env, await token({ epoch: 2 }))).body).toEqual({ claimed: true });
  });

  it("[FD-GATE-067] refuses an expired token, and claims nothing", async () => {
    const p = await plane({ [EXECUTION]: 1 });
    const expired = await claim(p.env, await token({ expiresAt: NOW }));
    expect(expired.status).toBe(401);
    expect(expired.body).toMatchObject({ error: "unauthenticated", message: "token expired" });
    // The token's expiry is the execution's deadline: one valid now stops at the deadline.
    expect((await claim(p.env, await token(), { at: DEADLINE })).status).toBe(401);
    expect(await claimRows(p)).toEqual([]);
  });

  it("[FD-GATE-067] refuses a token minted for another execution, and claims neither execution", async () => {
    const other = "01JDEPLOY0000000000000000B";
    const p = await plane({ [EXECUTION]: 1, [other]: 1 });
    const crossed = await claim(p.env, await token({ executionId: other }));
    expect(crossed.status).toBe(403);
    expect(crossed.body).toMatchObject({ error: "forbidden", message: "token other-execution" });
    expect(await claimRows(p)).toEqual([]);
    // The other execution's own claim is untouched by the refused one.
    expect((await claim(p.env, await token({ executionId: other }), { id: other })).body).toEqual({
      claimed: true,
    });
  });

  it("[FD-GATE-067] refuses a request with no token, a forged token or a token under another secret", async () => {
    const p = await plane({ [EXECUTION]: 1 });
    const none = await claim(p.env, null);
    expect(none.status).toBe(401);
    expect(none.body).toMatchObject({ error: "unauthenticated", message: "token missing" });
    const foreign = await signDeployClaimToken("another-secret", {
      executionId: EXECUTION,
      epoch: 1,
      expiresAt: DEADLINE,
    });
    expect((await claim(p.env, foreign)).body).toMatchObject({ message: "token invalid" });
    const [version, , mac] = (await token()).split(".");
    const widened = Buffer.from(
      JSON.stringify({ epoch: 1, execution_id: EXECUTION, exp: DEADLINE + 1 }),
    ).toString("base64url");
    expect((await claim(p.env, `${version}.${widened}.${mac}`)).body).toMatchObject({
      message: "token invalid",
    });
    expect((await claim(p.env, "cc3.not.a-claim-token")).body).toMatchObject({
      message: "token malformed",
    });
    expect(await claimRows(p)).toEqual([]);
  });

  it("[FD-GATE-067] refuses a claim once the execution has ended, takes only POST, and is unavailable without its secret", async () => {
    const p = await plane({ [EXECUTION]: 1 });
    await p.finish(EXECUTION);
    expect((await claim(p.env, await token())).body).toMatchObject({
      error: "forbidden",
      message: "execution is terminal",
    });
    expect((await claim(p.env, await token(), { method: "GET" })).status).toBe(405);
    expect((await claim({ DB: p.db }, await token())).status).toBe(503);
    expect(await claimRows(p)).toEqual([]);
    expect(
      await deployClaimFetch(new Request(`${ORIGIN}/v1/compile-cache/acme/app/k`), p.env),
    ).toBeNull();
  });
});

describe("a worker-deploy lease's deploy claim", () => {
  const recorded = {
    repo: "https://github.com/acme/app.git",
    sha: "a".repeat(40),
    ref: "refs/heads/main",
    scope: "acme/app",
    branch: "main",
    entry: { command: "pnpm wrangler deploy", grants: ["cf-api"] },
  };
  const scope = { executionId: EXECUTION, epoch: 3, expiresAt: DEADLINE };

  it("[FD-GATE-067] carries the route for the execution and a token bound to it at the lease's epoch, which the route admits", async () => {
    const p = await plane({ [EXECUTION]: 3 });
    const grant = await leaseDeployClaim(p.env, entry("worker-deploy"), scope);
    expect(grant?.url).toBe(`${ORIGIN}/v1/deploy-claims/${EXECUTION}`);
    const inputs = withDeployClaim(entry("worker-deploy"), recorded, grant);
    // The run's input schema keeps the claim, so the run body receives it.
    const decoded = Schema.decodeUnknownSync(WorkerDeployInput)(inputs);
    expect(decoded.deployClaim).toEqual(grant);
    const response = await deployClaimFetch(
      new Request(decoded.deployClaim!.url, {
        method: "POST",
        headers: { authorization: `Bearer ${decoded.deployClaim!.token}` },
      }),
      p.env,
      NOW,
    );
    expect(await response?.json()).toEqual({ claimed: true });
  });

  it("[FD-GATE-067] replaces a claim the request recorded, and is absent for another run or on a deploy without the secret or an origin", async () => {
    const forged = {
      ...recorded,
      deployClaim: { url: "https://evil.example/x", token: "dc1.x.y" },
    };
    const env = { DEPLOY_CLAIM_SECRET: SECRET, PUBLIC_ORIGIN: `${ORIGIN}/` };
    const grant = await leaseDeployClaim(env, entry("worker-deploy"), scope);
    expect(grant?.url).toBe(`${ORIGIN}/v1/deploy-claims/${EXECUTION}`);
    expect(withDeployClaim(entry("worker-deploy"), forged, grant)).toEqual({
      ...recorded,
      deployClaim: grant,
    });
    for (const unminted of [{ PUBLIC_ORIGIN: ORIGIN }, { DEPLOY_CLAIM_SECRET: SECRET }]) {
      const none = await leaseDeployClaim(unminted, entry("worker-deploy"), scope);
      expect(none).toBeNull();
      expect(withDeployClaim(entry("worker-deploy"), forged, none)).toEqual(recorded);
    }
    expect(await leaseDeployClaim(env, entry("sandbox-image"), scope)).toBeNull();
    const other = { ...recorded, deployClaim: "kept" };
    expect(withDeployClaim(entry("sandbox-image"), other, grant)).toBe(other);
  });
});
