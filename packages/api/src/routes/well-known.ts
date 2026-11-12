// `/.well-known/openid-configuration`, `/.well-known/jwks.json`, `/.well-known/flare-dispatch/provenance-policy.json`
// and `/health`. The OIDC routes are cached for an hour, answer `not_configured` while no OIDC key is set (FD-IFC-051),
// and never serve a private key member (FD-IFC-052). The JWKS holds the current ES256 key and every key retired by
// rotation within the last 3600 s (FD-PROV-049). The policy route serves the current verification policy, or with
// `?policy_version=` an earlier version (FD-PROV-044), and only a version already in the transparency log
// (FD-PROV-046).
import { jwks } from "@fractalboxdev/flare-dispatch-cache/oidc";
import { Clock, Effect } from "effect";
import { HttpServerResponse } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import { ApiConfig } from "../config.ts";
import { FlareDispatchApi } from "../declaration.ts";
import { apiError } from "../errors.ts";
import { OidcKey, ProvenancePolicies } from "../ports.ts";

const CACHE = { "cache-control": "max-age=3600" };

/** The public keys the JWKS serves now; each carries only `kty`, `crv`, `x`, `y`, `kid`, `use` and `alg`. */
const servedKeys = Effect.gen(function* () {
  const oidc = yield* OidcKey;
  const keys = yield* oidc.keys;
  if (keys === undefined)
    return yield* apiError("not_configured", "this deployment has no OIDC key");
  return jwks(keys, yield* Clock.currentTimeMillis).keys;
});

export const WellKnownHandlers = HttpApiBuilder.group(FlareDispatchApi, "wellKnown", (handlers) =>
  handlers
    .handle("openidConfiguration", () =>
      Effect.gen(function* () {
        yield* servedKeys;
        const { publicOrigin } = yield* ApiConfig;
        return HttpServerResponse.jsonUnsafe(
          {
            issuer: publicOrigin,
            jwks_uri: `${publicOrigin}/.well-known/jwks.json`,
            response_types_supported: ["id_token"],
            subject_types_supported: ["public"],
            id_token_signing_alg_values_supported: ["ES256"],
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
      Effect.map(servedKeys, (keys) => HttpServerResponse.jsonUnsafe({ keys }, { headers: CACHE })),
    )
    .handle("provenancePolicy", ({ query }) =>
      Effect.flatMap(ProvenancePolicies, (policies) => policies.served(query.policy_version)),
    )
    .handle("health", () => Effect.succeed({ status: "ok" as const })),
);
