// Tests for the OIDC issuer routes.
//
//   GET /.well-known/openid-configuration   — discovery metadata
//   GET /.well-known/jwks.json              — public signing key set
//
// Both are public + unauthenticated by design (IdPs fetch them). Tests cover
// the configured + degraded paths.

import { describe, expect, it } from "vitest";
import type { Env } from "../env";
import { handleRequest } from "../router";

const ISSUER = "https://flare-dispatch.example.com";
const HMAC_SECRET = "unused-but-required";

const minimalEnv = (
  overrides: Partial<Pick<Env, "OIDC_SIGNING_JWK" | "OIDC_ISSUER_URL">> = {},
): Env =>
  ({
    HMAC_SECRET,
    RUNS_WORKFLOW: {} as Env["RUNS_WORKFLOW"],
    RUNS_STORAGE: {} as Env["RUNS_STORAGE"],
    RUNS_SANDBOX: {} as Env["RUNS_SANDBOX"],
    RUNS_METADATA: {} as Env["RUNS_METADATA"],
    ...overrides,
  }) satisfies Env;

const wellKnownRequest = (path: string): Request =>
  new Request(`https://dispatcher.example/.well-known/${path}`);

const freshJwk = async (): Promise<string> => {
  const pair = (await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  (jwk as JsonWebKey & { kid?: string }).kid = "test-kid-1";
  return JSON.stringify(jwk);
};

describe("GET /.well-known/openid-configuration", () => {
  it("with OIDC_ISSUER_URL set → 200 + discovery doc", async () => {
    const env = minimalEnv({ OIDC_ISSUER_URL: ISSUER });
    const res = await handleRequest(
      wellKnownRequest("openid-configuration"),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.issuer).toBe(ISSUER);
    expect(body.jwks_uri).toBe(`${ISSUER}/.well-known/jwks.json`);
    expect(body.id_token_signing_alg_values_supported).toEqual(["ES256"]);
  });

  it("strips trailing slashes from the configured issuer", async () => {
    const env = minimalEnv({ OIDC_ISSUER_URL: `${ISSUER}//` });
    const res = await handleRequest(
      wellKnownRequest("openid-configuration"),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { issuer: string; jwks_uri: string };
    expect(body.issuer).toBe(ISSUER);
    expect(body.jwks_uri).toBe(`${ISSUER}/.well-known/jwks.json`);
  });

  it("without OIDC_ISSUER_URL → 503 oidc_not_configured", async () => {
    const env = minimalEnv();
    const res = await handleRequest(
      wellKnownRequest("openid-configuration"),
      env,
    );
    expect(res.status).toBe(503);
  });
});

describe("GET /.well-known/jwks.json", () => {
  it("with OIDC_SIGNING_JWK set → 200 + public-only JWK", async () => {
    const jwk = await freshJwk();
    const env = minimalEnv({ OIDC_SIGNING_JWK: jwk });
    const res = await handleRequest(wellKnownRequest("jwks.json"), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      keys: Array<JsonWebKey & { kid?: string; d?: string }>;
    };
    expect(body.keys).toHaveLength(1);
    const k = body.keys[0]!;
    expect(k.kty).toBe("EC");
    expect(k.crv).toBe("P-256");
    expect(k.use).toBe("sig");
    expect(k.alg).toBe("ES256");
    expect(k.kid).toBe("test-kid-1");
    expect(k.d).toBeUndefined();
  });

  it("without OIDC_SIGNING_JWK → 503 oidc_not_configured", async () => {
    const env = minimalEnv();
    const res = await handleRequest(wellKnownRequest("jwks.json"), env);
    expect(res.status).toBe(503);
  });

  it("malformed signing JWK → 500 oidc_key_malformed", async () => {
    const env = minimalEnv({ OIDC_SIGNING_JWK: "not json at all" });
    const res = await handleRequest(wellKnownRequest("jwks.json"), env);
    expect(res.status).toBe(500);
  });
});
