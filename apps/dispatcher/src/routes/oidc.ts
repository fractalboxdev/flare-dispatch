// FlareDispatch Dispatcher — OIDC issuer endpoints.
//
//   GET /.well-known/openid-configuration   — discovery metadata
//   GET /.well-known/jwks.json              — public signing key set
//
// Both are **public and unauthenticated** by design: IdPs (AWS STS, GCP STS,
// Vault) fetch the JWKS to verify token signatures, and the discovery
// document points them at it. A deploy without `OIDC_SIGNING_JWK` /
// `OIDC_ISSUER_URL` returns 503 so the IdP rejection is loud rather than
// silent.
//
// Spec: specs/01-architecture.md § Dispatcher Worker (OIDC issuer row),
//       specs/03-dsl.md § oidc, specs/05-byoc.md § AWS federation trust policy.

import type { Env } from "../env";

/**
 * Public-only JWK derived from the deploy's signing JWK. Strips the private
 * `d` component, pins `use: "sig"` + `alg: "ES256"`. Inlined here (instead
 * of imported from @fractalbox/flare-dispatch-runtime-cf) so the router doesn't drag
 * in @cloudflare/containers via the runtime-cf barrel.
 */
const publicJwkFromSigning = (jwkJson: string): JsonWebKey => {
  const parsed: unknown = JSON.parse(jwkJson);
  if (parsed === null || typeof parsed !== "object") {
    throw new Error("OIDC_SIGNING_JWK is not a JSON object");
  }
  const j = parsed as JsonWebKey & {
    crv?: unknown;
    x?: unknown;
    y?: unknown;
    d?: unknown;
    kid?: unknown;
  };
  if (j.kty !== "EC" || j.crv !== "P-256") {
    throw new Error("OIDC_SIGNING_JWK must be a P-256 EC key");
  }
  if (typeof j.x !== "string" || typeof j.y !== "string") {
    throw new Error("OIDC_SIGNING_JWK is missing x/y coordinates");
  }
  return {
    kty: "EC",
    crv: "P-256",
    x: j.x,
    y: j.y,
    use: "sig",
    alg: "ES256",
    ...(typeof j.kid === "string" ? { kid: j.kid } : {}),
  };
};

const json = (body: unknown, status: number, extraHeaders: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "public, max-age=3600",
      ...extraHeaders,
    },
  });

const trimmedIssuer = (env: Env): string | undefined => {
  const raw = env.OIDC_ISSUER_URL;
  if (typeof raw !== "string" || raw.length === 0) return undefined;
  return raw.replace(/\/+$/, ""); // strip trailing slashes — issuer has none
};

/** Handle `GET /.well-known/openid-configuration`. */
export const handleOidcDiscovery = (env: Env): Response => {
  const issuer = trimmedIssuer(env);
  if (issuer === undefined) {
    return json(
      {
        error: "oidc_not_configured",
        message: "OIDC_ISSUER_URL is unset; the issuer is off on this deploy",
      },
      503,
    );
  }
  return json(
    {
      issuer,
      jwks_uri: `${issuer}/.well-known/jwks.json`,
      // Minimal OIDC discovery — the fields IdPs actually consult for the
      // workload-identity-federation use case. No `authorization_endpoint`
      // / `token_endpoint`: we don't speak the full OIDC handshake, we just
      // *issue* the tokens runs sign with.
      response_types_supported: ["id_token"],
      id_token_signing_alg_values_supported: ["ES256"],
      subject_types_supported: ["public"],
      claims_supported: ["iss", "sub", "aud", "iat", "exp", "jti"],
    },
    200,
  );
};

/** Handle `GET /.well-known/jwks.json`. */
export const handleOidcJwks = (env: Env): Response => {
  if (env.OIDC_SIGNING_JWK === undefined || env.OIDC_SIGNING_JWK.length === 0) {
    return json(
      {
        error: "oidc_not_configured",
        message:
          "OIDC_SIGNING_JWK is unset; JWKS endpoint is off on this deploy",
      },
      503,
    );
  }
  try {
    const publicJwk = publicJwkFromSigning(env.OIDC_SIGNING_JWK);
    return json({ keys: [publicJwk] }, 200);
  } catch (cause) {
    return json(
      {
        error: "oidc_key_malformed",
        message: cause instanceof Error ? cause.message : String(cause),
      },
      500,
    );
  }
};
