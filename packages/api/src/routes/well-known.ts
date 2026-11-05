// `/.well-known/openid-configuration`, `/.well-known/jwks.json` and `/health`. The OIDC routes are cached for an hour,
// answer `not_configured` while no OIDC key is set (FD-IFC-051), and never serve a private key member (FD-IFC-052).
import { Effect } from "effect";
import { HttpServerResponse } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import { ApiConfig } from "../config.ts";
import { FlareDispatchApi } from "../declaration.ts";
import { apiError } from "../errors.ts";
import { OidcKey } from "../ports.ts";

const CACHE = { "cache-control": "max-age=3600" };

/** The public members of an RSA or EC JWK; every private member (`d`, the CRT primes, `k`) is left out. */
const PUBLIC_MEMBERS = ["kty", "kid", "alg", "use", "n", "e", "crv", "x", "y"] as const;

export const publicOnly = (jwk: Readonly<Record<string, unknown>>): Record<string, unknown> =>
  Object.fromEntries(PUBLIC_MEMBERS.flatMap((m) => (jwk[m] === undefined ? [] : [[m, jwk[m]]])));

const publicKey = Effect.gen(function* () {
  const oidc = yield* OidcKey;
  const jwk = yield* oidc.publicJwk;
  if (jwk === undefined)
    return yield* apiError("not_configured", "this deployment has no OIDC key");
  return publicOnly(jwk);
});

export const WellKnownHandlers = HttpApiBuilder.group(FlareDispatchApi, "wellKnown", (handlers) =>
  handlers
    .handle("openidConfiguration", () =>
      Effect.gen(function* () {
        yield* publicKey;
        const { publicOrigin } = yield* ApiConfig;
        return HttpServerResponse.jsonUnsafe(
          {
            issuer: publicOrigin,
            jwks_uri: `${publicOrigin}/.well-known/jwks.json`,
            response_types_supported: ["id_token"],
            subject_types_supported: ["public"],
            id_token_signing_alg_values_supported: ["RS256"],
            claims_supported: [
              "sub",
              "aud",
              "exp",
              "iat",
              "iss",
              "repository",
              "run",
              "execution_id",
            ],
          },
          { headers: CACHE },
        );
      }),
    )
    .handle("jwks", () =>
      Effect.map(publicKey, (key) =>
        HttpServerResponse.jsonUnsafe({ keys: [key] }, { headers: CACHE }),
      ),
    )
    .handle("health", () => Effect.succeed({ status: "ok" as const })),
);
