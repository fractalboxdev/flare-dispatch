// The control plane's model route, `POST /v1/model/completions`: one model call of an execution under its model-lease
// token, routed by the repository's confidentiality mode and settled against the execution's model allowance in D1.
import { lookupRun, type CatalogEntry } from "@fractalboxdev/flare-dispatch-catalog";
import { migratedD1 } from "@fractalboxdev/flare-dispatch-intake/testing";
import { describe, expect, it } from "vitest";
import { signDeployClaimToken } from "../src/deploy-claim.ts";
import {
  leaseModelCredentials,
  MODEL_LEASE_CREDENTIAL,
  modelGatewayFetch,
  signModelLeaseToken,
  type ModelGatewayEnv,
} from "../src/model-gateway.ts";

const SECRET = "model-lease-secret";
const ORIGIN = "https://ci.example.com";
const NOW = Date.UTC(2026, 10, 15, 12);
const DEADLINE = NOW + 30 * 60_000;
const EXECUTION = "01JMODEL00000000000000000A";
const REPO = "acme/app";

/** A `workers-ai` entry priced at its Neurons rate, 1 micro-USD per token each way. */
const REGISTRY = {
  "workers-ai-small": {
    providerId: "workers-ai",
    routeKind: "workers-ai",
    serves: ["transform", "judgment"],
    upstreamModel: "@cf/example/small",
    inputPriceMicroUsdPerMTok: 1_000_000,
    outputPriceMicroUsdPerMTok: 1_000_000,
  },
};

const entry = (run: string): CatalogEntry => {
  const found = lookupRun("production", run);
  if (found._tag !== "Available") throw new Error(run);
  return found.entry;
};

/** The Workers AI binding: each call recorded, answered with `text` and the usage it reports. */
const workersAi = (usage: { prompt_tokens: number; completion_tokens: number } | null) => {
  const calls: { model: string; messages: unknown; max_tokens: number }[] = [];
  return {
    calls,
    binding: {
      run: async (
        model: string,
        inputs: { readonly messages: readonly unknown[]; readonly max_tokens: number },
      ) => {
        calls.push({ model, messages: inputs.messages, max_tokens: inputs.max_tokens });
        return { response: "the completion", ...(usage === null ? {} : { usage }) };
      },
    },
  };
};

/** A plane with one running `pr-review` execution of `acme/app` per id, placed at `epoch`. */
const plane = async (
  executions: Readonly<Record<string, number>>,
  overrides: Partial<ModelGatewayEnv> = {},
) => {
  const db = await migratedD1();
  for (const [id, epoch] of Object.entries(executions)) {
    await db
      .prepare(
        `insert into mameko_executions (id, scope_id, run, class, status, enqueued_at, deadline_at)
         values (?, ?, 'pr-review', 'interactive', 'running', ?, ?)`,
      )
      .bind(id, REPO, NOW - 60_000, DEADLINE)
      .run();
    await db
      .prepare(
        "insert into mameko_placements (execution_id, state, epoch, executor_id) values (?, 'leased', ?, null)",
      )
      .bind(id, epoch)
      .run();
  }
  const ai = workersAi({ prompt_tokens: 100, completion_tokens: 50 });
  const env: ModelGatewayEnv = {
    DB: db,
    DEPLOYMENT: "production",
    MODEL_LEASE_SECRET: SECRET,
    AI: ai.binding,
    MODEL_REGISTRY: REGISTRY,
    POLICY_RULES: { [REPO]: [{ match: {}, confidentiality: "non-confidential" }] },
    ...overrides,
  };
  const spend = async (id: string) =>
    (
      await db
        .prepare(
          "select max_micro_usd as max, settled_micro_usd as settled from mameko_model_calls where execution_id = ?",
        )
        .bind(id)
        .all()
    ).results as { max: number; settled: number | null }[];
  return { db, env, ai, spend };
};

const token = (scope: { executionId?: string; epoch?: number; expiresAt?: number } = {}) =>
  signModelLeaseToken(SECRET, {
    executionId: scope.executionId ?? EXECUTION,
    epoch: scope.epoch ?? 1,
    expiresAt: scope.expiresAt ?? DEADLINE,
  });

const BODY = {
  call_site: "reviewer",
  tier: "judgment",
  messages: [
    { role: "system", content: "review" },
    { role: "user", content: "the diff" },
  ],
  max_tokens: 1000,
};

const call = async (
  env: ModelGatewayEnv,
  bearer: string | null,
  options: { body?: unknown; raw?: string; method?: string; path?: string; at?: number } = {},
) => {
  const method = options.method ?? "POST";
  const response = await modelGatewayFetch(
    new Request(`${ORIGIN}${options.path ?? "/v1/model/completions"}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(bearer === null ? {} : { authorization: `Bearer ${bearer}` }),
      },
      ...(method === "POST" ? { body: options.raw ?? JSON.stringify(options.body ?? BODY) } : {}),
    }),
    env,
    options.at ?? NOW,
  );
  if (response === null) throw new Error("the route served no response");
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
};

describe("the model route", () => {
  it("MAMEKO-MDL-041 refuses a request with no token, a forged token or another kind's token with 401 before reading the body", async () => {
    const { env, ai, spend } = await plane({ [EXECUTION]: 1 });
    const forged = await signModelLeaseToken("another-secret", {
      executionId: EXECUTION,
      epoch: 1,
      expiresAt: DEADLINE,
    });
    const deployClaim = await signDeployClaimToken(SECRET, {
      executionId: EXECUTION,
      epoch: 1,
      expiresAt: DEADLINE,
    });
    for (const [bearer, message] of [
      [null, "token missing"],
      [forged, "token invalid"],
      [deployClaim, "token malformed"],
      ["not-a-token", "token malformed"],
    ] as const)
      // A body that is no request at all: the token check answers before any read of it.
      expect(await call(env, bearer, { raw: "{" })).toEqual({
        status: 401,
        body: expect.objectContaining({ error: "unauthenticated", message }),
      });
    expect(await call(env, await token({ expiresAt: NOW }))).toMatchObject({
      status: 401,
      body: { message: "token expired" },
    });
    expect(ai.calls).toEqual([]);
    expect(await spend(EXECUTION)).toEqual([]);
  });

  it("MAMEKO-MDL-040 refuses a token for an epoch that is not the execution's current one, or for an ended execution, with lease_stale and no upstream request", async () => {
    const { db, env, ai } = await plane({ [EXECUTION]: 2 });
    expect(await call(env, await token({ epoch: 1 }))).toMatchObject({
      status: 401,
      body: { error: "lease_stale", message: "token epoch is not current" },
    });
    expect(
      await call(env, await token({ executionId: "01JMODELUNKNOWN00000000000" })),
    ).toMatchObject({ status: 401, body: { error: "lease_stale" } });
    expect((await call(env, await token({ epoch: 2 }))).status).toBe(200);
    await db.prepare("update mameko_executions set status = 'success' where id = ?").bind(EXECUTION).run();
    expect(await call(env, await token({ epoch: 2 }))).toMatchObject({
      status: 401,
      body: { error: "lease_stale", message: "execution is terminal" },
    });
    expect(ai.calls).toHaveLength(1);
  });

  it("[FD-MDL-021] MAMEKO-MDL-027 sends a call to the registry's workers-ai entry through the AI binding and settles its reported usage at the entry's stated rate", async () => {
    const { env, ai, spend } = await plane({ [EXECUTION]: 1 });
    const answer = await call(env, await token());
    expect(answer).toEqual({ status: 200, body: { text: "the completion" } });
    expect(ai.calls).toEqual([
      { model: "@cf/example/small", messages: BODY.messages, max_tokens: 1000 },
    ]);
    // 100 input and 50 output tokens at 1 micro-USD each, reserved at the call maximum first.
    const [row] = await spend(EXECUTION);
    expect(row!.settled).toBe(150);
    expect(row!.max).toBeGreaterThanOrEqual(150);
  });

  it("[FD-MDL-021] MAMEKO-MDL-028 settles a call whose provider reports no usage at its reserved maximum", async () => {
    const silent = workersAi(null);
    const { env, spend } = await plane({ [EXECUTION]: 1 }, { AI: silent.binding });
    expect((await call(env, await token())).status).toBe(200);
    const [row] = await spend(EXECUTION);
    expect(row!.settled).toBe(row!.max);
  });

  it("[FD-MDL-021] never prices a workers-ai entry at the fallback rate: an entry with no stated rate is refused before any reservation", async () => {
    const unpriced = {
      providerId: "workers-ai",
      routeKind: "workers-ai",
      serves: ["judgment"],
      upstreamModel: "@cf/example/unpriced",
    };
    const { env, ai, spend } = await plane(
      { [EXECUTION]: 1 },
      { MODEL_REGISTRY: { unpriced }, MODEL_FALLBACK_PRICE_USD_PER_MTOK: 0.000001 },
    );
    expect(await call(env, await token())).toMatchObject({
      status: 400,
      body: { error: "model_request_invalid" },
    });
    expect(ai.calls).toEqual([]);
    expect(await spend(EXECUTION)).toEqual([]);
  });

  it("MAMEKO-MDL-026 refuses a call the execution's allowance does not cover with allowance_exhausted and no upstream request", async () => {
    const { env, ai } = await plane({ [EXECUTION]: 1 });
    // pr-review's allowance is 2 USD; a call maximum of 8192 output tokens at 1,000 USD per million exceeds it.
    const dear = {
      dear: { ...REGISTRY["workers-ai-small"], outputPriceMicroUsdPerMTok: 1_000_000_000 },
    };
    expect(
      await call({ ...env, MODEL_REGISTRY: dear }, await token(), {
        body: { ...BODY, max_tokens: 8192 },
      }),
    ).toMatchObject({ status: 402, body: { error: "allowance_exhausted" } });
    expect(ai.calls).toEqual([]);
  });

  it("MAMEKO-MDL-008 refuses a hosted call for a repository that is not non-confidential with model_route_refused", async () => {
    const { env, ai } = await plane({ [EXECUTION]: 1 }, { POLICY_RULES: undefined });
    expect(await call(env, await token())).toMatchObject({
      status: 403,
      body: { error: "model_route_refused" },
    });
    expect(ai.calls).toEqual([]);
  });

  it("[FD-MDL-020] answers unavailable where no registry entry this deploy routes serves the call's tier, and on a deploy without the secret", async () => {
    const transformOnly = {
      small: { ...REGISTRY["workers-ai-small"], serves: ["transform"] },
      signed: { ...REGISTRY["workers-ai-small"], routeKind: "bedrock", serves: ["judgment"] },
    };
    const { env } = await plane({ [EXECUTION]: 1 }, { MODEL_REGISTRY: transformOnly });
    expect(await call(env, await token())).toMatchObject({
      status: 503,
      body: { error: "unavailable", message: "no model entry this deploy routes serves judgment" },
    });
    expect(
      (
        await call({ ...env, MODEL_REGISTRY: JSON.stringify(transformOnly) }, await token(), {
          body: { ...BODY, tier: "transform" },
        })
      ).status,
    ).toBe(200);
    expect(await call({ ...env, MODEL_LEASE_SECRET: undefined }, await token())).toMatchObject({
      status: 503,
      body: { error: "unavailable" },
    });
  });

  it("answers a body outside the request shape with model_request_invalid, another method with 405 and another path under the route with 404", async () => {
    const { env } = await plane({ [EXECUTION]: 1 });
    const bearer = await token();
    for (const body of [{ ...BODY, tier: "bulk" }, { ...BODY, messages: [] }, { tier: "judgment" }])
      expect(await call(env, bearer, { body })).toMatchObject({
        status: 400,
        body: { error: "model_request_invalid" },
      });
    expect((await call(env, bearer, { method: "GET" })).status).toBe(405);
    expect((await call(env, bearer, { path: "/v1/model/embeddings" })).status).toBe(404);
    expect(
      await modelGatewayFetch(new Request(`${ORIGIN}/v1/deploy-claims/x`), env, NOW),
    ).toBeNull();
  });

  it("[FD-AGT-010] mints the model-lease token into an agentic lease's credentials for the lease's epoch and deadline, and none for a run that calls no model or without the secret", async () => {
    const { env } = await plane({ [EXECUTION]: 1 });
    const scope = { executionId: EXECUTION, epoch: 1, expiresAt: DEADLINE };
    const credentials = await leaseModelCredentials(env, entry("pr-review"), scope);
    expect(Object.keys(credentials)).toEqual([MODEL_LEASE_CREDENTIAL]);
    expect((await call(env, credentials[MODEL_LEASE_CREDENTIAL]!)).status).toBe(200);
    for (const run of ["triage-prs", "worker-deploy", "security-gate"])
      expect(await leaseModelCredentials(env, entry(run), scope), run).toEqual({});
    expect(await leaseModelCredentials(env, null, scope)).toEqual({});
    expect(
      await leaseModelCredentials({ MODEL_LEASE_SECRET: "" }, entry("pr-review"), scope),
    ).toEqual({});
  });
});
