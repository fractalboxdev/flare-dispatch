// The control plane's model route, `POST /v1/model/completions`: one model call of an execution under its model-lease
// token, routed by the repository's confidentiality mode and settled against the execution's model allowance in D1.
import { createHash, createHmac } from "node:crypto";
import { lookupRun, type CatalogEntry } from "@fractalboxdev/flare-dispatch-catalog";
import { migratedD1 } from "@fractalboxdev/flare-dispatch-intake/testing";
import { buildProfile } from "@fractalboxdev/flare-dispatch-profile";
import { launchGrants, mintGrants } from "@fractalboxdev/mameko-host-cloudflare";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import type { ControlPlaneEnv } from "../src/config.ts";
import { signDeployClaimToken } from "../src/deploy-claim.ts";
import { revokeLeaseCredentials } from "../src/lease.ts";
import { revokeDevice } from "../src/operator-revoke.ts";
import { mintPoolCredential, poolSettings } from "../src/pools.ts";
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
  options: {
    body?: unknown;
    raw?: string;
    method?: string;
    path?: string;
    at?: number;
    authorization?: string;
    fetch?: typeof globalThis.fetch;
  } = {},
) => {
  const method = options.method ?? "POST";
  const authorization = options.authorization ?? (bearer === null ? null : `Bearer ${bearer}`);
  const response = await modelGatewayFetch(
    new Request(`${ORIGIN}${options.path ?? "/v1/model/completions"}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(authorization === null ? {} : { authorization }),
      },
      ...(method === "POST" ? { body: options.raw ?? JSON.stringify(options.body ?? BODY) } : {}),
    }),
    env,
    options.at ?? NOW,
    options.fetch,
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
    await db
      .prepare("update mameko_executions set status = 'success' where id = ?")
      .bind(EXECUTION)
      .run();
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

  it("[FD-AGT-010] MAMEKO-HOST-050 MAMEKO-HOST-051 a Container launch carries the lease's model-lease token as the model-gateway grant's credential, which the model route accepts", async () => {
    const { env, ai } = await plane({ [EXECUTION]: 3 });
    const deploy = { ...env, PUBLIC_ORIGIN: ORIGIN } as unknown as ControlPlaneEnv;
    const settings = poolSettings(deploy, buildProfile("production"));
    expect(settings.mintedGrants).toEqual([MODEL_LEASE_CREDENTIAL]);
    // The launch's grants as mameko's controller builds them, each minted grant through the controller's minter.
    const grants = await mintGrants(
      launchGrants(settings, "pr-review"),
      settings.mintedGrants ?? [],
      DEADLINE,
      (grant) =>
        mintPoolCredential(deploy)(grant, {
          executionId: EXECUTION,
          epoch: 3,
          deadlineAt: DEADLINE,
        }),
    );
    const model = grants.agent.find((g) => g.name === MODEL_LEASE_CREDENTIAL);
    expect(model?.credential).toBe(`Bearer ${await token({ epoch: 3 })}`);
    expect(grants.setup.every((g) => g.credential === undefined)).toBe(true);
    expect(await call(env, null, { authorization: model!.credential! })).toEqual({
      status: 200,
      body: { text: "the completion" },
    });
    expect(ai.calls).toHaveLength(1);
    // A deploy without the secret mints no grant, and no other grant is minted.
    expect(
      poolSettings({ ...deploy, MODEL_LEASE_SECRET: "" }, buildProfile("production")).mintedGrants,
    ).toEqual([]);
    await expect(
      mintPoolCredential(deploy)("cf-api", {
        executionId: EXECUTION,
        epoch: 3,
        deadlineAt: DEADLINE,
      }),
    ).rejects.toThrow("no credential minter");
  });

  it("MAMEKO-ISO-053 MAMEKO-HOST-052 refuses a revoked lease's token with lease_stale while its placement still holds the epoch", async () => {
    const { db, env, ai } = await plane({ [EXECUTION]: 1, "01JMODELOTHER0000000000000": 1 });
    expect((await call(env, await token())).status).toBe(200);
    await Effect.runPromise(revokeLeaseCredentials(db, EXECUTION, 1, NOW));
    expect(await call(env, await token())).toMatchObject({
      status: 401,
      body: { error: "lease_stale", message: "token revoked" },
    });
    // Another lease's token is untouched.
    expect(
      (await call(env, await token({ executionId: "01JMODELOTHER0000000000000" }))).status,
    ).toBe(200);
    expect(ai.calls).toHaveLength(2);
  });

  it("MAMEKO-OPS-043 MAMEKO-OPS-044 MAMEKO-OPS-045 an operator's device revoke requeues the device's lease at the next epoch and revokes its model-lease token", async () => {
    const { db, env } = await plane({ [EXECUTION]: 1 });
    await db
      .prepare(
        `insert into mameko_executors (executor_id, kind, posture_tier, labels_json, slots_json)
         values ('dev-1', 'device', 'unmanaged', '[]', '{}')`,
      )
      .run();
    await db
      .prepare("update mameko_placements set executor_id = 'dev-1' where execution_id = ?")
      .bind(EXECUTION)
      .run();
    const lease = await token();
    expect((await call(env, lease)).status).toBe(200);
    const call_ = {
      identity: "operator@example.com",
      requestId: "req-1",
      reason: "lost laptop",
      now: NOW,
    };
    expect(await Effect.runPromise(revokeDevice(db, "dev-1", call_))).toEqual({
      target: "executor:dev-1",
    });
    expect((await call(env, lease)).status).toBe(401);
    const placement = (
      await db
        .prepare("select state, epoch from mameko_placements where execution_id = ?")
        .bind(EXECUTION)
        .all()
    ).results[0] as { state: string; epoch: number };
    expect(placement.epoch).toBe(2);
    const revoked = (
      await db.prepare("select execution_id, epoch from fd_lease_token_revocations").all()
    ).results;
    expect(revoked).toEqual([{ execution_id: EXECUTION, epoch: 1 }]);
    // A reason outside 1 to 500 characters changes nothing.
    const refused = await Effect.runPromise(
      Effect.flip(revokeDevice(db, "dev-1", { ...call_, reason: "" })),
    );
    expect(refused).toMatchObject({ error: "reason_required" });
  });
});

const REGION = "eu-west-1";
const ROLE = "arn:aws:iam::000000000000:role/flare-dispatch-bedrock";
/** The IAM user's keys the Worker holds as `BEDROCK_ACCESS_KEY_ID` and `BEDROCK_SECRET_ACCESS_KEY`. */
const BASE = { accessKeyId: "AKIABASEEXAMPLE", secretAccessKey: "base-secret" };
/** The role's temporary credentials STS answers. */
const SESSION = {
  accessKeyId: "ASIASESSIONEXAMPLE",
  secretAccessKey: "session-secret",
  sessionToken: "session-token",
};
const BEDROCK_MODEL = "anthropic.claude-example-v1:0";

/** A registry whose only entry serving `judgment` is a `bedrock` entry, 1 micro-USD per token each way. */
const BEDROCK_REGISTRY = {
  "bedrock-judge": {
    providerId: "bedrock",
    routeKind: "bedrock",
    serves: ["judgment"],
    upstreamModel: BEDROCK_MODEL,
    inputPriceMicroUsdPerMTok: 1_000_000,
    outputPriceMicroUsdPerMTok: 1_000_000,
  },
};

const BEDROCK_ENV = {
  MODEL_REGISTRY: BEDROCK_REGISTRY,
  MODEL_BEDROCK_REGION: REGION,
  MODEL_BEDROCK_ROLE_ARN: ROLE,
  BEDROCK_ACCESS_KEY_ID: BASE.accessKeyId,
  BEDROCK_SECRET_ACCESS_KEY: BASE.secretAccessKey,
};

/**
 * An independent Node-crypto SigV4 check of one request: the headers its `SignedHeaders` names, which must cover
 * `host`, the payload hash and the date (and the session token where the credentials carry one), the canonical URI with
 * each path segment encoded once more than on the wire, and a signature under `credentials` for `service` in `REGION`.
 */
const sigV4Verifies = (
  url: URL,
  headers: Headers,
  body: string,
  service: string,
  credentials: { accessKeyId: string; secretAccessKey: string; sessionToken?: string },
): boolean => {
  const authorization = headers.get("authorization") ?? "";
  const m =
    /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/([^/]+)\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]{64})$/.exec(
      authorization,
    );
  if (m === null) return false;
  const [, keyId, day, region, signedService, signedList, signature] = m as unknown as string[];
  const date = headers.get("x-amz-date") ?? "";
  const signed = signedList!.split(";");
  const payloadHash = createHash("sha256").update(body).digest("hex");
  if (
    keyId !== credentials.accessKeyId ||
    region !== REGION ||
    signedService !== service ||
    date.slice(0, 8) !== day ||
    headers.get("x-amz-content-sha256") !== payloadHash ||
    headers.get("host") !== url.host ||
    !["host", "x-amz-content-sha256", "x-amz-date"].every((h) => signed.includes(h)) ||
    (credentials.sessionToken !== undefined &&
      (!signed.includes("x-amz-security-token") ||
        headers.get("x-amz-security-token") !== credentials.sessionToken))
  )
    return false;
  const canonical = [
    "POST",
    url.pathname
      .split("/")
      .map((segment) => encodeURIComponent(segment))
      .join("/"),
    "",
    ...signed.map((k) => `${k}:${(headers.get(k) ?? "").trim().replace(/\s+/g, " ")}`),
    "",
    signedList,
    payloadHash,
  ].join("\n");
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    date,
    `${day}/${region}/${service}/aws4_request`,
    createHash("sha256").update(canonical).digest("hex"),
  ].join("\n");
  const h = (key: Buffer | string, value: string) =>
    createHmac("sha256", key).update(value).digest();
  const key = h(
    h(h(h(`AWS4${credentials.secretAccessKey}`, day!), region!), service),
    "aws4_request",
  );
  return createHmac("sha256", key).update(stringToSign).digest("hex") === signature;
};

/**
 * STS and the Bedrock runtime of `REGION` as AWS answers them: a request whose SigV4 signature does not verify is
 * `403`. STS answers `AssumeRole` of `ROLE` with `SESSION`, expiring `expiresInMs` from now; the runtime answers
 * `InvokeModel` signed under `SESSION` with an Anthropic Messages answer, or `bedrockStatus` where set.
 */
const aws = (
  options: { expiresInMs?: number; stsStatus?: number; bedrockStatus?: number } = {},
) => {
  const calls: { service: string; path: string; body: string }[] = [];
  const fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    const body = String(init?.body ?? "");
    if (url.host === `sts.${REGION}.amazonaws.com` && url.pathname === "/") {
      calls.push({ service: "sts", path: url.pathname, body });
      if (!sigV4Verifies(url, headers, body, "sts", BASE))
        return new Response("<Error><Code>SignatureDoesNotMatch</Code></Error>", { status: 403 });
      if (options.stsStatus !== undefined)
        return new Response("<Error><Code>AccessDenied</Code></Error>", {
          status: options.stsStatus,
        });
      const form = new URLSearchParams(body);
      if (form.get("Action") !== "AssumeRole" || form.get("RoleArn") !== ROLE)
        return new Response("<Error><Code>InvalidAction</Code></Error>", { status: 400 });
      const expiration = new Date(Date.now() + (options.expiresInMs ?? 3600_000)).toISOString();
      return new Response(
        `<AssumeRoleResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><AssumeRoleResult><Credentials>
           <AccessKeyId>${SESSION.accessKeyId}</AccessKeyId><SecretAccessKey>${SESSION.secretAccessKey}</SecretAccessKey>
           <SessionToken>${SESSION.sessionToken}</SessionToken><Expiration>${expiration}</Expiration>
         </Credentials></AssumeRoleResult></AssumeRoleResponse>`,
      );
    }
    if (url.host === `bedrock-runtime.${REGION}.amazonaws.com`) {
      calls.push({ service: "bedrock", path: url.pathname, body });
      if (!sigV4Verifies(url, headers, body, "bedrock", SESSION))
        return Response.json(
          { message: "The request signature we calculated does not match" },
          { status: 403 },
        );
      if (options.bedrockStatus !== undefined)
        return Response.json({ message: "Too many requests" }, { status: options.bedrockStatus });
      return Response.json({
        content: [{ type: "text", text: "the bedrock completion" }],
        usage: { input_tokens: 120, output_tokens: 30 },
      });
    }
    return new Response("no such host", { status: 404 });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
};

describe("the bedrock route", () => {
  it("[FD-MDL-024] [FD-MDL-070] assumes the overlay's role with an STS AssumeRole signed under the base secrets, signs InvokeModel under the role's credentials, and settles the reported usage", async () => {
    const { env, spend } = await plane({ [EXECUTION]: 1 }, { ...BEDROCK_ENV, AI: undefined });
    const fake = aws();
    expect(await call(env, await token(), { fetch: fake.fetch })).toEqual({
      status: 200,
      body: { text: "the bedrock completion" },
    });
    expect(fake.calls.map((c) => c.service)).toEqual(["sts", "bedrock"]);
    const assume = new URLSearchParams(fake.calls[0]!.body);
    expect(Object.fromEntries(assume)).toMatchObject({
      Action: "AssumeRole",
      RoleArn: ROLE,
      RoleSessionName: "flare-dispatch-model-gateway",
    });
    expect(fake.calls[1]!.path).toBe(`/model/${encodeURIComponent(BEDROCK_MODEL)}/invoke`);
    expect(JSON.parse(fake.calls[1]!.body)).toEqual({
      anthropic_version: "bedrock-2023-05-31",
      max_tokens: 1000,
      system: "review",
      messages: [{ role: "user", content: "the diff" }],
    });
    // 120 input and 30 output tokens at 1 micro-USD each.
    expect((await spend(EXECUTION))[0]!.settled).toBe(150);
  });

  it("[FD-MDL-070] reuses the assumed credentials across calls, and assumes the role again once they are within 5 min of expiry", async () => {
    const { env } = await plane({ [EXECUTION]: 1 }, { ...BEDROCK_ENV, AI: undefined });
    const lasting = aws();
    for (let i = 0; i < 3; i++)
      expect((await call(env, await token(), { fetch: lasting.fetch })).status).toBe(200);
    expect(lasting.calls.map((c) => c.service)).toEqual(["sts", "bedrock", "bedrock", "bedrock"]);
    const expiring = aws({ expiresInMs: 4 * 60_000 });
    for (let i = 0; i < 2; i++)
      expect((await call(env, await token(), { fetch: expiring.fetch })).status).toBe(200);
    expect(expiring.calls.map((c) => c.service)).toEqual(["sts", "bedrock", "sts", "bedrock"]);
  });

  it("[FD-MDL-070] answers unavailable and sends no InvokeModel when STS refuses the AssumeRole, and rate_limited when Bedrock throttles", async () => {
    const { env } = await plane({ [EXECUTION]: 1 }, { ...BEDROCK_ENV, AI: undefined });
    const denied = aws({ stsStatus: 403 });
    expect(await call(env, await token(), { fetch: denied.fetch })).toMatchObject({
      status: 503,
      body: { error: "unavailable" },
    });
    expect(denied.calls.map((c) => c.service)).toEqual(["sts"]);
    // A refusal keeps nothing: the next call assumes the role again.
    expect((await call(env, await token(), { fetch: denied.fetch })).status).toBe(503);
    expect(denied.calls.map((c) => c.service)).toEqual(["sts", "sts"]);
    const throttled = aws({ bedrockStatus: 429 });
    expect(await call(env, await token(), { fetch: throttled.fetch })).toMatchObject({
      status: 429,
      body: { error: "rate_limited" },
    });
  });

  it("[FD-MDL-070] a deploy without the region, the role or either base secret holds no bedrock route and reaches no AWS host", async () => {
    for (const unset of [
      "MODEL_BEDROCK_REGION",
      "MODEL_BEDROCK_ROLE_ARN",
      "BEDROCK_ACCESS_KEY_ID",
      "BEDROCK_SECRET_ACCESS_KEY",
    ] as const) {
      const { env } = await plane(
        { [EXECUTION]: 1 },
        { ...BEDROCK_ENV, AI: undefined, [unset]: "" },
      );
      const fake = aws();
      expect(await call(env, await token(), { fetch: fake.fetch }), unset).toMatchObject({
        status: 503,
        body: {
          error: "unavailable",
          message: "no model entry this deploy routes serves judgment",
        },
      });
      expect(fake.calls, unset).toEqual([]);
    }
  });
});
