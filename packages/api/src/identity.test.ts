import { Context, Effect } from "effect";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  accessClaims,
  actionsClaims,
  baseConfig,
  DISPATCHER,
  makeHarness,
  makeSigner,
  MEMBER,
  now,
  OPERATOR,
  ORIGIN,
  portsContext,
  type Harness,
} from "./api.test-support.ts";
import { ApiConfig, apiConfigFromEnv, ConfigInvalid, distinctLinkKey } from "./config.ts";
import { constantTimeEqual } from "./crypto.ts";
import { declaredGroups } from "./groups.ts";
import { signBody, verifyBody } from "./hmac.ts";
import { ACTIONS_JWKS } from "./identity.ts";
import { JWKS_TTL_MS, JwksSourceLive } from "./jwt.ts";
import { checkLinkToken, LINK_LABELS, mintLinkToken } from "./link-token.ts";
import { executionLinks, type LinkAudience } from "./links.ts";
import { mount, toFetchHandler } from "./router.ts";

let h: Harness;
beforeAll(async () => {
  h = await makeHarness();
});

const withJwt = (jwt: string, init: RequestInit = {}): RequestInit => ({
  ...init,
  headers: { ...(init.headers as Record<string, string>), "cf-access-jwt-assertion": jwt },
});
const body = async (response: Response) => (await response.json()) as Record<string, unknown>;

describe("Access gate", () => {
  it("[FD-IFC-010], [FD-IFC-013]: a gated route with no Access JWT answers 401 unauthenticated", async () => {
    const response = await h.fetch("/v1/executions");
    expect(response.status).toBe(401);
    expect((await body(response))["error"]).toBe("unauthenticated");
  });

  it("[FD-IFC-013]: a browser with no identity on a link route is redirected to the Access login", async () => {
    // The router redirects only on surfaces that ask for it; executions are API routes, so they answer 401.
    const response = await h.fetch("/v1/executions", { headers: { accept: "text/html" } });
    expect(response.status).toBe(401);
  });

  it("[FD-IFC-011]: a valid RS256 token of the team and audience passes, from the header or the cookie", async () => {
    expect((await h.fetch("/v1/executions", await h.asAccess(MEMBER))).status).toBe(200);
    const jwt = await h.access.sign(accessClaims(MEMBER));
    const cookie = await h.fetch("/v1/executions", {
      headers: { cookie: `a=b; CF_Authorization=${jwt}` },
    });
    expect(cookie.status).toBe(200);
  });

  it("[FD-IFC-011], [FD-IFC-012]: a wrong issuer, audience, algorithm, kid or an expiry past the skew answers 403", async () => {
    const cases = [
      await h.access.sign(accessClaims(MEMBER, { iss: "https://other.example.com" })),
      await h.access.sign(accessClaims(MEMBER, { aud: ["other"] })),
      await h.access.sign(accessClaims(MEMBER), { alg: "HS256" }),
      await h.access.sign(accessClaims(MEMBER), { kid: "unknown" }),
      await h.access.sign(accessClaims(MEMBER, { exp: now() - 61 })),
      await h.access.sign(accessClaims(MEMBER, { nbf: now() + 120 })),
    ];
    for (const jwt of cases) {
      const response = await h.fetch("/v1/executions", withJwt(jwt));
      expect(response.status).toBe(403);
      expect((await body(response))["error"]).toBe("forbidden");
    }
  });

  it("[FD-IFC-011]: an expiry within the 60 s skew still passes", async () => {
    const jwt = await h.access.sign(accessClaims(MEMBER, { exp: now() - 30 }));
    expect((await h.fetch("/v1/executions", withJwt(jwt))).status).toBe(200);
  });

  it("[FD-IFC-012]: a malformed token or a forged signature answers 403, never 500", async () => {
    const other = await makeSigner("access-kid");
    const forged = await other.sign(accessClaims(MEMBER));
    for (const jwt of ["not-a-jwt", "a.b.c", "x.y.%%%", forged, "eyJhbGciOiJSUzI1NiJ9.e30.@@@"]) {
      const response = await h.fetch("/v1/executions", withJwt(jwt));
      expect(response.status).toBe(403);
    }
  });

  it("[FD-IFC-014], [FD-IFC-015]: with no Access team domain or audience every gated route answers 503 not_configured", async () => {
    const config = baseConfig({ access: undefined });
    for (const path of ["/v1/executions", "/v1/ops/health", "/v1/anything"]) {
      const response = await h.fetch(path, { ...(await h.asAccess(OPERATOR)), config });
      expect(response.status).toBe(503);
      expect((await body(response))["error"]).toBe("not_configured");
    }
  });

  it("[FD-IFC-014]: the overlay values come from the Worker's bindings, and an absent value disables Access", () => {
    const config = apiConfigFromEnv(
      { ACCESS_TEAM_DOMAIN: "t.example.com", OPERATORS: '["Ops@Example.com"]' },
      "https://x",
    );
    expect(config).not.toBeInstanceOf(ConfigInvalid);
    expect((config as { access: unknown }).access).toBeUndefined();
    expect((config as unknown as { operators: string[] }).operators).toEqual(["ops@example.com"]);
    expect(apiConfigFromEnv({ OPERATORS: "ops@example.com" }, "https://x")).toBeInstanceOf(
      ConfigInvalid,
    );
  });

  it("[FD-IFC-016]: an identity outside operators answers 403 on /v1/ops/*", async () => {
    const response = await h.fetch("/v1/ops/health", await h.asAccess(MEMBER));
    expect(response.status).toBe(403);
    expect((await body(response))["error"]).toBe("forbidden");
    expect((await h.fetch("/v1/ops/health", await h.asAccess(OPERATOR))).status).toBe(200);
  });

  it("[FD-IFC-016], [FD-IFC-027]: a valid service-token JWT grants only the operator or dispatcher role its common name is listed under", async () => {
    const operator = "operator-ci.access";
    const dispatcher = "dispatcher-ci.access";
    const config = baseConfig({ operators: [operator], dispatchers: [dispatcher] });
    const before = h.doubles.calls.submissions.length;
    for (const commonName of [operator, dispatcher, "unlisted-ci.access"]) {
      const jwt = await h.access.sign(
        accessClaims("", { email: undefined, common_name: commonName }),
      );
      expect((await h.fetch("/v1/executions", { ...withJwt(jwt), config })).status).toBe(200);
      expect((await h.fetch("/v1/ops/health", { ...withJwt(jwt), config })).status).toBe(
        commonName === operator ? 200 : 403,
      );
      const dispatched = await h.fetch("/v1/dispatch/check", {
        ...withJwt(jwt, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ repository: "acme/widgets", inputs: {} }),
        }),
        config,
      });
      expect(dispatched.status).toBe(commonName === dispatcher ? 202 : 401);
    }
    expect(h.doubles.calls.submissions.length).toBe(before + 1);
  });

  it("[FD-IFC-088]: an identity outside operators answers 403 on executor registration", async () => {
    const init = {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        executor_id: "dev-1",
        labels: [],
        protocol_version: "1",
        code_hash: null,
        identity: { public_key: "k", key_store: "software", certificate_chain: [], evidence: null },
      }),
    };
    expect((await h.fetch("/v1/executors/register", await h.asAccess(MEMBER, init))).status).toBe(
      403,
    );
    const ok = await h.fetch("/v1/executors/register", await h.asAccess(OPERATOR, init));
    expect(ok.status).toBe(201);
    expect(await body(ok)).toEqual({ executor_id: "dev-1", posture_tier: "unmanaged" });
  });
});

describe("dispatch identity", () => {
  const dispatchInit = (
    headers: Record<string, string>,
    repository = "acme/widgets",
  ): RequestInit => ({
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ repository, inputs: {} }),
  });

  it("[FD-IFC-027], [FD-INT-034]: no token, or an Access identity outside dispatchers, answers 401 before the run is looked up", async () => {
    const before = h.doubles.calls.submissions.length;
    expect((await h.fetch("/v1/dispatch/no-such-run", dispatchInit({}))).status).toBe(401);
    const member = await h.fetch("/v1/dispatch/check", await h.asAccess(MEMBER, dispatchInit({})));
    expect(member.status).toBe(401);
    expect(h.doubles.calls.submissions.length).toBe(before);
  });

  it("[FD-IFC-027]: an Access identity in dispatchers may dispatch", async () => {
    const response = await h.fetch(
      "/v1/dispatch/check",
      await h.asAccess(DISPATCHER, dispatchInit({})),
    );
    expect(response.status).toBe(202);
  });

  it("[FD-IFC-024]: an Actions token needs GitHub's issuer, the overlay audience and a key from GitHub's JWKS", async () => {
    const good = await h.actions.sign(actionsClaims("acme/widgets"));
    expect(
      (await h.fetch("/v1/dispatch/check", dispatchInit({ authorization: `Bearer ${good}` })))
        .status,
    ).toBe(202);
    for (const jwt of [
      await h.actions.sign(actionsClaims("acme/widgets", { aud: "other" })),
      await h.actions.sign(actionsClaims("acme/widgets", { iss: "https://example.com" })),
      await h.access.sign(actionsClaims("acme/widgets")),
    ]) {
      const response = await h.fetch(
        "/v1/dispatch/check",
        dispatchInit({ authorization: `Bearer ${jwt}` }),
      );
      expect(response.status).toBe(401);
    }
  });

  it("[FD-INT-035]: an Actions token passes only with GitHub's issuer, the audience, an unexpired exp and an RS256 signature from the issuer's JWKS", async () => {
    const before = h.doubles.calls.submissions.length;
    const forger = await makeSigner(h.actions.kid);
    for (const jwt of [
      await h.actions.sign(actionsClaims("acme/widgets", { iss: "https://example.com" })),
      await h.actions.sign(actionsClaims("acme/widgets", { aud: "https://other.example.com" })),
      // Expired beyond the 60 s skew, or carrying no `exp` at all.
      await h.actions.sign(actionsClaims("acme/widgets", { exp: now() - 120 })),
      await h.actions.sign(actionsClaims("acme/widgets", { exp: undefined })),
      // A header naming another algorithm over the same RS256 signature.
      await h.actions.sign(actionsClaims("acme/widgets"), { alg: "RS512" }),
      // The issuer's kid, signed by a key outside its JWKS.
      await forger.sign(actionsClaims("acme/widgets")),
    ]) {
      const response = await h.fetch(
        "/v1/dispatch/check",
        dispatchInit({ authorization: `Bearer ${jwt}` }),
      );
      expect(response.status).toBe(401);
      expect((await body(response))["error"]).toBe("unauthenticated");
    }
    expect(h.doubles.calls.submissions.length).toBe(before);
    const valid = await h.actions.sign(actionsClaims("acme/widgets"));
    const accepted = await h.fetch(
      "/v1/dispatch/check",
      dispatchInit({ authorization: `Bearer ${valid}` }),
    );
    expect(accepted.status).toBe(202);
  });

  it("[FD-IFC-025]: an Actions dispatch takes its repository, ref and workflow ref from the token", async () => {
    const jwt = await h.actions.sign(actionsClaims("Acme/Widgets", { ref: "refs/heads/feature" }));
    await h.fetch(
      "/v1/dispatch/check",
      dispatchInit({ authorization: `Bearer ${jwt}` }, "acme/widgets"),
    );
    const last = h.doubles.calls.submissions.at(-1)!;
    expect(last.repository).toBe("Acme/Widgets");
    expect(last.ref).toBe("refs/heads/feature");
    expect(last.workflowRef).toBe("Acme/Widgets/.github/workflows/ci.yml@refs/heads/main");
    expect(last.caller).toBe(
      "actions:Acme/Widgets:Acme/Widgets/.github/workflows/ci.yml@refs/heads/main",
    );
  });

  it("[FD-IFC-026], [FD-INT-036]: a body naming another repository than the token answers 403 repository_mismatch", async () => {
    const jwt = await h.actions.sign(actionsClaims("acme/widgets"));
    const response = await h.fetch(
      "/v1/dispatch/check",
      dispatchInit({ authorization: `Bearer ${jwt}` }, "acme/other"),
    );
    expect(response.status).toBe(403);
    expect((await body(response))["error"]).toBe("repository_mismatch");
  });

  it("[FD-INT-035]: the live JWKS source fetches GitHub's keys once per hour, and again once the hour has passed", async () => {
    const started = Date.parse("2026-01-01T00:00:00Z");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(started);
    const fetched: string[] = [];
    vi.stubGlobal("fetch", async (input: Request | string | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      fetched.push(url);
      return Response.json({ keys: [h.actions.jwk] });
    });
    try {
      const handler = toFetchHandler(mount(...declaredGroups), { shared: JwksSourceLive });
      const dispatch = async () => {
        const jwt = await h.actions.sign(actionsClaims("acme/widgets"));
        const services = portsContext(h.doubles).pipe(Context.add(ApiConfig, baseConfig()));
        const request = new Request(
          `${ORIGIN}/v1/dispatch/check`,
          dispatchInit({ authorization: `Bearer ${jwt}` }),
        );
        return (await handler.fetch(request, services as never)).status;
      };
      expect(await dispatch()).toBe(202);
      vi.setSystemTime(started + JWKS_TTL_MS - 1_000);
      expect(await dispatch()).toBe(202);
      expect(fetched).toEqual([ACTIONS_JWKS]);
      vi.setSystemTime(started + JWKS_TTL_MS + 1_000);
      expect(await dispatch()).toBe(202);
      expect(fetched).toEqual([ACTIONS_JWKS, ACTIONS_JWKS]);
      await handler.dispose();
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it("[FD-IFC-024]: with no OIDC audience configured an Actions dispatch answers 503 not_configured", async () => {
    const jwt = await h.actions.sign(actionsClaims("acme/widgets"));
    const response = await h.fetch("/v1/dispatch/check", {
      ...dispatchInit({ authorization: `Bearer ${jwt}` }),
      config: baseConfig({ oidcAudience: undefined }),
    });
    expect(response.status).toBe(503);
  });
});

describe("link tokens", () => {
  const key = "link-key-for-tests";
  const grant = { purpose: "logs" as const, objectId: "exec-1", expiresAtS: now() + 600, epoch: 3 };
  const check = (token: string, overrides: Partial<Parameters<typeof checkLinkToken>[2]> = {}) =>
    checkLinkToken(key, token, {
      purpose: "logs",
      objectId: "exec-1",
      nowS: now(),
      currentEpoch: 3,
      ...overrides,
    });

  it("[FD-IFC-018]: a token binds the purpose, the object, the expiry and the epoch, with at least 128 bits of MAC", async () => {
    const token = await mintLinkToken(key, grant);
    const mac = token.split(".")[2]!;
    expect(mac.length).toBeGreaterThanOrEqual(22);
    expect((await check(token))._tag).toBe("Granted");
    expect((await check(token, { objectId: "exec-2" }))._tag).toBe("Invalid");
    expect((await check(token, { purpose: "artifact" }))._tag).toBe("Invalid");
    const edited = token.replace(/^\d+/, String(grant.expiresAtS + 999));
    expect((await check(edited))._tag).toBe("Invalid");
    expect(new Set(Object.values(LINK_LABELS)).size).toBe(Object.keys(LINK_LABELS).length);
  });

  it("[FD-IFC-020]: a token past its expiry is expired", async () => {
    const token = await mintLinkToken(key, { ...grant, expiresAtS: now() - 1 });
    expect((await check(token))._tag).toBe("Expired");
  });

  it("[FD-IFC-021]: a token below the current link epoch is revoked", async () => {
    const token = await mintLinkToken(key, { ...grant, epoch: 2 });
    expect((await check(token))._tag).toBe("Revoked");
  });

  it("[FD-IFC-019]: a details link lasts the configured lifetime, 24 h by default and at most 7 days", () => {
    expect((apiConfigFromEnv({}, "https://x") as { linkLifetimeS: number }).linkLifetimeS).toBe(
      86_400,
    );
    expect(apiConfigFromEnv({ LINK_LIFETIME_S: "604801" }, "https://x")).toBeInstanceOf(
      ConfigInvalid,
    );
    expect(
      (apiConfigFromEnv({ LINK_LIFETIME_S: "604800" }, "https://x") as { linkLifetimeS: number })
        .linkLifetimeS,
    ).toBe(604_800);
  });

  it("[FD-IFC-019]: a check-run details token expires after the configured lifetime, a dashboard token within 3600 s", async () => {
    const nowS = 1_800_000_000;
    const expiryOf = async (audience: LinkAudience, linkLifetimeS: number) => {
      const links = await Effect.runPromise(
        executionLinks("exec-1", audience, nowS).pipe(
          Effect.provideService(ApiConfig, baseConfig({ linkLifetimeS })),
        ),
      );
      const token = new URL(links.details_url).searchParams.get("t")!;
      expect(new URL(links.logs_url).searchParams.get("t")).toBe(token);
      expect((await check(token, { nowS, currentEpoch: 0 }))._tag).toBe("Granted");
      return Number(token.split(".")[0]) - nowS;
    };
    expect(await expiryOf("check-run", 86_400)).toBe(86_400);
    expect(await expiryOf("check-run", 7_200)).toBe(7_200);
    expect(await expiryOf("check-run", 604_800)).toBe(604_800);
    expect(await expiryOf("dashboard", 86_400)).toBe(3_600);
    expect(await expiryOf("dashboard", 600)).toBe(600);
  });

  it("[FD-IFC-022]: token and MAC comparisons run through the constant-time compare", async () => {
    expect(await constantTimeEqual("abc", "abc")).toBe(true);
    expect(await constantTimeEqual("abc", "abd")).toBe(false);
    expect(await constantTimeEqual("abc", "abcd")).toBe(false);
    expect(await constantTimeEqual("", "")).toBe(false);
    const signature = await signBody("secret", new TextEncoder().encode("{}"));
    expect(await verifyBody("secret", signature, new TextEncoder().encode("{}"))).toBe(true);
    expect(await verifyBody("secret", signature, new TextEncoder().encode("{ }"))).toBe(false);
    expect(await verifyBody("secret", "sha256=00", new TextEncoder().encode("{}"))).toBe(false);
  });

  it("[FD-IFC-023]: a link key equal to the webhook secret, the OIDC key or the provenance key is refused", () => {
    expect(distinctLinkKey({ LINK_KEY: "k", WEBHOOK_SECRET: "k" })).toBeInstanceOf(ConfigInvalid);
    expect(distinctLinkKey({ LINK_KEY: "k", OIDC_SIGNING_JWK: "k" })).toBeInstanceOf(ConfigInvalid);
    expect(distinctLinkKey({ LINK_KEY: "k", PROVENANCE_KEY: "k" })).toBeInstanceOf(ConfigInvalid);
    expect(distinctLinkKey({ LINK_KEY: "k", WEBHOOK_SECRET: "w" })).toBeUndefined();
  });

  it("[FD-IFC-023]: a link key equal to the compile-cache secret or the install-state key is refused at configuration", () => {
    for (const name of ["COMPILE_CACHE_SECRET", "INSTALL_STATE_KEY"] as const) {
      const refused = apiConfigFromEnv({ LINK_KEY: "k", [name]: "k" }, ORIGIN);
      expect(refused, name).toBeInstanceOf(ConfigInvalid);
      expect((refused as ConfigInvalid).message).toBe(`the link key equals ${name}`);
      expect(
        (apiConfigFromEnv({ LINK_KEY: "k", [name]: "other" }, ORIGIN) as { linkKey: string })
          .linkKey,
      ).toBe("k");
    }
  });
});
