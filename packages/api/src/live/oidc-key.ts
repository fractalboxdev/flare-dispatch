// The control plane's OIDC key set from the `OIDC_SIGNING_JWK` Worker secret: one private ES256 JWK, or after a
// rotation the current key and the retired ones (FD-PROV-049). The well-known route serves only public members
// (FD-IFC-052).
import { parseOidcKeys } from "@fractalboxdev/flare-dispatch-cache/oidc";
import { Effect, Layer } from "effect";
import { OidcKey } from "../ports.ts";

export const oidcKeyFromSecret = (secret: string | undefined): Layer.Layer<OidcKey> =>
  Layer.succeed(OidcKey)({ keys: Effect.succeed(parseOidcKeys(secret)) });
